import { randomBytes } from 'node:crypto'
import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { performance } from 'node:perf_hooks'
import {
  downloadUrl,
  latencySample,
  liveRate,
  nextRequestBytes,
  serverTimeMs,
  spreadTimeline,
  uploadUrl,
  type TimedRequest,
  type TransferSample
} from '../../shared/speedTest'
import type { RequestBody, ResponseStart } from '../network/routes'

// How the speed test measures (docs/DECISIONS.md ADR-0064), over any connection: one tied to a
// network (routes.ts StreamConnection), or one tied to none (DirectConnection), which system merge's
// helper routes like any other app's. Free of Electron, so the e2e suite's Node side runs it against
// the local test server (e2e/speedTest.spec.ts).

/** What the test needs of a connection: StreamConnection is one. */
export interface Connection {
  request(
    target: URL,
    headers: Record<string, string>,
    signal?: AbortSignal,
    body?: RequestBody
  ): Promise<ResponseStart>
  close(): void
}

/** Asks for the bytes as they are: a compressed response would measure the wrong amount. */
const HEADERS = { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-store' }

function abortError(): Error {
  const error = new Error('The speed test was cancelled')
  error.name = 'AbortError'
  return error
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A connection tied to no network: the system routes it, through system merge's helper while that
 * is on. Kept alive like StreamConnection, so each stream pays for its handshakes once.
 */
export class DirectConnection implements Connection {
  private readonly http = new HttpAgent({ keepAlive: true })
  private readonly https = new HttpsAgent({ keepAlive: true })

  constructor(private readonly timeoutMs: number) {}

  request(
    target: URL,
    headers: Record<string, string>,
    signal?: AbortSignal,
    body?: RequestBody
  ): Promise<ResponseStart> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const secure = target.protocol === 'https:'
      const sentAt = Date.now()
      let answered = false
      const req = (secure ? httpsRequest : httpRequest)(
        target,
        {
          method: body ? 'POST' : 'GET',
          headers: body ? { ...headers, 'Content-Length': String(body.length) } : headers,
          agent: secure ? this.https : this.http,
          signal
        },
        (res) => {
          answered = true
          clearTimeout(timer)
          resolve({ req, res, sentAt })
        }
      )
      const stall = (): void =>
        void req.destroy(new Error('Connection stalled: no response from server'))
      let timer = setTimeout(stall, this.timeoutMs)
      let failed = false
      req.on('error', (error) => {
        failed = true
        clearTimeout(timer)
        if (!answered) reject(signal?.aborted ? abortError() : error)
      })
      if (!body) return void req.end()
      body.write(req, () => {
        if (answered || failed) return
        clearTimeout(timer)
        timer = setTimeout(stall, this.timeoutMs)
      })
    })
  }

  close(): void {
    this.http.destroy()
    this.https.destroy()
  }
}

/** Reads a response to its end, handing each piece to `onData`. Resolves when it ends or is
 * destroyed after `stop` said so; rejects on any other failure. */
function drain(
  start: ResponseStart,
  onData: (bytes: number) => void,
  stopped: () => boolean
): Promise<void> {
  const { res } = start
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error && !stopped()) reject(error)
      else resolve()
    }
    res.on('data', (chunk: Buffer) => onData(chunk.length))
    res.on('end', () => finish())
    res.on('error', (error) => finish(error))
    res.on('close', () =>
      finish(res.complete ? undefined : new Error('The connection closed before the reply ended'))
    )
  })
}

function checkStatus(start: ResponseStart): void {
  const status = start.res.statusCode ?? 0
  if (status < 200 || status >= 300) {
    start.res.resume()
    throw new Error(`The test server answered ${status}`)
  }
}

export interface LatencyOptions {
  server: string
  samples: number
  signal: AbortSignal
  /** Each sample as it's taken, in ms. */
  onSample?: (ms: number) => void
}

/**
 * Latency samples: empty responses one after another on one kept-alive connection. The first opens
 * the connection (DNS, TCP and TLS) and isn't counted. Each sample is the time to the first byte,
 * less the time the server says it spent (Server-Timing).
 */
export async function measureLatency(
  connection: Connection,
  { server, samples, signal, onSample }: LatencyOptions
): Promise<number[]> {
  const taken: number[] = []
  const ask = async (): Promise<number> => {
    const started = performance.now()
    const start = await connection.request(downloadUrl(server, 0), HEADERS, signal)
    const firstByte = performance.now() - started
    checkStatus(start)
    await drain(
      start,
      () => {},
      () => signal.aborted
    )
    return latencySample(firstByte, serverTimeMs(start.res.headers['server-timing']))
  }
  await ask()
  while (taken.length < samples) {
    if (signal.aborted) throw abortError()
    const ms = await ask()
    taken.push(ms)
    onSample?.(ms)
  }
  return taken
}

/** One network's (or the helper's) part in a transfer. */
export interface Lane {
  id: string
  connection: Connection
  /** Whether it can still be reached; a lane whose network is gone stops at once. */
  present: () => boolean
  /** Whether its network has used up its data limit; checked as the test goes. */
  limitReached?: () => boolean
}

