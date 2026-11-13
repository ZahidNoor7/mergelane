import { randomUUID } from 'node:crypto'
import {
  DOWNLOAD_CAP_BYTES,
  DOWNLOAD_MS,
  DOWNLOAD_STREAMS,
  jitter,
  LATENCY_SAMPLES,
  median,
  steadyRate,
  UPLOAD_CAP_BYTES,
  UPLOAD_MS,
  UPLOAD_STREAMS,
  type SpeedTestCombined,
  type SpeedTestLinkResult,
  type SpeedTestLive,
  type SpeedTestNote,
  type SpeedTestPhase,
  type SpeedTestRequest,
  type SpeedTestRun,
  type SpeedTestStatus
} from '../../shared/speedTest'
import type { NetworkInterfaceInfo } from '../../shared/types'
import {
  measureLatency,
  measureTransfer,
  type Connection,
  type Lane,
  type TransferResult
} from './measure'

// Runs one speed test at a time (docs/DECISIONS.md ADR-0064): each network on its own, every
// network at once, or through system merge, then saves it. Free of Electron: everything it needs
// from the app comes in SpeedTestDeps, so the e2e suite's Node side runs it against the local test
// server with fakes for the rest (e2e/speedTest.spec.ts).

/** What the helper says while a system test runs, or null when it can't be asked. */
export interface SystemMergeState {
  on: boolean
  /** Why it's off, in the helper's words (another VPN, for one). */
  reason?: string
  stickySites?: boolean
  /** Some network has a speed limit in system merge. */
  limited: boolean
}

/** One network's traffic now, by its device name, from the helper (bytes a second). */
export interface LinkTraffic {
  /** System merge's traffic through it. */
  rxBps: number
  txBps: number
  /** Everything on the interface. */
  linkRxBps: number
  linkTxBps: number
}

export interface SpeedTestDeps {
  find: (id: string) => NetworkInterfaceInfo | undefined
  /** Whether the network has used up its data limit. */
  limitReached: (id: string) => boolean
  /** Counts the test's bytes against the network's data limit. */
  countUsage: (id: string, bytes: number) => void
  server: () => string
  /** A connection tied to the network, or tied to none (null: system merge routes it). */
  connect: (network: string | null) => Connection
  /** Holds Mergelane's downloads for the test (DownloadManager.holdForSpeedTest): running ones
   * wait at the front of the queue and nothing starts. Says which were running. */
  pauseDownloads: () => Promise<string[]>
  /** Lets them go again. Called after every test, even when holding them failed. */
  resumeDownloads: (ids: string[]) => void
  systemMerge: () => Promise<SystemMergeState | null>
  /** The helper's per-network traffic, or null without a helper to ask. */
  traffic: () => Promise<Record<string, LinkTraffic> | null>
  save: (run: SpeedTestRun) => Promise<void>
  /** The test as it goes, and null once it's over. */
  onLive: (live: SpeedTestLive | null) => void
  onFinished: (run: SpeedTestRun) => void
  now?: () => number
  timing?: Partial<SpeedTestTiming>
}

export interface SpeedTestTiming {
  latencySamples: number
  downloadMs: number
  uploadMs: number
  downloadCap: number
  uploadCap: number
  downloadStreams: number
  uploadStreams: number
  stallMs: number
  /** How often the helper's counters are read during a transfer. */
  trafficMs: number
}

const DEFAULT_TIMING: SpeedTestTiming = {
  latencySamples: LATENCY_SAMPLES,
  downloadMs: DOWNLOAD_MS,
  uploadMs: UPLOAD_MS,
  downloadCap: DOWNLOAD_CAP_BYTES,
  uploadCap: UPLOAD_CAP_BYTES,
  downloadStreams: DOWNLOAD_STREAMS,
  uploadStreams: UPLOAD_STREAMS,
  stallMs: 5_000,
  trafficMs: 1_000
}

/** Live updates go to the window at most this often. */
const LIVE_MS = 150
/** Other traffic on a network counts as busy above this share of the test's speed, and this much. */
const BUSY_SHARE = 0.15
const BUSY_BYTES_PER_SEC = 128 * 1024

/** The id of the one lane a system test has: the helper, not a network. */
export const SYSTEM_LANE = 'system'

