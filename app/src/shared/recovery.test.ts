import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_MAX_MS,
  CHECKPOINT_MS,
  checkpointDelay,
  crashed,
  recoveryMessage,
  recoveryNote,
  sessionFrom,
  type RestoredDownload,
  type SessionRecord
} from './recovery'

const T = 1_800_000_000_000
const MB = 1024 * 1024

const session = (fields: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 1,
  startedAt: T - 60_000,
  cleanExit: false,
  ...fields
})
const restored = (fields: Partial<RestoredDownload> = {}): RestoredDownload => ({
  id: 'a',
  wasDownloading: true,
  savedAt: T - 1_500,
  savedBytes: 10_000,
  ...fields
})

describe('how often progress is saved', () => {
  it('saves every 2 seconds while saves are quick', () => {
    expect(checkpointDelay(0)).toBe(CHECKPOINT_MS)
    expect(checkpointDelay(15)).toBe(CHECKPOINT_MS)
    expect(checkpointDelay(500)).toBe(CHECKPOINT_MS)
  })

  it('waits four times as long as a slow save took, up to 15 seconds', () => {
    expect(checkpointDelay(1_000)).toBe(4_000)
    expect(checkpointDelay(2_500)).toBe(10_000)
    expect(checkpointDelay(60_000)).toBe(CHECKPOINT_MAX_MS)
  })

  it('treats a nonsense duration as a quick save', () => {
    expect(checkpointDelay(-5)).toBe(CHECKPOINT_MS)
    expect(checkpointDelay(Number.NaN)).toBe(CHECKPOINT_MS)
    expect(checkpointDelay(Number.POSITIVE_INFINITY)).toBe(CHECKPOINT_MS)
  })
})