export interface TransferOptions {
  direction: 'download' | 'upload'
  server: string
  lanes: Lane[]
  /** Connections each lane opens. */
  streams: number
  durationMs: number
  /** The most one lane may move; the transfer ends when any lane reaches it, so every sample
   * has every lane in it. */
  capBytes: number
  /** A lane that moves nothing for this long has failed. */
  stallMs: number
  signal: AbortSignal
  /** Each piece moved, for data limits: every one, including those that arrive after the end. */
  onBytes?: (laneId: string, bytes: number) => void
  /** Every tick (TICK_MS): the speed over the last second, how far the transfer is (0 to 1), and
   * each lane's bytes so far. */
  onTick?: (bytesPerSec: number, fraction: number, perLane: Record<string, number>) => void
}

export interface LaneOutcome {
  /** Bytes moved: received, or handed to the system to send. What the data limit counts. */
  bytes: number
  /** The measured timeline: bytes received (download), or bytes the server confirmed by answering
   * their request (upload). */
  samples: TransferSample[]
  error?: string
}

export interface TransferResult {
  /** The total's measured timeline. */
  samples: TransferSample[]
  lanes: Record<string, LaneOutcome>
}

export const TICK_MS = 100
const REQUEST = { min: 256 * 1024, max: 64 * 1024 * 1024, target: 1_000 }
/** Uploads start smaller: an upload counts only once answered, so a slow uplink needs requests
 * that finish within the test (64 KiB is about 2 s per connection at 0.25 Mbit/s). */
const UPLOAD_REQUEST = { ...REQUEST, min: 64 * 1024 }
const PIECE = 64 * 1024
/** One random piece, sent over and over: random so nothing on the way can compress it. */
let uploadPiece: Buffer | undefined

/** Errors a stream gets over in a row before its lane gives up: a server closing an idle
 * connection, or a reset, is retried on a new one. */
const RETRIES = 3

/**
 * Moves data on every lane at once, `streams` connections each, until the time is up, a lane
 * reaches the cap, or the test is cancelled. Requests start small and double while they finish
 * within a second, so a slow network isn't caught in one long request at the deadline.
 *
 * A download is measured as its bytes arrive. An upload is measured as the server answers each
 * request, which it does once it has the whole body, as Cloudflare's own test times its uploads:
 * Node's count of bytes handed to the system runs ahead of the network by the system's send
 * buffer, which on a slow uplink is seconds of data. That count still drives the live speed, which
 * would otherwise move in steps, and the data limit.
 */