export class SpeedTestBusyError extends Error {
  constructor() {
    super('A speed test is already running')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

export class SpeedTester {
  /** The test running now. Cleared the moment it's over, before it is saved, so the next can start
   * as soon as the window says this one has ended. */
  private running: { id: string; controller: AbortController } | null = null
  /** The last test started, saving included. */
  private done: Promise<void> = Promise.resolve()
  private live: SpeedTestLive | null = null
  private lastPush = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly timing: SpeedTestTiming
  private readonly now: () => number

  constructor(private readonly deps: SpeedTestDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.now = deps.now ?? Date.now
  }

  /** The test in progress, if any. */
  current(): SpeedTestLive | null {
    return this.live
  }

  /** Starts a test and says its id; it runs on, telling onLive and onFinished. */
  start(request: SpeedTestRequest): string {
    if (this.running) throw new SpeedTestBusyError()
    const ids = [...new Set(request.networkIds)]
    if (request.scope !== 'system' && ids.length === 0) {
      throw new Error('Choose a network to test')
    }
    const id = randomUUID()
    const controller = new AbortController()
    this.running = { id, controller }
    this.done = this.run(id, { ...request, networkIds: ids }, controller.signal)
    return id
  }

  cancel(): void {
    this.running?.controller.abort()
  }

  /** Waits for the last test to finish and be saved (tests, and quitting). */
  async settled(): Promise<void> {
    await this.done
  }

  private update(patch: Partial<SpeedTestLive>, force = false): void {
    if (!this.live) return
    this.live = { ...this.live, ...patch }
    const now = Date.now()
    if (force || now - this.lastPush >= LIVE_MS) {
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = null
      this.lastPush = now
      this.deps.onLive(this.live)
    } else {
      this.pushTimer ??= setTimeout(() => {
        this.pushTimer = null
        this.lastPush = Date.now()
        if (this.live) this.deps.onLive(this.live)
      }, LIVE_MS)
    }
  }

  private async run(id: string, request: SpeedTestRequest, signal: AbortSignal): Promise<void> {
    const startedAt = this.now()
    const server = this.deps.server()
    const notes = new Set<SpeedTestNote>()
    this.live = {
      runId: id,
      scope: request.scope,
      startedAt,
      networkIds: request.networkIds,
      phase: 'latency',
      fraction: 0,
      bytesPerSec: 0,
      peakBytesPerSec: 0,
      results: [],
      share: {},
      pausedDownloads: 0
    }
    this.deps.onLive(this.live)

    let paused: string[] = []
    let run: SpeedTestRun
    try {
      paused = await this.deps.pauseDownloads()
      if (paused.length > 0) notes.add('downloads-paused')
      this.update({ pausedDownloads: paused.length }, true)
      const outcome =
        request.scope === 'link'
          ? await this.eachNetwork(request.networkIds, server, signal, notes)
          : request.scope === 'combined'
            ? await this.together(request.networkIds, server, signal)
            : await this.throughSystemMerge(server, signal, notes)
      run = {
        id,
        scope: request.scope,
        server,
        startedAt,
        finishedAt: this.now(),
        ...outcome,
        notes: [...notes]
      }
    } catch (error) {
      run = {
        id,
        scope: request.scope,
        server,
        startedAt,
        finishedAt: this.now(),
        status: signal.aborted || isAbort(error) ? 'cancelled' : 'failed',
        ...(signal.aborted || isAbort(error) ? {} : { reason: message(error) }),
        links: this.live?.results ?? [],
        notes: [...notes]
      }
    } finally {
      // Always: holding may have begun before it failed, and nothing may stay held after a test.
      this.deps.resumeDownloads(paused)
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = null
      this.live = null
      if (this.running?.id === id) this.running = null
      this.deps.onLive(null)
    }
    // A cancelled test isn't kept: it measured nothing whole.
    if (run.status !== 'cancelled') await this.deps.save(run).catch(() => {})
    this.deps.onFinished(run)
  }

  /** A network's result before anything is measured, named as the network list names it now. */
  private blank(networkId: string): SpeedTestLinkResult {
    const network = this.deps.find(networkId)
    return {
      networkId,
      kind: network?.kind ?? 'other',
      name: network?.displayName ?? networkId,
      status: 'done',
      latencySamples: 0,
      bytesDown: 0,
      bytesUp: 0
    }
  }

  /** Why the network can't be tested now, if it can't. */
  private unavailable(networkId: string): string | undefined {
    if (!this.deps.find(networkId)) return 'Not connected'
    if (this.deps.limitReached(networkId)) return 'Its data limit is reached'
    return undefined
  }

  private lane(networkId: string): Lane {
    return {
      id: networkId,
      connection: this.deps.connect(networkId),
      present: () => this.deps.find(networkId) !== undefined,
      limitReached: () => this.deps.limitReached(networkId)
    }
  }

  private async latency(
    connection: Connection,
    server: string,
    signal: AbortSignal
  ): Promise<number[]> {
    const taken: number[] = []
    return measureLatency(connection, {
      server,
      samples: this.timing.latencySamples,
      signal,
      onSample: (ms) => {
        taken.push(ms)
        this.update({
          phase: 'latency',
          latencyMs: median(taken),
          fraction: taken.length / this.timing.latencySamples
        })
      }
    })
  }

  private transfer(
    direction: 'download' | 'upload',
    lanes: Lane[],
    server: string,
    signal: AbortSignal,
    counted: (laneId: string) => string | null
  ): Promise<TransferResult> {
    const download = direction === 'download'
    this.update({ phase: direction as SpeedTestPhase, fraction: 0, bytesPerSec: 0 }, true)
    return measureTransfer({
      direction,
      server,
      lanes,
      streams: download ? this.timing.downloadStreams : this.timing.uploadStreams,
      durationMs: download ? this.timing.downloadMs : this.timing.uploadMs,
      capBytes: download ? this.timing.downloadCap : this.timing.uploadCap,
      stallMs: this.timing.stallMs,
      signal,
      onBytes: (laneId, bytes) => {
        const network = counted(laneId)
        if (network) this.deps.countUsage(network, bytes)
      },
      onTick: (bytesPerSec, fraction, perLane) =>
        this.update({
          bytesPerSec,
          peakBytesPerSec: Math.max(this.live?.peakBytesPerSec ?? 0, bytesPerSec),
          fraction,
          // Each network's part as it arrives, when several share the test; the system test's
          // parts come from the helper's counters instead (throughSystemMerge).
          ...(lanes.length > 1 ? { share: perLane } : {})
        })
    })
  }

  /** Reads the helper's counters every trafficMs while `work` runs, and gives back each network's
   * average rates over that time; null when there's no helper to ask. */
  private async watchTraffic<T>(
    work: Promise<T>,
    onSample?: (traffic: Record<string, LinkTraffic>, seconds: number) => void
  ): Promise<{ value: T; average: Record<string, LinkTraffic> | null }> {
    const sums: Record<string, LinkTraffic> = {}
    let count = 0
    let stopped = false
    let last = Date.now()
    const read = async (): Promise<void> => {
      const traffic = await this.deps.traffic().catch(() => null)
      if (!traffic || stopped) return
      const now = Date.now()
      const seconds = (now - last) / 1000
      last = now
      count++
      onSample?.(traffic, seconds)
      for (const [name, each] of Object.entries(traffic)) {
        const sum = (sums[name] ??= { rxBps: 0, txBps: 0, linkRxBps: 0, linkTxBps: 0 })
        sum.rxBps += each.rxBps
        sum.txBps += each.txBps
        sum.linkRxBps += each.linkRxBps
        sum.linkTxBps += each.linkTxBps
      }
    }
    const timer = setInterval(() => void read(), this.timing.trafficMs)
    try {
      const value = await work
      return {
        value,
        average:
          count === 0
            ? null
            : Object.fromEntries(
                Object.entries(sums).map(([name, sum]) => [
                  name,
                  {
                    rxBps: sum.rxBps / count,
                    txBps: sum.txBps / count,
                    linkRxBps: sum.linkRxBps / count,
                    linkTxBps: sum.linkTxBps / count
                  }
                ])
              )
      }
    } finally {
      stopped = true
      clearInterval(timer)
    }
  }

  /** `link`: each network on its own, one after another, so networks sharing a router or a radio
   * don't slow each other's result. A network that fails doesn't stop the others. */
  private async eachNetwork(
    networkIds: string[],
    server: string,
    signal: AbortSignal,
    notes: Set<SpeedTestNote>
  ): Promise<Pick<SpeedTestRun, 'status' | 'reason' | 'links'>> {
    const results: SpeedTestLinkResult[] = []
    for (const networkId of networkIds) {
      if (signal.aborted) throw signal.reason
      this.update(
        { networkId, phase: 'latency', fraction: 0, bytesPerSec: 0, latencyMs: undefined },
        true
      )
      const result = this.blank(networkId)
      const why = this.unavailable(networkId)
      if (why) {
        results.push({ ...result, status: 'unavailable', reason: why })
        this.update({ results: [...results] }, true)
        continue
      }
      const lane = this.lane(networkId)
      try {
        const samples = await this.latency(lane.connection, server, signal)
        result.latencySamples = samples.length
        result.latencyMs = median(samples)
        result.jitterMs = jitter(samples)
        const { value: down, average } = await this.watchTraffic(
          this.transfer('download', [lane], server, signal, () => networkId)
        )
        result.bytesDown = down.lanes[networkId].bytes
        const downError = down.lanes[networkId].error
        if (downError) throw new Error(downError)
        result.downloadBytesPerSec = steadyRate(down.samples)
        const seen = average?.[this.deps.find(networkId)?.device ?? networkId]
        const rate = (result.bytesDown * 1000) / Math.max(1, down.samples.at(-1)?.at ?? 1)
        if (seen && seen.linkRxBps - rate > Math.max(rate * BUSY_SHARE, BUSY_BYTES_PER_SEC)) {
          notes.add('busy-network')
        }
        const up = await this.transfer('upload', [lane], server, signal, () => networkId)
        result.bytesUp = up.lanes[networkId].bytes
        const upError = up.lanes[networkId].error
        if (upError) throw new Error(upError)
        result.uploadBytesPerSec = steadyRate(up.samples)
      } catch (error) {
        if (signal.aborted || isAbort(error)) throw error
        result.status = 'failed'
        result.reason = message(error)
      } finally {
        lane.connection.close()
      }
      results.push(result)
      this.update({ results: [...results] }, true)
    }
    return { status: overall(results.map((result) => result.status)), links: results }
  }

  /** `combined`: every network at once, each with its own connections, as Mergelane's downloads
   * use them. The total is what arrived on all of them together. Latency is each network's own,
   * taken one after another first. */
  private async together(
    networkIds: string[],
    server: string,
    signal: AbortSignal
  ): Promise<Pick<SpeedTestRun, 'status' | 'reason' | 'links' | 'combined'>> {
    const results = new Map<string, SpeedTestLinkResult>()
    const lanes: Lane[] = []
    for (const networkId of networkIds) {
      const result = this.blank(networkId)
      results.set(networkId, result)
      const why = this.unavailable(networkId)
      if (why) Object.assign(result, { status: 'unavailable', reason: why })
      else lanes.push(this.lane(networkId))
    }
    const links = (): SpeedTestLinkResult[] => [...results.values()]
    if (lanes.length === 0) {
      return { status: 'unavailable', reason: 'No network can be tested', links: links() }
    }
    try {
      for (const lane of lanes) {
        this.update({ networkId: lane.id, fraction: 0, latencyMs: undefined }, true)
        const result = results.get(lane.id)!
        try {
          const samples = await this.latency(lane.connection, server, signal)
          Object.assign(result, {
            latencySamples: samples.length,
            latencyMs: median(samples),
            jitterMs: jitter(samples)
          })
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw error
          Object.assign(result, { status: 'failed', reason: message(error) })
        }
      }
      const working = lanes.filter((lane) => results.get(lane.id)!.status === 'done')
      if (working.length === 0) {
        return { status: 'failed', reason: 'No network answered', links: links() }
      }
      this.update({ networkId: undefined }, true)
      const down = await this.transfer('download', working, server, signal, (laneId) => laneId)
      const combined: SpeedTestCombined = {
        downloadBytesPerSec: steadyRate(down.samples),
        share: {}
      }
      for (const lane of working) {
        const outcome = down.lanes[lane.id]
        const result = results.get(lane.id)!
        combined.share[lane.id] = outcome.bytes
        result.bytesDown = outcome.bytes
        result.downloadBytesPerSec = steadyRate(outcome.samples)
        if (outcome.error) Object.assign(result, { status: 'failed', reason: outcome.error })
      }
      this.update({ share: { ...combined.share } }, true)
      const stillWorking = working.filter((lane) => results.get(lane.id)!.status === 'done')
      if (stillWorking.length > 0) {
        const up = await this.transfer('upload', stillWorking, server, signal, (laneId) => laneId)
        combined.uploadBytesPerSec = steadyRate(up.samples)
        for (const lane of stillWorking) {
          const outcome = up.lanes[lane.id]
          const result = results.get(lane.id)!
          result.bytesUp = outcome.bytes
          result.uploadBytesPerSec = steadyRate(outcome.samples)
          if (outcome.error) Object.assign(result, { status: 'failed', reason: outcome.error })
        }
      }
      const status = overall(links().map((link) => link.status))
      return {
        status: status === 'unavailable' ? 'failed' : status,
        links: links(),
        combined
      }
    } finally {
      for (const lane of lanes) lane.connection.close()
    }
  }

  /** `system`: connections tied to no network, so system merge's helper picks the network for each,
   * as for any other app. Which networks carried it comes from the helper's counters. */
  private async throughSystemMerge(
    server: string,
    signal: AbortSignal,
    notes: Set<SpeedTestNote>
  ): Promise<Pick<SpeedTestRun, 'status' | 'reason' | 'links' | 'combined'>> {
    const state = await this.deps.systemMerge()
    if (!state?.on) {
      return {
        status: 'unavailable',
        reason:
          state?.reason ?? (state ? 'System merge is off' : 'The system-wide helper isn’t running'),
        links: []
      }
    }
    if (state.stickySites !== false) notes.add('sticky-sites-on')
    if (state.limited) notes.add('speed-limit')
    const connection = this.deps.connect(null)
    const lane: Lane = { id: SYSTEM_LANE, connection, present: () => true }
    const share: Record<string, number> = {}
    const shareUp: Record<string, number> = {}
    try {
      const samples = await this.latency(connection, server, signal)
      const accumulate =
        (into: Record<string, number>, key: 'rxBps' | 'txBps') =>
        (traffic: Record<string, LinkTraffic>, seconds: number): void => {
          for (const [name, each] of Object.entries(traffic)) {
            into[name] = (into[name] ?? 0) + each[key] * seconds
          }
          if (key === 'rxBps') this.update({ share: { ...into } })
        }
      const { value: down } = await this.watchTraffic(
        this.transfer('download', [lane], server, signal, () => null),
        accumulate(share, 'rxBps')
      )
      const downError = down.lanes[SYSTEM_LANE].error
      if (downError) throw new Error(downError)
      const { value: up } = await this.watchTraffic(
        this.transfer('upload', [lane], server, signal, () => null),
        accumulate(shareUp, 'txBps')
      )
      const upError = up.lanes[SYSTEM_LANE].error
      if (upError) throw new Error(upError)
      const names = new Set([...Object.keys(share), ...Object.keys(shareUp)])
      const links = [...names]
        .filter((name) => (share[name] ?? 0) + (shareUp[name] ?? 0) > 0)
        .map((name): SpeedTestLinkResult => {
          const network = this.deps.find(name)
          return {
            networkId: name,
            kind: network?.kind ?? 'other',
            name: network?.displayName ?? name,
            status: 'done',
            latencySamples: 0,
            bytesDown: Math.round(share[name] ?? 0),
            bytesUp: Math.round(shareUp[name] ?? 0)
          }
        })
      return {
        status: 'done',
        links,
        combined: {
          downloadBytesPerSec: steadyRate(down.samples),
          uploadBytesPerSec: steadyRate(up.samples),
          latencyMs: median(samples),
          jitterMs: jitter(samples),
          share: Object.fromEntries(
            Object.entries(share).map(([name, bytes]) => [name, Math.round(bytes)])
          )
        }
      }
    } finally {
      connection.close()
    }
  }
}

/** A test's status from its networks': done if any network finished, else failed if any failed,
 * else unavailable. */
function overall(statuses: SpeedTestStatus[]): SpeedTestStatus {
  if (statuses.includes('done')) return 'done'
  if (statuses.includes('failed')) return 'failed'
  return 'unavailable'
}
