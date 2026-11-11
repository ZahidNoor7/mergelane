import {
  SPEED_HISTORY_SECONDS,
  type DownloadState,
  type FinishedDownload,
  type NetworkInterfaceInfo,
  type NetworkInterfaceKind,
  type NetworkPreferences
} from '@shared/types'
import { wantedBytes } from './format'

// What the dashboard shows, worked out from the store without React or the window, so it can be
// tested on its own (e2e/dashboardModel.spec.ts).

/** Every unfinished download, sorted the way the dashboard lists them. */
export interface ActiveDownloads {
  /** Running now, oldest first. */
  running: DownloadState[]
  paused: DownloadState[]
  /** In the order they'll start. */
  queued: DownloadState[]
  failed: number
  /** Bytes a second over every running download. */
  totalSpeed: number
  /** Seconds until the running downloads are all done, if the combined speed holds; unset when
   * there's no telling (a size unknown, or nothing moving). */
  etaSeconds?: number
}

export function activeDownloads(downloads: DownloadState[]): ActiveDownloads {
  const byStart = [...downloads].sort((a, b) => a.startedAt - b.startedAt)
  const running = byStart.filter((download) => download.status === 'downloading')
  const totalSpeed = running.reduce((sum, download) => sum + download.speedBytesPerSec, 0)
  const sized = running.every((download) => download.totalBytes > 0)
  const remaining = running.reduce(
    (sum, download) => sum + Math.max(0, wantedBytes(download) - download.bytesDownloaded),
    0
  )
  return {
    running,
    paused: byStart.filter((download) => download.status === 'paused'),
    queued: byStart
      .filter((download) => download.status === 'queued')
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0)),
    failed: byStart.filter((download) => download.status === 'error').length,
    totalSpeed,
    ...(running.length > 0 && sized && totalSpeed > 0 ? { etaSeconds: remaining / totalSpeed } : {})
  }
}

/** Each network's speed over every running download, by network id. */
export function networkSpeeds(downloads: DownloadState[]): Map<string, number> {
  const speeds = new Map<string, number>()
  for (const download of downloads) {
    if (download.status !== 'downloading') continue
    for (const network of download.networks) {
      speeds.set(network.id, (speeds.get(network.id) ?? 0) + network.speedBytesPerSec)
    }
  }
  return speeds
}

/** The last minute of every running download added up, per network: each download's history
 * ends now, so the series line up at their newest second. Every series is as long as the
 * longest, as the throughput chart expects. A download that stops running leaves the sum. */
export function combinedHistory(downloads: DownloadState[]): Record<string, number[]> {
  const running = downloads.filter((download) => download.status === 'downloading')
  const length = Math.min(
    SPEED_HISTORY_SECONDS,
    Math.max(
      0,
      ...running.flatMap((download) =>
        Object.values(download.speedHistory ?? {}).map((series) => series.length)
      )
    )
  )
  const combined: Record<string, number[]> = {}
  for (const download of running) {
    for (const [id, series] of Object.entries(download.speedHistory ?? {})) {
      const sum = (combined[id] ??= new Array<number>(length).fill(0))
      const recent = series.slice(-length)
      const offset = length - recent.length
      recent.forEach((value, index) => (sum[offset + index] += value))
    }
  }
  return combined
}

/** What a network is doing, in one word the dashboard can say beside it. */
export type NetworkCondition =
  /** Connected, nothing holding it back. */
  | 'up'
  /** Connected, with a speed limit set on it. */
  | 'limited'
  /** Its data limit for the period is used up, so downloads leave it alone. */
  | 'paused'
  /** A download is on it, but it can't reach the server or peers. */
  | 'unreachable'
  /** Gone from the computer's networks; a download still lists it. */
  | 'offline'

export interface NetworkSummary {
  id: string
  kind: NetworkInterfaceKind
  /** The system's name for it (a download's label for one that's gone). */
  osName: string
  condition: NetworkCondition
  speed: number
  /** Bytes a second, when a speed limit is set on it. */
  speedLimit?: number
}

/** Every network the computer has, then any a download still lists that has gone, each with
 * its speed and condition. `usage` is what each has received and sent this period (useNetworkUsage). */
