// Daily usage, recorded for Reports (docs/plans/2026-11-new-features-plan.md, feature 8; ADR-0082):
// what each network brought in for Mergelane's downloads each local day, and the time merging saved.
// Pure, so it is unit-tested on its own; main/store/usageStore.ts keeps it in mergelane.db.
//
// Time saved is measured "against your fastest single network": had the network that carried the
// most carried everything at the speed it had, it would have taken total ÷ its share as long. So
// saved = time × (total ÷ busiest − 1), zero when one network carried it all.
// - A finished download's own figure uses its active time (started to finished, pauses left out).
// - A day's figure is worked out minute by minute over every download together, with the seconds
//   that had traffic as the time (plan D11). Adding up the downloads' own figures would count a
//   minute once for each download running in it; a minute's can't be more than the minute saved.

import { localDay } from './networkActivity'
import type { NetworkInterfaceKind } from './types'

const MINUTE_MS = 60_000

/** What `time` was worth against the network that carried the most of `bytesByNetwork`. */
export function savedByMerging(timeMs: number, bytesByNetwork: readonly number[]): number {
  const carried = bytesByNetwork.filter((bytes) => bytes > 0)
  const total = carried.reduce((sum, bytes) => sum + bytes, 0)
  if (!(timeMs > 0) || total === 0) return 0
  return Math.round(timeMs * (total / Math.max(...carried) - 1))
}

/** A finished download's active time: started to finished, its pauses left out. */
export function activeTime(state: {
  startedAt: number
  completedAt?: number
  totalPausedMs?: number
}): number {
  if (state.completedAt === undefined) return 0
  return Math.max(0, state.completedAt - state.startedAt - (state.totalPausedMs ?? 0))
}

/** Bytes one network brought in on one local day ('YYYY-MM-DD'). */
export interface UsageBytes {
  day: string
  networkId: string
  bytes: number
}

/** One local day's time with download traffic, time saved by merging, and fastest merged speed. */
export interface UsageSaved {
  day: string
  busyMs: number
  savedMs: number
  peakBytesPerSec: number
}

export interface UsageCounts {
  bytes: UsageBytes[]
  saved: UsageSaved[]
}

/** A network's day as Reports reads it: its name and kind kept, as it may be gone later. */
export interface UsageNetworkDay extends UsageBytes {
  name: string
  kind: NetworkInterfaceKind
}

export interface UsageReport {
  networks: UsageNetworkDay[]
  days: UsageSaved[]
}

interface Minute {
  start: number
  day: string
  byNetwork: Map<string, number>
  /** The seconds, since the epoch, with any traffic. */
  seconds: Set<number>
}

const keyOf = (day: string, networkId: string): string => `${day}\n${networkId}`

/** Counts bytes as they come in, until they are written (drain). */
export class UsageTally {
  private bytes = new Map<string, UsageBytes>()
  private days = new Map<string, UsageSaved>()
  private minute: Minute | null = null

  /** `bytes` just received on `networkId` for a download. */
  add(networkId: string, bytes: number, at: number): void {
    if (!(bytes > 0)) return
    // Offsets from UTC are whole minutes, so an epoch minute is a local one, and never two days:
    // the day is worked out once a minute, not for every piece of every download.
    const start = at - (at % MINUTE_MS)
    if (this.minute && this.minute.start !== start) this.closeMinute()
    this.minute ??= { start, day: localDay(start), byNetwork: new Map(), seconds: new Set() }
    this.minute.byNetwork.set(networkId, (this.minute.byNetwork.get(networkId) ?? 0) + bytes)
    this.minute.seconds.add(Math.floor(at / 1000))

    const { day } = this.minute
    const key = keyOf(day, networkId)
    const counted = this.bytes.get(key)
    if (counted) counted.bytes += bytes
    else this.bytes.set(key, { day, networkId, bytes })
  }

  /** The merged speed downloads held, as the day's fastest goes (shared/networkActivity.ts). */
  peak(bytesPerSec: number, at: number): void {
    if (!(bytesPerSec > 0)) return
    const day = this.day(localDay(at))
    day.peakBytesPerSec = Math.max(day.peakBytesPerSec, Math.round(bytesPerSec))
  }