export async function measureTransfer(options: TransferOptions): Promise<TransferResult> {
  const { lanes, streams, durationMs, capBytes, stallMs, signal, direction, server } = options
  const startedAt = performance.now()
  const elapsed = (): number => performance.now() - startedAt
  const stop = new AbortController()
  const stopSignal = AbortSignal.any([signal, stop.signal])
  const outcomes: Record<
    string,
    LaneOutcome & {
      measured: number
      lastByteAt: number
      failed: boolean
      /** Answered upload requests, and each connection's last answer (ms into the transfer). */
      requests: TimedRequest[]
      lastAnswer: number[]
    }
  > = {}
  for (const lane of lanes) {
    outcomes[lane.id] = {
      bytes: 0,
      measured: 0,
      samples: [{ at: 0, bytes: 0 }],
      lastByteAt: 0,
      failed: false,
      requests: [],
      lastAnswer: []
    }
  }
  const samples: TransferSample[] = [{ at: 0, bytes: 0 }]
  const moved: TransferSample[] = [{ at: 0, bytes: 0 }]
  let total = 0
  let totalMeasured = 0
  const over = (): boolean => stopSignal.aborted
  const end = (): void => {
    if (!stop.signal.aborted) stop.abort()
  }

  const add = (laneId: string, bytes: number): void => {
    // Counted for the data limit whatever happens next: these bytes crossed the network, even
    // after the deadline or on a lane that has failed.
    options.onBytes?.(laneId, bytes)
    const outcome = outcomes[laneId]
    if (over() || outcome.failed) return
    outcome.bytes += bytes
    outcome.lastByteAt = elapsed()
    total += bytes
    if (direction === 'download') measure(laneId, bytes)
    if (outcome.bytes >= capBytes) end()
  }

  const measure = (laneId: string, bytes: number): void => {
    const outcome = outcomes[laneId]
    if (over() || outcome.failed) return
    outcome.measured += bytes
    totalMeasured += bytes
  }

  const fail = (lane: Lane, error: string): void => {
    const outcome = outcomes[lane.id]
    if (outcome.failed) return
    outcome.failed = true
    outcome.error = error
    lane.connection.close()
    if (Object.values(outcomes).every((each) => each.failed)) end()
  }

  const tick = (): void => {
    const at = elapsed()
    samples.push({ at, bytes: totalMeasured })
    moved.push({ at, bytes: total })
    const perLane: Record<string, number> = {}
    for (const lane of lanes) {
      const outcome = outcomes[lane.id]
      outcome.samples.push({ at, bytes: outcome.measured })
      perLane[lane.id] = outcome.bytes
      if (outcome.failed || over()) continue
      if (!lane.present()) fail(lane, 'The network disconnected')
      else if (lane.limitReached?.()) fail(lane, 'Its data limit was reached')
      else if (at - outcome.lastByteAt > stallMs) fail(lane, 'The network stopped answering')
    }
    if (at >= durationMs) end()
    options.onTick?.(liveRate(moved), Math.min(1, at / durationMs), perLane)
  }
  const timer = setInterval(tick, TICK_MS)

  const download = async (lane: Lane, size: number): Promise<number> => {
    const asked = performance.now()
    const start = await lane.connection.request(downloadUrl(server, size), HEADERS, stopSignal)
    checkStatus(start)
    const unhook = (): void => void start.req.destroy()
    stopSignal.addEventListener('abort', unhook, { once: true })
    try {
      await drain(start, (bytes) => add(lane.id, bytes), over)
    } finally {
      stopSignal.removeEventListener('abort', unhook)
    }
    return performance.now() - asked
  }

  const upload = async (lane: Lane, size: number, streamIndex: number): Promise<number> => {
    uploadPiece ??= randomBytes(PIECE)
    const piece = uploadPiece
    const asked = performance.now()
    const body: RequestBody = {
      length: size,
      write: (req: ClientRequest, progress) => {
        let sent = 0
        const pump = (): void => {
          while (sent < size) {
            if (over()) return void req.destroy(abortError())
            const length = Math.min(PIECE, size - sent)
            sent += length
            const writable = req.write(piece.subarray(0, length), (error) => {
              // Called with an error when the request is destroyed: those bytes never went.
              if (error) return
              add(lane.id, length)
              progress()
            })
            if (!writable) return void req.once('drain', pump)
          }
          req.end()
        }
        pump()
      }
    }
    const start = await lane.connection.request(uploadUrl(server), HEADERS, stopSignal, body)
    checkStatus(start)
    await drain(start, () => {}, over)
    const outcome = outcomes[lane.id]
    if (!over() && !outcome.failed) {
      const end = elapsed()
      // An answer is the network moving too: on a slow uplink the body sits in the system's send
      // buffer, and nothing else happens between handing it over and the answer.
      outcome.lastByteAt = end
      outcome.requests.push({ start: asked - startedAt, end, bytes: size })
      outcome.lastAnswer[streamIndex] = end
      measure(lane.id, size)
    }
    return performance.now() - asked
  }

  const sizes = direction === 'download' ? REQUEST : UPLOAD_REQUEST
  const stream = async (lane: Lane, streamIndex: number): Promise<void> => {
    let size = sizes.min
    let errors = 0
    while (!over() && !outcomes[lane.id].failed) {
      try {
        const took = await (direction === 'download'
          ? download(lane, size)
          : upload(lane, size, streamIndex))
        size = nextRequestBytes(size, took, sizes)
        errors = 0
      } catch (error) {
        if (over() || outcomes[lane.id].failed) return
        if (!lane.present()) return fail(lane, 'The network disconnected')
        if (++errors >= RETRIES) return fail(lane, message(error))
        size = sizes.min
      }
    }
  }

  try {
    await Promise.all(
      lanes.flatMap((lane) => Array.from({ length: streams }, (_, index) => stream(lane, index)))
    )
  } finally {
    clearInterval(timer)
    end()
  }
  if (signal.aborted) throw abortError()
  tick()
  if (direction === 'download') {
    const result: TransferResult = { samples, lanes: {} }
    for (const lane of lanes) {
      const { bytes, samples: laneSamples, error } = outcomes[lane.id]
      result.lanes[lane.id] = { bytes, samples: laneSamples, ...(error ? { error } : {}) }
    }
    return result
  }
  // An upload's timeline comes from its answered requests, up to the last moment every connection
  // that answered at all is accounted for (shared/speedTest.ts spreadTimeline).
  const times = samples.map((sample) => sample.at)
  const knownUntil = (outcome: (typeof outcomes)[string]): number | undefined => {
    const answers = outcome.lastAnswer.filter((at) => at !== undefined)
    return answers.length === 0 ? undefined : Math.min(...answers)
  }
  const result: TransferResult = { samples: [{ at: 0, bytes: 0 }], lanes: {} }
  const known: number[] = []
  for (const lane of lanes) {
    const outcome = outcomes[lane.id]
    const until = knownUntil(outcome)
    // A lane that failed moved nothing after its last answer, so it doesn't cut the others short.
    if (until !== undefined && !outcome.failed) known.push(until)
    result.lanes[lane.id] = {
      bytes: outcome.bytes,
      samples:
        until === undefined
          ? [{ at: 0, bytes: 0 }]
          : spreadTimeline(outcome.requests, times, until),
      ...(outcome.error ? { error: outcome.error } : {})
    }
  }
  if (known.length > 0) {
    result.samples = spreadTimeline(
      Object.values(outcomes).flatMap((outcome) => outcome.requests),
      times,
      Math.min(...known)
    )
  }
  return result
}
