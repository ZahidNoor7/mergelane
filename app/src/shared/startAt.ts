import { localDate, scheduleWindow } from './downloadSchedule'
import type { DownloadSchedule, DownloadWhen } from './types'

// New download's "When" (ADR-0044): Now, Add to queue, or At a time. The main process and the
// window both read these, so the sheet says exactly what the download manager will do.

const DAY_MS = 24 * 60 * 60_000

/** The furthest ahead a start time may be. The sheet's time field reaches a day ahead; a week
 * leaves room without keeping a mistyped date waiting for months. */
export const START_AT_MAX_AHEAD_MS = 7 * DAY_MS

/** The most the start timer waits between looks at the clock, so a clock changed by hand, a
 * time zone change or a sleep can't make it late (as the schedule's timer does). */
export const START_CHECK_MAX_MS = 1000

/** What a start time is shown as, in the Mac's own format: "01:00" or "1:00 AM". */
export function startTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** The day of `at` as said beside its time, from `now`: nothing for today, then "tomorrow",
 * "yesterday", or the day and date. */
export function startDay(at: number, now = Date.now()): string {
  const day = localDate(new Date(at))
  const today = new Date(now)
  if (day === localDate(today)) return ''
  const near = (offset: number): string =>
    localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset))
  if (day === near(1)) return 'tomorrow'
  if (day === near(-1)) return 'yesterday'
  return new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "1:00 AM", "tomorrow at 1:00 AM", or "Fri 14 Nov at 1:00 AM". */
function when(at: number, now: number): string {
  const day = startDay(at, now)
  return day ? `${day} at ${startTime(at)}` : startTime(at)
}

/** The next time the clock reads `time` ("HH:MM", as a time field gives it): today if that's
 * still to come, otherwise tomorrow. Null for anything that isn't a time. */
export function nextStartAt(time: string, now = Date.now()): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1)
    at.setHours(hours, minutes, 0, 0)
  }
  return at.getTime()
}

/** The When of a start request, checked: undefined starts now, as does a time already past (it
 * is due). Anything else that isn't one is refused rather than guessed at. */
export function parseWhen(value: unknown, now = Date.now()): DownloadWhen | undefined {
  if (value === undefined || value === null) return undefined
  const given = value as { kind?: unknown; at?: unknown }
  if (given.kind === 'queue') return { kind: 'queue' }
  if (given.kind === 'at' && typeof given.at === 'number' && Number.isFinite(given.at)) {
    if (given.at <= now) return undefined
    if (given.at - now <= START_AT_MAX_AHEAD_MS) return { kind: 'at', at: given.at }
  }
  throw new Error('That start time can’t be used. Choose when this download starts again.')
}

/** The sheet's button: "Start at 1:00 AM", or "Start tomorrow at 1:00 AM". */
export function startAtAction(at: number, now = Date.now()): string {
  return `Start ${startDay(at, now) ? when(at, now) : `at ${startTime(at)}`}`
}

/** A download's row and details while it waits for its time: "Starts at 1:00 AM", or "Starts
 * tomorrow at 1:00 AM". */
export function describeStartAt(at: number, now = Date.now()): string {
  return `Starts ${startDay(at, now) ? when(at, now) : `at ${startTime(at)}`}`
}

/** What the download schedule does to a start time: null when it lets it start then. The
 * schedule wins (ADR-0044): outside its hours, the download starts when they next begin. */
export function startAtScheduleNote(
  schedule: DownloadSchedule | undefined,
  at: number,
  now = Date.now()
): string | null {
  if (!schedule?.enabled) return null
  const window = scheduleWindow(schedule, at)
  if (window.allowed) return null
  if (window.nextStart) {
    return `That’s outside your download schedule, so it starts ${when(window.nextStart, now)}, when the schedule allows.`
  }
  return 'Your download schedule has ended, so it waits until you turn the schedule off.'
}

/** A download added to the queue, in its details: when its turn comes. */
export const HELD_NOTE = 'Starts when a running download finishes, or when you start it.'

/** A download's row while it runs after a start time missed because Mergelane was closed: the
 * download list and the Dashboard both say it. */
export const STARTED_LATE = 'Started late'

/** A start time missed because Mergelane was closed, in the download's details. */
export function missedStartNote(at: number, now = Date.now()): string {
  return `Planned to start ${when(at, now)}, while Mergelane was closed. It started when Mergelane opened.`
}

/** How long the start timer waits before it next looks at the clock, given the start times
 * waiting: undefined when none is. */
export function nextStartCheck(startTimes: number[], now = Date.now()): number | undefined {
  if (startTimes.length === 0) return undefined
  return Math.max(1, Math.min(START_CHECK_MAX_MS, Math.min(...startTimes) - now))
}
