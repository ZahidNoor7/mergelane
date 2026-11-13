import type { NetworkInterfaceKind } from './types'

// The speed test (docs/DECISIONS.md ADR-0064): what it measures, how its numbers are worked out
// from what it saw, and what speed-tests.json keeps. Everything here is pure, so it is unit-tested
// on its own; the main process does the measuring (main/speedTest/).
//
// Speeds are bytes a second, as everywhere else in Mergelane; the window shows them in the user's
// unit. Times are milliseconds.

/** What a test covers:
 * - `link`: each chosen network on its own, one after another, every connection tied to it;
 * - `combined`: every chosen network at the same time, each with its own connections, the way
 *   Mergelane's downloads use them. The total is what arrived, not the networks' results added up;
 * - `system`: connections tied to no network, so system merge's helper picks the network for each,
 *   as it does for other apps. */
export type SpeedTestScope = 'link' | 'combined' | 'system'

export type SpeedTestPhase = 'latency' | 'download' | 'upload'

export type SpeedTestStatus = 'done' | 'failed' | 'cancelled' | 'unavailable'

/** Things worth knowing about a result, said under it. */
export type SpeedTestNote =
  /** Mergelane's own downloads were paused for the test and resumed after it. */
  | 'downloads-paused'
  /** Other traffic on the network while it was measured (from the helper's interface counters). */
  | 'busy-network'
  /** System merge keeps each website on one network, so the test reached one network (ADR-0048). */
  | 'sticky-sites-on'
  /** A network has a speed limit in system merge, which the system test went through. */
  | 'speed-limit'

/** Cloudflare's public speed test (owner, 2026-11-13): `__down?bytes=N` sends N bytes, `__up`
 * takes a body. A custom server must answer the same two paths. */
export const DEFAULT_SPEED_TEST_SERVER = 'https://speed.cloudflare.com'

/** How long each part of a test runs on one network, at most. */
export const LATENCY_SAMPLES = 20
export const DOWNLOAD_MS = 10_000
export const UPLOAD_MS = 10_000
/** The most one network's test takes in data, each way: a phone's plan pays for it. */
export const DOWNLOAD_CAP_BYTES = 150 * 1024 * 1024
export const UPLOAD_CAP_BYTES = 50 * 1024 * 1024
/** Connections each network opens for each direction. */
export const DOWNLOAD_STREAMS = 6
export const UPLOAD_STREAMS = 4
/** The start of a transfer is TCP finding its speed, so it isn't counted: this long, or a quarter
 * of the time it took if that is shorter (a fast network can reach its data cap within seconds). */
export const WARM_UP_MS = 2_000
/** Live speeds are taken over this much of the latest samples. */
export const LIVE_WINDOW_MS = 1_000

/** The most a test may take on one network, each way, so the window can say it before it starts. */
export const MAX_BYTES_PER_NETWORK = DOWNLOAD_CAP_BYTES + UPLOAD_CAP_BYTES

/** One network's result. */
export interface SpeedTestLinkResult {
  networkId: string
  kind: NetworkInterfaceKind
  /** The system's name for it (the network list's displayName, as NetworkEvent's osName), kept
   * because the network may be gone later. The window shows the user's name for it over this. */
  name: string
  status: SpeedTestStatus
  /** Why it failed or couldn't run, in plain words. */
  reason?: string
  /** Median time to the first byte of an empty response, less the server's own time. */
  latencyMs?: number
  /** The mean difference between one latency sample and the next. */
  jitterMs?: number
  latencySamples: number
  downloadBytesPerSec?: number
  uploadBytesPerSec?: number
  /** What the test took and sent on it, counted against its data limit. */
  bytesDown: number
  bytesUp: number
}

/** All the networks together: a `combined` or `system` test. */
export interface SpeedTestCombined {
  downloadBytesPerSec?: number
  uploadBytesPerSec?: number
  latencyMs?: number
  jitterMs?: number
  /** The bytes each network carried during the download, by network id: measured on each tied
   * connection for `combined`, from the helper's counters for `system`. */
  share: Record<string, number>
}

