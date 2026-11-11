import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DOWNLOAD_SCHEDULE } from './downloadSchedule'
import {
  describeStartAt,
  HELD_NOTE,
  missedStartNote,
  nextStartAt,
  nextStartCheck,
  parseWhen,
  START_AT_MAX_AHEAD_MS,
  START_CHECK_MAX_MS,
  startAtAction,
  startAtScheduleNote,
  startDay,
  startTime
} from './startAt'

// Local times throughout, as the time field and the schedule use: 12 Nov 2026, 22:30.
const NOW = new Date(2026, 10, 12, 22, 30).getTime()
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 10, day, hour, minute).getTime()
const time = (value: number): string =>
  new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('nextStartAt', () => {
  it('is today while the time is still to come, and tomorrow once it has passed', () => {
    expect(nextStartAt('23:15')).toBe(at(12, 23, 15))
    expect(nextStartAt('01:00')).toBe(at(13, 1))
    // The time it is now has passed: a minute from now is the soonest the field can say.
    expect(nextStartAt('22:30')).toBe(at(13, 22, 30))
    expect(nextStartAt('22:31', NOW)).toBe(at(12, 22, 31))
  })

  it('is null for anything that isn’t a time', () => {
    for (const value of ['', '1:00', '24:00', '12:60', 'noon', '12:00:00']) {
      expect(nextStartAt(value)).toBeNull()
    }
  })
})

describe('parseWhen', () => {
  it('starts now when there is no When, or its time has already come', () => {
    expect(parseWhen(undefined)).toBeUndefined()
    expect(parseWhen(null)).toBeUndefined()
    expect(parseWhen({ kind: 'at', at: NOW })).toBeUndefined()
    expect(parseWhen({ kind: 'at', at: NOW - 60_000 })).toBeUndefined()
  })

  it('takes the queue, and a time to come within a week', () => {
    expect(parseWhen({ kind: 'queue' })).toEqual({ kind: 'queue' })
    expect(parseWhen({ kind: 'at', at: NOW + 1000 })).toEqual({ kind: 'at', at: NOW + 1000 })
    expect(parseWhen({ kind: 'at', at: NOW + START_AT_MAX_AHEAD_MS }, NOW)).toEqual({
      kind: 'at',
      at: NOW + START_AT_MAX_AHEAD_MS
    })
  })

  it('refuses anything else rather than guess', () => {
    for (const value of [
      { kind: 'later' },
      { kind: 'at' },
      { kind: 'at', at: '01:00' },
      { kind: 'at', at: Number.NaN },
      { kind: 'at', at: Number.POSITIVE_INFINITY },
      { kind: 'at', at: NOW + START_AT_MAX_AHEAD_MS + 1 },
      'now',
      7
    ]) {
      expect(() => parseWhen(value)).toThrow('That start time can’t be used.')
    }
  })
})

describe('what a start time is called', () => {
  it('names the day only when it isn’t today', () => {
    expect(startDay(at(12, 23))).toBe('')
    expect(startDay(at(13, 1))).toBe('tomorrow')
    expect(startDay(at(11, 23))).toBe('yesterday')
    expect(startDay(at(15, 9))).toBe(
      new Date(at(15, 9)).toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      })
    )
  })

  it('says the time in the Mac’s own format', () => {
    expect(startTime(at(13, 1))).toBe(time(at(13, 1)))
  })

  it('makes the sheet’s button and the download’s row', () => {
    expect(startAtAction(at(12, 23))).toBe(`Start at ${time(at(12, 23))}`)
    expect(startAtAction(at(13, 1))).toBe(`Start tomorrow at ${time(at(13, 1))}`)
    expect(describeStartAt(at(12, 23))).toBe(`Starts at ${time(at(12, 23))}`)
    expect(describeStartAt(at(13, 1))).toBe(`Starts tomorrow at ${time(at(13, 1))}`)
    expect(describeStartAt(at(15, 9))).toBe(`Starts ${startDay(at(15, 9))} at ${time(at(15, 9))}`)
  })

  it('says when one started late, and when one in the queue gets its turn', () => {
    expect(missedStartNote(at(12, 1))).toBe(
      `Planned to start ${time(at(12, 1))}, while Mergelane was closed. It started when Mergelane opened.`
    )
    expect(missedStartNote(at(11, 23))).toContain(`yesterday at ${time(at(11, 23))}`)
    expect(HELD_NOTE).toBe('Starts when a running download finishes, or when you start it.')
  })
})

describe('startAtScheduleNote', () => {
  // 02:00 to 06:00, every day.
  const schedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true, startMinute: 120, endMinute: 360 }

  it('says nothing without a schedule, or inside its hours', () => {
    expect(startAtScheduleNote(undefined, at(13, 1))).toBeNull()
    expect(startAtScheduleNote({ ...schedule, enabled: false }, at(13, 1))).toBeNull()
    expect(startAtScheduleNote(schedule, at(13, 3))).toBeNull()
  })

  it('says the schedule wins: outside its hours, the download waits for them', () => {
    expect(startAtScheduleNote(schedule, at(13, 1))).toBe(
      `That’s outside your download schedule, so it starts tomorrow at ${time(at(13, 2))}, when the schedule allows.`
    )
  })

  it('says when the schedule has ended', () => {
    expect(startAtScheduleNote({ ...schedule, endDate: '2026-11-12' }, at(13, 1))).toBe(
      'Your download schedule has ended, so it waits until you turn the schedule off.'
    )
  })
})

describe('nextStartCheck', () => {
  it('waits for nothing when no download has a start time', () => {
    expect(nextStartCheck([])).toBeUndefined()
  })

  it('looks at the clock at the earliest time, and at least once a second', () => {
    expect(nextStartCheck([NOW + 300], NOW)).toBe(300)
    expect(nextStartCheck([NOW + 60_000, NOW + 400])).toBe(400)
    expect(nextStartCheck([NOW + 60_000])).toBe(START_CHECK_MAX_MS)
    // One already due is looked at straight away.
    expect(nextStartCheck([NOW - 5000])).toBe(1)
  })
})
