import type { DatabaseSync } from 'node:sqlite'
import { heldSpeed, HELD_SECONDS } from '../../shared/networkActivity'
import type { NetworkInterfaceInfo, NetworkInterfaceKind } from '../../shared/types'
import {
  UsageTally,
  withPending,
  type UsageCounts,
  type UsageNetworkDay,
  type UsageReport,
  type UsageSaved
} from '../../shared/usage'
import { database } from './database'

// Daily usage for Reports (docs/plans/2026-11-new-features-plan.md, feature 8; ADR-0082), recorded
// from now so Reports has weeks of real data when it ships. Every byte a download receives already
// goes through the limits (network/limits.ts take), which hand it on here; uploads and speed tests
// don't, so "Downloaded" means what it says. Counted in memory and written to mergelane.db once a
// minute and at quit: a crash loses at most that minute's count.

const WRITE_MS = 60_000

interface DayRow {
  day: string
  network_id: string
  network_name: string
  kind: NetworkInterfaceKind
  bytes: number
}

interface SavedRow {
  day: string
  busy_ms: number
  saved_ms: number
  peak_bytes_per_sec: number
}

type Named = { name: string; kind: NetworkInterfaceKind }

function write(db: DatabaseSync, counts: UsageCounts, named: (id: string) => Named): void {
  const day = db.prepare(
    `INSERT INTO usage_days (day, network_id, network_name, kind, bytes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, network_id) DO UPDATE SET bytes = bytes + excluded.bytes,
       network_name = excluded.network_name, kind = excluded.kind`
  )
  const saved = db.prepare(
    `INSERT INTO usage_saved (day, busy_ms, saved_ms, peak_bytes_per_sec) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET busy_ms = busy_ms + excluded.busy_ms,
       saved_ms = saved_ms + excluded.saved_ms,
       peak_bytes_per_sec = MAX(peak_bytes_per_sec, excluded.peak_bytes_per_sec)`
  )
  db.exec('BEGIN')
  try {
    for (const counted of counts.bytes) {
      const { name, kind } = named(counted.networkId)
      day.run(counted.day, counted.networkId, name, kind, counted.bytes)
    }
    for (const counted of counts.saved) {
      saved.run(counted.day, counted.busyMs, counted.savedMs, counted.peakBytesPerSec)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export class UsageRecorder {
  private readonly tally = new UsageTally()
  /** Each network's name and kind as last seen, kept for one that has gone since. */
  private readonly names = new Map<string, Named>()
  private samples: number[] = []
  private timer: NodeJS.Timeout | null

  constructor(private readonly find: (networkId: string) => NetworkInterfaceInfo | undefined) {
    this.timer = setInterval(() => this.write(), WRITE_MS)
    this.timer.unref()
  }

  /** `bytes` a download just received on `networkId` (Limits.take). */
  received(networkId: string, bytes: number, at: number): void {
    this.tally.add(networkId, bytes, at)
    if (!this.names.has(networkId)) this.names.set(networkId, this.lookUp(networkId))
  }

  /** The computer's networks changed: a renamed one keeps its id and takes its new name. */
  networksChanged(networks: readonly NetworkInterfaceInfo[]): void {
    for (const network of networks) {
      this.names.set(network.id, { name: network.displayName, kind: network.kind })
    }
  }

  /** Once a second: every running download's speed together, for the day's fastest. */
  sample(totalSpeed: number, at = Date.now()): void {
    this.samples = [...this.samples, totalSpeed].slice(-HELD_SECONDS)
    const held = heldSpeed(this.samples)
    if (held !== undefined) this.tally.peak(held, at)
  }

  /** Writes what is counted; with `all`, the minute counting now too (at quit). What can't be
   * written is kept, to go with the next. */
  write(all = false): void {
    const counts = this.tally.drain(Date.now(), all)
    if (counts.bytes.length === 0 && counts.saved.length === 0) return
    try {
      write(database(), counts, (id) => this.named(id))
    } catch (error) {
      this.tally.restore(counts)
      console.error('[mergelane] failed to save usage', error)
    }
  }

  /** Every day from `from` ('YYYY-MM-DD'), as written and as counted since. */
  report(from: string): UsageReport {
    const db = database()
    const networks = (
      db
        .prepare('SELECT * FROM usage_days WHERE day >= ? ORDER BY day, network_id')
        .all(from) as unknown as DayRow[]
    ).map((row): UsageNetworkDay => ({
      day: row.day,
      networkId: row.network_id,
      name: row.network_name,
      kind: row.kind,
      bytes: row.bytes
    }))
    const days = (
      db
        .prepare('SELECT * FROM usage_saved WHERE day >= ? ORDER BY day')
        .all(from) as unknown as SavedRow[]
    ).map((row): UsageSaved => ({
      day: row.day,
      busyMs: row.busy_ms,
      savedMs: row.saved_ms,
      peakBytesPerSec: row.peak_bytes_per_sec
    }))
    const report = withPending({ networks, days }, this.tally.pending(), (id) => this.named(id))
    return {
      networks: report.networks.filter((row) => row.day >= from),
      days: report.days.filter((row) => row.day >= from)
    }
  }

  /** At quit, before the database closes: everything counted is written. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.write(true)
  }

  private named(networkId: string): Named {
    return this.names.get(networkId) ?? this.lookUp(networkId)
  }

  private lookUp(networkId: string): Named {
    const network = this.find(networkId)
    return network
      ? { name: network.displayName, kind: network.kind }
      : { name: networkId, kind: 'other' }
  }
}