export interface SpeedTestRun {
  id: string
  scope: SpeedTestScope
  /** The server's address, as https://host. */
  server: string
  startedAt: number
  finishedAt: number
  status: SpeedTestStatus
  reason?: string
  /** Each network's own result for `link`; for `combined` and `system`, the networks in the test
   * with their bytes. */
  links: SpeedTestLinkResult[]
  combined?: SpeedTestCombined
  notes: SpeedTestNote[]
}

/** What the window asks for. */
export interface SpeedTestRequest {
  scope: SpeedTestScope
  /** The networks to test, by id; ignored for `system`, which the helper routes. */
  networkIds: string[]
}

/** A test in progress, as the window shows it. */
export interface SpeedTestLive {
  runId: string
  scope: SpeedTestScope
  startedAt: number
  /** The networks, in the order they're tested. */
  networkIds: string[]
  /** The network being measured now; unset for `combined` and `system`. */
  networkId?: string
  phase: SpeedTestPhase
  /** How far this phase is, 0 to 1. */
  fraction: number
  /** The speed over the last second, in the current phase's direction. */
  bytesPerSec: number
  /** The fastest of those so far in this test, so the window's dial only ever grows its scale. */
  peakBytesPerSec: number
  /** Latency samples so far, while phase is latency. */
  latencyMs?: number
  /** Networks finished so far (`link`). */
  results: SpeedTestLinkResult[]
  /** The bytes each network carried so far (`combined`, `system`). */
  share: Record<string, number>
  /** Whether Mergelane's downloads were paused for it. */
  pausedDownloads: number
}

/** A point on a transfer's timeline: the bytes moved so far, `at` ms into it. */
export interface TransferSample {
  at: number
  bytes: number
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The mean absolute difference between consecutive samples, as Cloudflare's speed test describes
 * jitter ("the average distance between consecutive latency measurements"). Needs two. */
export function jitter(samples: readonly number[]): number | undefined {
  if (samples.length < 2) return undefined
  let sum = 0
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1])
  return sum / (samples.length - 1)
}

/** The server's own time in a Server-Timing header (W3C Server Timing: comma-separated metrics,
 * each `name;dur=<ms>`): Cloudflare's `cfRequestDuration` if it's there, else the first metric with
 * a duration. 0 when there's none, or it isn't a number. */
export function serverTimeMs(header: string | string[] | undefined): number {
  const text = Array.isArray(header) ? header.join(',') : header
  if (!text) return 0
  let first: number | undefined
  for (const metric of text.split(',')) {
    const [name, ...params] = metric.split(';').map((part) => part.trim())
    for (const param of params) {
      const match = /^dur\s*=\s*"?([0-9.]+)"?$/i.exec(param)
      const value = match ? Number(match[1]) : NaN
      if (!Number.isFinite(value)) continue
      if (name === 'cfRequestDuration') return value
      first ??= value
    }
  }
  return first ?? 0
}

/** One latency sample: the time to the first byte, less the server's own time, never below 0. */
export function latencySample(firstByteMs: number, serverMs: number): number {
  return Math.max(0, firstByteMs - (serverMs < firstByteMs ? serverMs : 0))
}

/** The speed after warm-up: the bytes moved from the end of the warm-up to the last sample, over
 * that time. Undefined when nothing was measured past the warm-up. */
export function steadyRate(samples: readonly TransferSample[]): number | undefined {
  if (samples.length < 2) return undefined
  const end = samples[samples.length - 1]
  const warmUp = Math.min(WARM_UP_MS, end.at / 4)
  const start = samples.find((sample) => sample.at >= warmUp) ?? samples[0]
  const span = end.at - start.at
  if (!(span > 0)) return undefined
  return ((end.bytes - start.bytes) * 1000) / span
}

/** One answered upload request: `bytes` sent between `start` and `end`, ms into the transfer. */
export interface TimedRequest {
  start: number
  end: number
  bytes: number
}

