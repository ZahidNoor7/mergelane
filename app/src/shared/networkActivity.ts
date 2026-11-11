import type { NetworkInterfaceInfo, NetworkInterfaceKind } from './types'

// What the Dashboard's "Today" and the Networks screen's "Recent network dropouts" remember across
// restarts (M3.7, docs/DECISIONS.md ADR-0042): each network that dropped, came back or turned up, and
// the fastest merged speed of the day. The main process keeps them in network-activity.json in
// userData (main/networkActivity.ts); everything here is pure, so it is unit-tested on its own.

/** A network that came or went. */
export interface NetworkEvent {
  id: string
  /** The system's name for it, kept: once it's gone, the network list no longer has it. */
  osName: string
  kind: NetworkInterfaceKind
  change: 'dropped' | 'recovered' | 'joined'
  at: number
  /** For one that came back: how long it was gone. Unset when it came back while Mergelane was
   * closed, so how long isn't known. */
  downForMs?: number
  /** It came back while Mergelane was closed: seen again at the next launch. */
  whileClosed?: boolean
  /** How many networks were left after the change. */
  left: number
}

/** The most kept: older ones drop off the front. */
export const NETWORK_EVENTS_KEPT = 50
/** And none older than a week. */
export const NETWORK_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** The Dashboard counts the dropouts of the last day (the design's DashboardScreen). */
export const DROPOUT_WINDOW_MS = 24 * 60 * 60_000
/** Seconds a merged speed must hold to count as the day's fastest, as a download's own peak does. */
export const HELD_SECONDS = 5

/** The fastest merged speed of one local calendar day. */
export interface DailyFastest {
  /** YYYY-MM-DD, on this Mac's calendar. */
  day: string
  bytesPerSec: number
}

/** What network-activity.json holds. */
export interface NetworkActivity {
  /** Oldest first. */
  events: NetworkEvent[]
  fastest?: DailyFastest
}

/** The log without events older than a week, at most NETWORK_EVENTS_KEPT of them, oldest first. */
export function pruneNetworkEvents(events: NetworkEvent[], now: number): NetworkEvent[] {
  const kept = events.filter((event) => event.at > now - NETWORK_EVENTS_MAX_AGE_MS)
  return kept.length === events.length && kept.length <= NETWORK_EVENTS_KEPT
    ? events
    : kept.slice(-NETWORK_EVENTS_KEPT)
}

/** `log` with the changes from one network list to the next, newest last. One that comes back
 * after a drop the log still holds is a recovery; otherwise it's new. */
export function appendNetworkEvents(
  log: NetworkEvent[],
  previous: NetworkInterfaceInfo[],
  next: NetworkInterfaceInfo[],
  at: number
): NetworkEvent[] {
  const before = new Set(previous.map((iface) => iface.id))
  const after = new Set(next.map((iface) => iface.id))
  const events: NetworkEvent[] = []
  for (const iface of previous) {
    if (after.has(iface.id)) continue
    events.push({
      id: iface.id,
      osName: iface.displayName,
      kind: iface.kind,
      change: 'dropped',
      at,
      left: next.length
    })
  }
  for (const iface of next) {
    if (before.has(iface.id)) continue
    const drop = log.findLast((event) => event.id === iface.id)
    const recovered = drop?.change === 'dropped'
    events.push({
      id: iface.id,
      osName: iface.displayName,
      kind: iface.kind,
      change: recovered ? 'recovered' : 'joined',
      at,
      ...(recovered ? { downForMs: at - drop.at } : {}),
      left: next.length
    })
  }
  return events.length === 0 ? log : pruneNetworkEvents([...log, ...events], at)
}

/** The first network list after a launch, against the log the last launch left: a network whose
 * last word is a drop and that is here again came back while Mergelane was closed. One that was
 * here and isn't now says nothing: it may have been unplugged on purpose while the app was shut. */
export function reconcileAtLaunch(
  log: NetworkEvent[],
  networks: NetworkInterfaceInfo[],
  at: number
): NetworkEvent[] {
  const back: NetworkEvent[] = []
  for (const iface of networks) {
    if (log.findLast((event) => event.id === iface.id)?.change !== 'dropped') continue
    back.push({
      id: iface.id,
      osName: iface.displayName,
      kind: iface.kind,
      change: 'recovered',
      at,
      whileClosed: true,
      left: networks.length
    })
  }
  return pruneNetworkEvents(back.length === 0 ? log : [...log, ...back], at)
}

/** The dropouts since `from`, and whether every one of them is back. */
export function dropoutsSince(
  events: NetworkEvent[],
  from: number
): { count: number; allBack: boolean } {
  const dropped = events.filter((event) => event.change === 'dropped' && event.at >= from)
  const allBack = dropped.every((drop) =>
    events.some(
      (later) => later.id === drop.id && later.change === 'recovered' && later.at > drop.at
    )
  )
  return { count: dropped.length, allBack }
}

/** YYYY-MM-DD on this Mac's calendar. */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The merged speed held over the last HELD_SECONDS one-second samples, or undefined until there
 * are that many and every one is moving: a burst of a second or two isn't a speed. */
export function heldSpeed(samples: number[]): number | undefined {
  const recent = samples.slice(-HELD_SECONDS)
  if (recent.length < HELD_SECONDS || recent.some((speed) => !(speed > 0))) return undefined
  return recent.reduce((sum, speed) => sum + speed, 0) / HELD_SECONDS
}

/** The day's fastest with `speed` taken in: a new day starts over. The same object when nothing
 * changed, so the caller can tell there is nothing to save. */
export function raiseFastest(
  current: DailyFastest | undefined,
  speed: number | undefined,
  at: number
): DailyFastest | undefined {
  if (speed === undefined || !(speed > 0)) return current
  const day = localDay(at)
  if (current?.day === day && current.bytesPerSec >= speed) return current
  return { day, bytesPerSec: current?.day === day ? Math.max(current.bytesPerSec, speed) : speed }
}

/** Today's fastest merged speed, if one was seen today. */
export function fastestToday(fastest: DailyFastest | undefined, now: number): number | undefined {
  return fastest?.day === localDay(now) ? fastest.bytesPerSec : undefined
}

const KINDS: NetworkInterfaceKind[] = ['wifi', 'usb', 'ethernet', 'bridge', 'other']
const CHANGES: NetworkEvent['change'][] = ['dropped', 'recovered', 'joined']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function eventOf(value: unknown): NetworkEvent | null {
  if (!isRecord(value)) return null
  const { id, osName, kind, change, at, downForMs, whileClosed, left } = value
  if (typeof id !== 'string' || id === '' || typeof osName !== 'string') return null
  if (!KINDS.includes(kind as NetworkInterfaceKind)) return null
  if (!CHANGES.includes(change as NetworkEvent['change'])) return null
  if (!isCount(at) || !isCount(left)) return null
  return {
    id,
    osName,
    kind: kind as NetworkInterfaceKind,
    change: change as NetworkEvent['change'],
    at,
    ...(change === 'recovered' && isCount(downForMs) ? { downForMs } : {}),
    ...(change === 'recovered' && whileClosed === true ? { whileClosed: true } : {}),
    left
  }
}

/** The saved file, checked like any input: it may be hand-edited or from another version. A
 * malformed event is dropped, not shown; the rest is kept, bounded as a fresh log is. */
export function sanitizeNetworkActivity(value: unknown, now: number): NetworkActivity {
  if (!isRecord(value)) return { events: [] }
  const events = (Array.isArray(value.events) ? value.events : [])
    .map(eventOf)
    .filter((event): event is NetworkEvent => event !== null)
    .sort((a, b) => a.at - b.at)
  const fastest = value.fastest
  const keepFastest =
    isRecord(fastest) &&
    typeof fastest.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(fastest.day) &&
    isCount(fastest.bytesPerSec) &&
    fastest.bytesPerSec > 0
  return {
    events: pruneNetworkEvents(events, now),
    ...(keepFastest
      ? { fastest: { day: fastest.day as string, bytesPerSec: fastest.bytesPerSec as number } }
      : {})
  }
}