export function networkSummaries(
  interfaces: NetworkInterfaceInfo[],
  downloads: DownloadState[],
  preferences: NetworkPreferences,
  usage: Record<string, number>
): NetworkSummary[] {
  const speeds = networkSpeeds(downloads)
  const present = new Set(interfaces.map((iface) => iface.id))
  const statuses = new Map<string, Set<string>>()
  const gone = new Map<string, { kind: NetworkInterfaceKind; label: string }>()
  for (const download of downloads) {
    for (const network of download.networks) {
      if (!network.enabled) continue
      if (!statuses.has(network.id)) statuses.set(network.id, new Set())
      // Only a running download is trying the network right now.
      if (download.status === 'downloading') statuses.get(network.id)!.add(network.status)
      if (!present.has(network.id) && !gone.has(network.id)) {
        gone.set(network.id, { kind: network.kind, label: network.label })
      }
    }
  }

  const condition = (id: string): NetworkCondition => {
    if (!present.has(id)) return 'offline'
    const preference = preferences[id]
    const seen = statuses.get(id)
    const dataLimit = preference?.dataLimit
    if ((dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit) || seen?.has('limit')) {
      return 'paused'
    }
    if (seen?.has('unreachable') && !seen.has('on')) return 'unreachable'
    return preference?.speedLimit !== undefined ? 'limited' : 'up'
  }
  const summary = (id: string, kind: NetworkInterfaceKind, osName: string): NetworkSummary => {
    const speedLimit = preferences[id]?.speedLimit
    return {
      id,
      kind,
      osName,
      condition: condition(id),
      speed: speeds.get(id) ?? 0,
      ...(speedLimit !== undefined ? { speedLimit } : {})
    }
  }
  return [
    ...interfaces.map((iface) => summary(iface.id, iface.kind, iface.displayName)),
    ...[...gone].map(([id, network]) => summary(id, network.kind, network.label))
  ]
}

// The network log lives in shared/ (the main process keeps it across restarts); re-exported for
// the dashboard's callers and e2e/dashboardModel.spec.ts.
export {
  appendNetworkEvents,
  NETWORK_EVENTS_KEPT,
  type NetworkEvent
} from '@shared/networkActivity'

/** "14s", "3 min", "2 h": how long a network was gone, rounded the way people say it. */
export function formatDowntime(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}

/** Each link's merged download traffic, a sample a second, newest last: `history` with this
 * second's sample added. A link the helper no longer reports leaves; a new one starts empty. */
export function appendLinkSamples(
  history: Record<string, number[]>,
  links: { name: string; rxBps: number }[],
  kept = SPEED_HISTORY_SECONDS
): Record<string, number[]> {
  const next: Record<string, number[]> = {}
  for (const link of links) {
    next[link.name] = [...(history[link.name] ?? []), Math.max(0, link.rxBps)].slice(-kept)
  }
  return next
}

/** What Mergelane's downloads brought in today, on this Mac's calendar: by each network that
 * carried part of them, with the fastest a download ran. A download counts on the day it finished,
 * or, still going, on the day it started; one that ran over midnight counts on the later day. */
export interface Today {
  /** Bytes by network id, biggest first. */
  byNetwork: { id: string; kind: NetworkInterfaceKind; label: string; bytes: number }[]
  total: number
  /** The best speed any of them held for a few seconds (see DownloadState.peakSpeedBytesPerSec). */
  fastest: number | undefined
}

export function todayTotals(
  downloads: DownloadState[],
  history: FinishedDownload[],
  now: number
): Today {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const from = start.getTime()
  const counted = [
    ...downloads.filter(
      (download) =>
        download.status !== 'cancelled' && (download.completedAt ?? download.startedAt) >= from
    ),
    ...history.filter((entry) => (entry.completedAt ?? entry.startedAt) >= from)
  ]
  const byNetwork = new Map<string, Today['byNetwork'][number]>()
  let fastest: number | undefined
  for (const item of counted) {
    if (item.peakSpeedBytesPerSec !== undefined) {
      fastest = Math.max(fastest ?? 0, item.peakSpeedBytesPerSec)
    }
    for (const network of item.networks) {
      if (network.bytesDownloaded <= 0) continue
      const entry = byNetwork.get(network.id) ?? {
        id: network.id,
        kind: network.kind,
        label: network.label,
        bytes: 0
      }
      entry.bytes += network.bytesDownloaded
      byNetwork.set(network.id, entry)
    }
  }
  const list = [...byNetwork.values()].sort((a, b) => b.bytes - a.bytes)
  return { byNetwork: list, total: list.reduce((sum, entry) => sum + entry.bytes, 0), fastest }
}