/**
 * An upload's timeline from its answered requests, at each of `times` up to `until` (and at
 * `until` itself). A request's bytes are spread evenly over the time it took, the best estimate of
 * when they crossed the network: counting them all when the answer came would put a request that
 * started during the warm-up wholly after it, and overstate a slow uplink. `until` should be the
 * last moment every connection's bytes are known: the earliest of the connections' last answers.
 */
export function spreadTimeline(
  requests: readonly TimedRequest[],
  times: readonly number[],
  until: number
): TransferSample[] {
  const at = [...times.filter((time) => time < until), until]
  return at.map((time) => ({
    at: time,
    bytes: requests.reduce((sum, request) => {
      const span = request.end - request.start
      const share = span > 0 ? (time - request.start) / span : time >= request.end ? 1 : 0
      return sum + request.bytes * Math.min(1, Math.max(0, share))
    }, 0)
  }))
}

/** The speed over the last LIVE_WINDOW_MS of samples (all of them, early on). */
export function liveRate(samples: readonly TransferSample[]): number {
  if (samples.length < 2) return 0
  const end = samples[samples.length - 1]
  let start = samples[0]
  for (let i = samples.length - 2; i >= 0; i--) {
    start = samples[i]
    if (end.at - samples[i].at >= LIVE_WINDOW_MS) break
  }
  const span = end.at - start.at
  return span > 0 ? Math.max(0, ((end.bytes - start.bytes) * 1000) / span) : 0
}

/** Which of the finished networks stand out. Each badge needs two finished networks to compare,
 * and goes to one network only (the first, on a tie). */
export interface SpeedTestStandouts {
  fastest?: string
  slowest?: string
  /** Lowest jitter. */
  steadiest?: string
}

export function standouts(results: readonly SpeedTestLinkResult[]): SpeedTestStandouts {
  const done = results.filter(
    (result) => result.status === 'done' && result.downloadBytesPerSec !== undefined
  )
  if (done.length < 2) return {}
  const by = (
    pick: (result: SpeedTestLinkResult) => number | undefined,
    lowest: boolean
  ): string | undefined => {
    let best: SpeedTestLinkResult | undefined
    for (const result of done) {
      const value = pick(result)
      if (value === undefined) continue
      const current = best && pick(best)
      if (current === undefined || (lowest ? value < current : value > current)) best = result
    }
    return best?.networkId
  }
  const out: SpeedTestStandouts = {
    fastest: by((result) => result.downloadBytesPerSec, false),
    slowest: by((result) => result.downloadBytesPerSec, true)
  }
  const withJitter = done.filter((result) => result.jitterMs !== undefined)
  if (withJitter.length >= 2) out.steadiest = by((result) => result.jitterMs, true)
  if (out.fastest === out.slowest) delete out.slowest
  return out
}

/** The server as the test's base address: an http(s) URL with no path, query or credentials, or
 * undefined when `input` isn't one. */
export function speedTestServer(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password) return undefined
  return `${url.protocol}//${url.host}`
}

export function downloadUrl(server: string, bytes: number): URL {
  return new URL(`/__down?bytes=${Math.max(0, Math.floor(bytes))}`, server)
}

export function uploadUrl(server: string): URL {
  return new URL('/__up', server)
}

/** The next request's size: twice the last if it finished within `target` ms, up to `max`. Small
 * at first so a slow network isn't stuck in one long request at the deadline. */
export function nextRequestBytes(
  last: number,
  tookMs: number,
  { min, max, target }: { min: number; max: number; target: number }
): number {
  if (!(last >= min)) return min
  return tookMs < target ? Math.min(max, last * 2) : last
}

// speed-tests.json

/** The most runs kept; older ones drop off the end. */
export const SPEED_TESTS_KEPT = 200
/** And none older than 90 days. */
export const SPEED_TESTS_MAX_AGE_MS = 90 * 24 * 60 * 60_000