  /** What is counted and not yet written, taken out. The minute counting now is closed once it has
   * ended (or the clock went back before it), or with `all` (at quit). */
  drain(now: number, all = false): UsageCounts {
    const minute = this.minute
    if (minute && (all || now >= minute.start + MINUTE_MS || now < minute.start)) {
      this.closeMinute()
    }
    const counts = { bytes: [...this.bytes.values()], saved: [...this.days.values()] }
    this.bytes = new Map()
    this.days = new Map()
    return counts
  }

  /** What is counted and not yet written, the minute counting now as if it ended now; nothing
   * changes. */
  pending(): UsageCounts {
    const saved = new Map([...this.days].map(([day, counted]) => [day, { ...counted }]))
    if (this.minute) {
      const { busyMs, savedMs } = this.minuteSaved(this.minute)
      const day = saved.get(this.minute.day) ?? emptyDay(this.minute.day)
      saved.set(this.minute.day, {
        ...day,
        busyMs: day.busyMs + busyMs,
        savedMs: day.savedMs + savedMs
      })
    }
    return {
      bytes: [...this.bytes.values()].map((counted) => ({ ...counted })),
      saved: [...saved.values()]
    }
  }

  /** Counts that could not be written, put back to be written with the next. */
  restore(counts: UsageCounts): void {
    for (const { day, networkId, bytes } of counts.bytes) {
      const key = keyOf(day, networkId)
      const counted = this.bytes.get(key)
      if (counted) counted.bytes += bytes
      else this.bytes.set(key, { day, networkId, bytes })
    }
    for (const { day, busyMs, savedMs, peakBytesPerSec } of counts.saved) {
      const counted = this.day(day)
      counted.busyMs += busyMs
      counted.savedMs += savedMs
      counted.peakBytesPerSec = Math.max(counted.peakBytesPerSec, peakBytesPerSec)
    }
  }

  private closeMinute(): void {
    const minute = this.minute
    this.minute = null
    if (!minute) return
    const { busyMs, savedMs } = this.minuteSaved(minute)
    const day = this.day(minute.day)
    day.busyMs += busyMs
    day.savedMs += savedMs
  }

  private minuteSaved(minute: Minute): { busyMs: number; savedMs: number } {
    const busyMs = minute.seconds.size * 1000
    return { busyMs, savedMs: savedByMerging(busyMs, [...minute.byNetwork.values()]) }
  }

  private day(day: string): UsageSaved {
    let counted = this.days.get(day)
    if (!counted) {
      counted = emptyDay(day)
      this.days.set(day, counted)
    }
    return counted
  }
}

const emptyDay = (day: string): UsageSaved => ({ day, busyMs: 0, savedMs: 0, peakBytesPerSec: 0 })

/** What was written, with what is counted and not yet: the report as it stands. `names` gives a
 * network not written yet its name and kind. */
export function withPending(
  written: UsageReport,
  pending: UsageCounts,
  names: (networkId: string) => { name: string; kind: NetworkInterfaceKind }
): UsageReport {
  const networks = new Map(
    written.networks.map((row) => [keyOf(row.day, row.networkId), { ...row }])
  )
  for (const { day, networkId, bytes } of pending.bytes) {
    const row = networks.get(keyOf(day, networkId))
    if (row) row.bytes += bytes
    else networks.set(keyOf(day, networkId), { day, networkId, bytes, ...names(networkId) })
  }
  const days = new Map(written.days.map((row) => [row.day, { ...row }]))
  for (const counted of pending.saved) {
    const row = days.get(counted.day)
    if (!row) days.set(counted.day, { ...counted })
    else {
      row.busyMs += counted.busyMs
      row.savedMs += counted.savedMs
      row.peakBytesPerSec = Math.max(row.peakBytesPerSec, counted.peakBytesPerSec)
    }
  }
  const byDay = <T extends { day: string }>(a: T, b: T): number => a.day.localeCompare(b.day)
  return {
    networks: [...networks.values()].sort(
      (a, b) => byDay(a, b) || a.networkId.localeCompare(b.networkId)
    ),
    days: [...days.values()].sort(byDay)
  }
}