describe('the session record as read back', () => {
  it('keeps a valid record, heartbeat included', () => {
    const record = session({ aliveAt: T, running: { a: 5, b: 0 } })
    expect(sessionFrom(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('keeps a record without a heartbeat', () => {
    expect(sessionFrom({ version: 1, startedAt: T, cleanExit: true })).toEqual({
      version: 1,
      startedAt: T,
      cleanExit: true
    })
  })

  it('drops what it cannot trust', () => {
    expect(sessionFrom(undefined)).toBeUndefined()
    expect(sessionFrom(null)).toBeUndefined()
    expect(sessionFrom('session')).toBeUndefined()
    expect(sessionFrom({ version: 2, startedAt: T, cleanExit: true })).toBeUndefined()
    expect(sessionFrom({ version: 1, startedAt: -1, cleanExit: true })).toBeUndefined()
    expect(sessionFrom({ version: 1, startedAt: T, cleanExit: 'yes' })).toBeUndefined()
  })

  it('drops a bad heartbeat time and bad byte counts, keeping the rest', () => {
    expect(
      sessionFrom({
        version: 1,
        startedAt: T,
        cleanExit: false,
        aliveAt: 'soon',
        running: { a: 7, b: -1, c: 'x', d: Number.NaN }
      })
    ).toEqual({ version: 1, startedAt: T, cleanExit: false, running: { a: 7 } })
  })

  it('ignores a running list that is not an object', () => {
    expect(
      sessionFrom({ version: 1, startedAt: T, cleanExit: false, aliveAt: T, running: null })
    ).toEqual({ version: 1, startedAt: T, cleanExit: false, aliveAt: T })
  })
})

describe('telling a crash from a quit', () => {
  it('trusts the record when there is one', () => {
    expect(crashed(session({ cleanExit: true }), [restored()])).toBe(false)
    expect(crashed(session({ cleanExit: false }), [])).toBe(true)
  })

  it('without a record, a save still saying "downloading" is a crash', () => {
    expect(crashed(undefined, [restored({ wasDownloading: false }), restored()])).toBe(true)
    expect(crashed(undefined, [restored({ wasDownloading: false })])).toBe(false)
    expect(crashed(undefined, [])).toBe(false)
  })
})

describe('the recovery note', () => {
  it('says nothing after a clean quit', () => {
    expect(recoveryNote(session({ cleanExit: true }), [restored()])).toBeUndefined()
    expect(recoveryNote(undefined, [restored({ wasDownloading: false })])).toBeUndefined()
  })

  it('after a crash with nothing downloading, counts none', () => {
    expect(recoveryNote(session(), [restored({ wasDownloading: false })])).toEqual({ count: 0 })
  })

  it('counts the downloads picked up, the bytes fetched again and how long before it quit', () => {
    const previous = session({ aliveAt: T, running: { a: 14_000, b: 9_000, c: 1 } })
    const note = recoveryNote(previous, [
      restored({ id: 'a', savedAt: T - 1_500, savedBytes: 10_000 }),
      restored({ id: 'b', savedAt: T - 400, savedBytes: 8_000 }),
      restored({ id: 'c', wasDownloading: false, savedAt: T - 90_000, savedBytes: 0 })
    ])
    expect(note).toEqual({ count: 2, lostBytes: 5_000, agoMs: 1_500 })
  })

  it('never counts negative bytes when a save got ahead of the last heartbeat', () => {
    const previous = session({ aliveAt: T, running: { a: 9_000 } })
    expect(recoveryNote(previous, [restored({ savedAt: T - 10, savedBytes: 10_000 })])).toEqual({
      count: 1,
      lostBytes: 0,
      agoMs: 10
    })
  })

  it('trusts a heartbeat taken within two beats before the save', () => {
    const previous = session({ aliveAt: T - 2_500, running: { a: 10_500 } })
    expect(recoveryNote(previous, [restored({ savedAt: T - 1_500, savedBytes: 11_000 })])).toEqual({
      count: 1,
      lostBytes: 0,
      agoMs: 0
    })
  })

  it('leaves the numbers out when the heartbeat is missing, stale, or skips one', () => {
    const one = [restored()]
    expect(recoveryNote(session(), one)).toEqual({ count: 1 })
    expect(recoveryNote(undefined, one)).toEqual({ count: 1 })
    expect(recoveryNote(session({ aliveAt: T, running: {} }), one)).toEqual({ count: 1 })
    expect(recoveryNote(session({ running: { a: 20_000 } }), one)).toEqual({ count: 1 })
    expect(recoveryNote(session({ aliveAt: T - 5_000, running: { a: 20_000 } }), one)).toEqual({
      count: 1
    })
  })
})

describe('what the recovery note says', () => {
  it('counts the downloads, how long before it quit, and what is fetched again', () => {
    expect(recoveryMessage({ count: 2, agoMs: 1_600, lostBytes: 3.5 * MB })).toBe(
      '2 downloads picked up from the last save, 2 s before it quit. 3.5 MB fetched again; nothing else was lost.'
    )
  })

  it('never says less than a second, and says one download', () => {
    expect(recoveryMessage({ count: 1, agoMs: 80, lostBytes: 2_048 })).toBe(
      '1 download picked up from the last save, 1 s before it quit. 2.0 KB fetched again; nothing else was lost.'
    )
  })

  it('says nothing was lost when the save held everything', () => {
    expect(recoveryMessage({ count: 1, agoMs: 0, lostBytes: 0 })).toBe(
      '1 download picked up from the last save, 1 s before it quit. Nothing was lost.'
    )
  })

  it('leaves the numbers out when they are not known', () => {
    expect(recoveryMessage({ count: 3 })).toBe(
      '3 downloads picked up from the last save; nothing else was lost.'
    )
    expect(recoveryMessage({ count: 1, agoMs: 500 })).toBe(
      '1 download picked up from the last save; nothing else was lost.'
    )
  })

  it('after a crash with nothing downloading', () => {
    expect(recoveryMessage({ count: 0 })).toBe('Nothing was downloading, so nothing was lost.')
  })
})