const SCOPES: readonly SpeedTestScope[] = ['link', 'combined', 'system']
const STATUSES: readonly SpeedTestStatus[] = ['done', 'failed', 'cancelled', 'unavailable']
const NOTES: readonly SpeedTestNote[] = [
  'downloads-paused',
  'busy-network',
  'sticky-sites-on',
  'speed-limit'
]
const KINDS: readonly NetworkInterfaceKind[] = ['wifi', 'usb', 'ethernet', 'bridge', 'other']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const optionalSize = (value: unknown): number | undefined => (isSize(value) ? value : undefined)
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function sanitizeLink(value: unknown): SpeedTestLinkResult | undefined {
  if (!isRecord(value)) return undefined
  const { networkId, kind, name, status } = value
  if (!isText(networkId) || !isText(name)) return undefined
  if (!KINDS.includes(kind as NetworkInterfaceKind)) return undefined
  if (!STATUSES.includes(status as SpeedTestStatus)) return undefined
  const result: SpeedTestLinkResult = {
    networkId,
    kind: kind as NetworkInterfaceKind,
    name,
    status: status as SpeedTestStatus,
    latencySamples: isSize(value.latencySamples) ? Math.floor(value.latencySamples) : 0,
    bytesDown: isSize(value.bytesDown) ? value.bytesDown : 0,
    bytesUp: isSize(value.bytesUp) ? value.bytesUp : 0
  }
  if (isText(value.reason)) result.reason = value.reason
  for (const key of [
    'latencyMs',
    'jitterMs',
    'downloadBytesPerSec',
    'uploadBytesPerSec'
  ] as const) {
    const size = optionalSize(value[key])
    if (size !== undefined) result[key] = size
  }
  return result
}

function sanitizeCombined(value: unknown): SpeedTestCombined | undefined {
  if (!isRecord(value)) return undefined
  const share: Record<string, number> = {}
  if (isRecord(value.share)) {
    for (const [id, bytes] of Object.entries(value.share)) if (isSize(bytes)) share[id] = bytes
  }
  const combined: SpeedTestCombined = { share }
  for (const key of [
    'downloadBytesPerSec',
    'uploadBytesPerSec',
    'latencyMs',
    'jitterMs'
  ] as const) {
    const size = optionalSize(value[key])
    if (size !== undefined) combined[key] = size
  }
  return combined
}

/** One saved run, checked field by field; undefined when it can't be read. */
export function sanitizeSpeedTestRun(value: unknown): SpeedTestRun | undefined {
  if (!isRecord(value)) return undefined
  const { id, scope, server, startedAt, finishedAt, status } = value
  if (!isText(id) || !isText(server)) return undefined
  if (!SCOPES.includes(scope as SpeedTestScope)) return undefined
  if (!STATUSES.includes(status as SpeedTestStatus)) return undefined
  if (!isSize(startedAt) || !isSize(finishedAt)) return undefined
  const links = Array.isArray(value.links)
    ? value.links.map(sanitizeLink).filter((link) => link !== undefined)
    : []
  const run: SpeedTestRun = {
    id,
    scope: scope as SpeedTestScope,
    server,
    startedAt,
    finishedAt,
    status: status as SpeedTestStatus,
    links,
    notes: Array.isArray(value.notes)
      ? [...new Set(value.notes.filter((note) => NOTES.includes(note as SpeedTestNote)))]
      : []
  }
  if (isText(value.reason)) run.reason = value.reason
  const combined = sanitizeCombined(value.combined)
  if (combined) run.combined = combined
  return run
}

/** speed-tests.json's runs, newest first, read leniently: runs that can't be read are dropped. */
export function sanitizeSpeedTests(value: unknown, now: number): SpeedTestRun[] {
  const runs = isRecord(value) && Array.isArray(value.runs) ? value.runs : []
  return pruneSpeedTests(
    runs.map(sanitizeSpeedTestRun).filter((run) => run !== undefined),
    now
  )
}

/** Newest first, at most SPEED_TESTS_KEPT, none older than SPEED_TESTS_MAX_AGE_MS. */
export function pruneSpeedTests(runs: readonly SpeedTestRun[], now: number): SpeedTestRun[] {
  return [...runs]
    .filter((run) => run.startedAt > now - SPEED_TESTS_MAX_AGE_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, SPEED_TESTS_KEPT)
}
