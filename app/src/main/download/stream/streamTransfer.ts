import type { IncomingMessage } from 'node:http'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type {
  DownloadStatus,
  HttpDownloadNetwork,
  HttpStreamState,
  StreamSegmentState
} from '../../../shared/types'
import {
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  HlsError,
  HlsLimitError,
  HlsUnsupportedError,
  downloadHlsTrack,
  type HlsFetch,
  type HlsFetchResponse,
  type HlsProgress,
  type HlsRange
} from '../../media/hls'
import {
  MuxError,
  TEMP_SUFFIX,
  containerForCodecs,
  muxVideoAudio,
  remux,
  type ToolResolution
} from '../../media/mux'
import { ConnectionError, NoCompatibleRouteError, StreamConnection } from '../../network/routes'
import { advanceBlock, retractBlock } from '../blockProgress'
import { requestHeaders } from '../browserContext'
import {
  clearSpeeds,
  delay,
  recomputeAggregates,
  type StreamTransferTarget,
  type Transfer,
  type TransferHost
} from '../transfer'
import {
  planTracks,
  resolveStream,
  sameShape,
  streamFileName,
  type PlannedTrack
} from './streamPlan'

/** How a stream download runs, from the manager (and the tests). */
export interface StreamTransferOptions {
  /** Finds FFmpeg (see resolveToolPath). */
  ffmpeg: () => Promise<ToolResolution>
  /** How long a request may wait for its answer, and an answer may go silent. */
  timeoutMs: number
  /** How long opening a connection may take. */
  connectTimeoutMs: number
  /** Segment requests per network, per track, at once. */
  streamsPerNetwork: number
  /** Wait before a failed segment's first retry; doubled for each one after. */
  retryDelayMs?: number
}

/** Redirects a request follows, as the HLS module's own fetch does. */
const MAX_REDIRECTS = 10
const REDIRECTS = new Set([301, 302, 303, 307, 308])
/** How often a request with no network to go over looks again (or sooner, when one changes). */
const NETWORK_POLL_MS = 1000
/** Segment requests a track runs at once, at most, whatever the networks. */
const MAX_CONCURRENCY = 32
/** Extra attempts at a manifest whose connection failed, as the segment downloader makes for a
 * segment (see DEFAULT_RETRIES). */
const MANIFEST_RETRIES = DEFAULT_RETRIES
/** The meter of a manifest's request: it counts towards its network's speed only. */
const MANIFEST_CONNECTION = -1

/** Outputs FFmpeg is writing right now, in this process: their temporary files aren't stale. */
const muxing = new Set<string>()

/** `<output>.<8 hex>.mergelane-mux`, as the mux module names its temporary files (see runJob). */
const MUX_LEFTOVER = new RegExp(`^(.+)\\.[0-9a-f]{8}${TEMP_SUFFIX.replace('.', '\\.')}$`)

/**
 * Deletes what an FFmpeg run killed mid-write (a crash, a power cut) left in `directory`: its
 * temporary `*.mergelane-mux` files. Not one that a run in this process is still writing.
 */
export async function sweepMuxLeftovers(directory: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  for (const name of names) {
    const match = MUX_LEFTOVER.exec(name)
    if (!match || muxing.has(join(directory, match[1]))) continue
    await rm(join(directory, name), { force: true }).catch(() => {})
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** `path`, or the first `name (N).ext` beside it, that is free: no file there, and no other
 * download's staging folder claiming it. `ours` is this download's own claimed path. */
export async function freeOutputPath(path: string, ours: string): Promise<string> {
  const extension = extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let counter = 0; counter < 10_000; counter++) {
    const candidate = counter === 0 ? path : `${stem} (${counter})${extension}`
    if (await exists(candidate)) continue
    if (candidate !== ours && (await exists(`${candidate}.mergelane`))) continue
    return candidate
  }
  throw new Error('Mergelane couldn’t find an unused file name for this video.')
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function flatten(headers: IncomingMessage['headers']): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return flat
}

function contentLength(response: IncomingMessage): number | undefined {
  const value = response.headers['content-length']
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

const keyOf = (url: string, range: HlsRange | undefined): string =>
  range ? `${url}\n${range.start}-${range.end}` : url

/** One request in flight. */
interface Request {
  networkId: string
  /** The connection row it shows as; none for a manifest. */
  stream?: HttpStreamState
  /** The segment it fetches; none for a manifest. */
  block?: StreamSegmentState
}

/**
 * Fetches an HLS or DASH video, then joins it into one file with FFmpeg.
 *
 * Its tracks are downloaded by one segment downloader, the HLS module's downloadHlsTrack (a DASH
 * track goes in as the Media Playlist it amounts to, see dashTrackPlaylist), each into the
 * download's staging folder with its resume record, so a pause or a crash costs only the segments
 * in flight. Every request goes out through the fetch this transfer gives it: over one of the
 * networks the user has on — the one with the fewest requests in flight, a network whose requests
 * keep failing only when no other is there — through that network's own connection (see
 * StreamConnection), so the segments are spread over every network at once, as an HTTP download's
 * blocks are. Each request shows as a stream on its network, each segment as a block.
 *
 * Once every segment is in, FFmpeg combines the video and audio tracks (or rewraps the one track)
 * into the destination, in MP4 when the codecs fit it and Matroska when not (see
 * containerForCodecs).
 */
export class StreamTransfer implements Transfer {
  /** The current run's work, from fetching the manifest to the joined file. */
  private pipeline: Promise<void> | null = null
  private controller: AbortController | null = null
  /** By network id: its kept-alive connection. */
  private connections = new Map<string, StreamConnection>()
  /** By network id: requests in flight over it. */
  private inFlight = new Map<string, number>()
  /** By network id: requests over it that failed since one last got through. */
  private failures = new Map<string, number>()
  /** By network id: when it was last picked, on a counter, so ties go round. */
  private picked = new Map<string, number>()
  private clock = 0
  /** Requests waiting for a network to send them over. */
  private waiters = new Set<() => void>()
  /** Streams carrying a request now, by id. */
  private busy = new Set<number>()
  /** Blocks a request is fetching now, by index. */
  private fetching = new Set<number>()
  /** Each track's latest size estimate, by role (see HlsProgress). */
  private estimates = new Map<string, number | null>()

  constructor(
    private readonly runtime: StreamTransferTarget,
    private readonly host: TransferHost,
    private readonly options: StreamTransferOptions
  ) {}

  reconcile(): void {
    this.notify()
    const { state } = this.runtime
    if (this.pipeline || state.status !== 'downloading' || this.runtime.stop.signal.aborted) return
    const controller = new AbortController()
    this.controller = controller
    const pipeline = this.run(controller.signal).finally(() => {
      if (this.pipeline === pipeline) this.pipeline = null
    })
    this.pipeline = pipeline
    this.host.scheduleUpdate()
  }

  tick(): void {
    this.host.reconcile()
  }

  running(): Iterable<Promise<void>> {
    return this.pipeline ? [this.pipeline] : []
  }

  abort(): void {
    this.controller?.abort()
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    this.notify()
  }

  reset(): void {
    this.failures.clear()
    this.picked.clear()
  }

  wake(pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void {
    for (const [id, connection] of this.connections) {
      if (!pick(id)) continue
      this.failures.delete(id)
      if (reconnect(id)) connection.reconnect()
    }
    this.notify()
  }

  systemResumed(): void {
    this.wake(
      () => true,
      () => true
    )
  }

  private stopped(signal: AbortSignal): boolean {
    return signal.aborted || (this.runtime.state.status as DownloadStatus) !== 'downloading'
  }

  // ---- The run --------------------------------------------------------------------------------

  /** Fetches what's missing and joins it. Never rejects: what goes wrong fails the download. */
  private async run(signal: AbortSignal): Promise<void> {
    const { state, file } = this.runtime
    let finished = false
    try {
      await sweepMuxLeftovers(dirname(state.destinationPath))
      // Joined in an earlier run that was stopped before it was published.
      if (file.output !== null && (await exists(file.output))) {
        this.completeBlocks(0, state.totalBlocks)
        finished = true
        return
      }
      const ffmpeg = await this.options.ffmpeg()
      if (ffmpeg.path === null) {
        this.host.failDownload(
          `Mergelane needs FFmpeg to put this video together, and couldn’t find it. ${ffmpeg.reason}`
        )
        return
      }
      signal.throwIfAborted()

      const roles = state.trackSegments.map((_, index) => (index === 0 ? 'video' : 'audio'))
      const present = await Promise.all(roles.map((role) => exists(file.trackPath(role))))
      if (present.every(Boolean)) {
        this.completeBlocks(0, state.totalBlocks)
      } else {
        const resolved = await resolveStream(
          this.runtime.requestPayload.url,
          state.protocol,
          this.runtime.requestPayload.variantId,
          { fetch: this.fetchFor(null), signal }
        )
        const tracks = planTracks(resolved.tracks)
        if (!sameShape(tracks, state.trackSegments)) {
          this.host.failDownload(
            'This video changed on the server since its download started. Start it again.',
            true
          )
          return
        }
        const bytes = await this.downloadTracks(tracks, signal)
        recomputeAggregates(state, this.runtime.blocks)
        state.totalBytes = bytes
        state.bytesDownloaded = bytes
      }
      signal.throwIfAborted()

      state.muxing = true
      clearSpeeds(state)
      this.host.scheduleUpdate()
      const output = await this.mux(ffmpeg.path, roles.length > 1, signal)
      file.output = output
      state.destinationPath = output
      state.fileName = basename(output)
      finished = true
    } catch (error) {
      // Paused, cancelled or failed elsewhere: whatever stopped it says why.
      if (this.stopped(signal)) return
      if (error instanceof MuxError && error.detail)
        console.error('[mergelane] FFmpeg', error.detail)
      this.host.failDownload(message(error))
    } finally {
      state.muxing = undefined
      for (const stream of state.streams) {
        if (stream.status !== 'completed') {
          stream.status = finished
            ? 'completed'
            : state.status === 'paused'
              ? 'paused'
              : 'cancelled'
        }
        stream.currentBlockIndex = undefined
        stream.speedBytesPerSec = 0
      }
      this.host.scheduleUpdate()
    }
  }

  /** Downloads every track at once, each into its own file; resolves with their bytes. One that
   * fails stops the others, and its error is what the download fails with. */
  private async downloadTracks(
    tracks: readonly PlannedTrack[],
    signal: AbortSignal
  ): Promise<number> {
    const failure = new AbortController()
    const both = AbortSignal.any([signal, failure.signal])
    this.estimates.clear()
    const outcomes = await Promise.allSettled(
      tracks.map((track) =>
        this.downloadTrack(track, both).catch((error: unknown) => {
          failure.abort(error)
          throw error
        })
      )
    )
    signal.throwIfAborted()
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failed) throw (failed as PromiseRejectedResult).reason
    return outcomes.reduce(
      (sum, outcome) => sum + (outcome as PromiseFulfilledResult<number>).value,
      0
    )
  }

  private async downloadTrack(track: PlannedTrack, signal: AbortSignal): Promise<number> {
    const { file } = this.runtime
    const output = file.trackPath(track.role)
    // Joined already, by a run that stopped before the other track was.
    const done = await stat(output).catch(() => null)
    if (done?.isFile()) {
      this.estimates.set(track.role, done.size)
      this.completeBlocks(track.first, track.requests.length)
      return done.size
    }
    const networks = this.runtime.state.networks.filter((network) => network.enabled).length
    const result = await downloadHlsTrack({
      playlist: track.playlist,
      outputPath: output,
      workDirectory: file.workDirectory(track.role),
      fetch: this.fetchFor(track),
      concurrency: Math.min(
        MAX_CONCURRENCY,
        this.options.streamsPerNetwork * Math.max(1, networks)
      ),
      retries: DEFAULT_RETRIES,
      ...(this.options.retryDelayMs !== undefined && { retryDelayMs: this.options.retryDelayMs }),
      signal,
      onProgress: (progress) => this.onProgress(track.role, progress)
    })
    // Segments an earlier run had finished weren't fetched again: they're in all the same.
    this.completeBlocks(track.first, track.requests.length)
    return result.bytes
  }

  /** The size estimate, once every track has one (see HlsProgress.bytesTotalEstimate). */
  private onProgress(role: string, progress: HlsProgress): void {
    this.estimates.set(role, progress.bytesTotalEstimate)
    const { state } = this.runtime
    const estimates = [...this.estimates.values()]
    const known =
      estimates.length === state.trackSegments.length && estimates.every((value) => value !== null)
    const total = known ? estimates.reduce<number>((sum, value) => sum + value!, 0) : 0
    const next = total > 0 ? Math.max(total, state.bytesDownloaded) : 0
    if (next !== state.totalBytes) {
      state.totalBytes = next
      this.host.scheduleUpdate()
    }
  }

  /** Marks `count` blocks from `first` in: those an earlier run finished weren't fetched again. A
   * block whose size was never seen counts as what it showed. */
  private completeBlocks(first: number, count: number): void {
    for (const block of this.runtime.blocks.slice(first, first + count)) {
      if (block.status === 'completed') continue
      block.status = 'completed'
      block.rangeEnd = block.rangeStart + block.bytesDownloaded - 1
    }
    this.host.scheduleUpdate()
  }

  /** Joins the tracks into the destination with FFmpeg: video and audio, or rewraps the one. */
  private async mux(ffmpeg: string, withAudio: boolean, signal: AbortSignal): Promise<string> {
    const { state, file } = this.runtime
    const container = containerForCodecs(state.codecs)
    const directory = dirname(state.destinationPath)
    // The name was claimed with its container's extension; the same codecs give the same one, and
    // a file someone else has put there since is never replaced.
    const output = await freeOutputPath(
      join(directory, streamFileName(basename(state.destinationPath), container)),
      state.destinationPath
    )
    const duration =
      state.durationSeconds !== undefined && state.durationSeconds > 0
        ? { duration: state.durationSeconds }
        : {}
    const common = {
      ffmpeg,
      output,
      container: 'auto' as const,
      codecs: state.codecs,
      signal,
      ...duration
    }
    muxing.add(output)
    try {
      const result = withAudio
        ? await muxVideoAudio({
            ...common,
            video: file.trackPath('video'),
            audio: file.trackPath('audio')
          })
        : await remux({ ...common, input: file.trackPath('video') })
      return result.output
    } finally {
      muxing.delete(output)
    }
  }

  // ---- Requests -------------------------------------------------------------------------------

  /** The fetch the segment downloader and the manifest reader go through: every request over one
   * of the download's networks. `track`: the track whose segments it fetches; null for
   * manifests. */
  private fetchFor(track: PlannedTrack | null): HlsFetch {
    const lookup = new Map<string, number[]>()
    for (const request of track?.requests ?? []) {
      const key = keyOf(request.uri, request.range)
      lookup.set(key, [...(lookup.get(key) ?? []), track!.first + request.index])
    }
    return async (url, init) => {
      const signal = init.signal ?? this.controller?.signal ?? new AbortController().signal
      for (let attempt = 0; ; attempt++) {
        const networkId = await this.pickNetwork(signal)
        const request: Request = { networkId }
        if (track) {
          request.block = this.claimBlock(lookup.get(keyOf(url, init.range)), init.range, networkId)
          request.stream = this.claimStream(networkId, request.block)
        }
        let response: { message: IncomingMessage; url: string }
        try {
          response = await this.send(networkId, url, init.range, signal)
        } catch (error) {
          this.ended(request, false, signal)
          if (error instanceof NoCompatibleRouteError) {
            this.host.failNetwork(this.network(networkId), error.message)
          }
          // The segment downloader tries a segment again itself; a manifest goes again here,
          // over another network if one is doing better.
          if (track || attempt >= MANIFEST_RETRIES || this.stopped(signal)) throw error
          if (error instanceof HlsError) throw error
          await delay((this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * 2 ** attempt, signal)
          continue
        }
        const answer: HlsFetchResponse = {
          status: response.message.statusCode ?? 0,
          url: response.url,
          headers: flatten(response.message.headers),
          body: this.meteredBody(response.message, request, init.range, signal)
        }
        return answer
      }
    }
  }

  /** The network to send a request over: of those on, the one with the fewest requests in flight,
   * one whose requests keep failing only if no other is on. Waits for one when none is. */
  private async pickNetwork(signal: AbortSignal): Promise<string> {
    for (;;) {
      signal.throwIfAborted()
      const usable = this.runtime.state.networks.filter((network) => network.status === 'on')
      if (usable.length > 0) {
        const rank = (network: HttpDownloadNetwork): number[] => [
          (this.failures.get(network.id) ?? 0) > 0 ? 1 : 0,
          this.inFlight.get(network.id) ?? 0,
          this.picked.get(network.id) ?? 0
        ]
        const [best] = usable.sort((a, b) => {
          const [x, y] = [rank(a), rank(b)]
          return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
        })
        this.inFlight.set(best.id, (this.inFlight.get(best.id) ?? 0) + 1)
        this.picked.set(best.id, ++this.clock)
        return best.id
      }
      await this.networkChange(signal)
    }
  }

  /** Settles when a network may have come back (see notify), or after NETWORK_POLL_MS. */
  private networkChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(done)
        resolve()
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        reject(signal.reason)
      }
      const timer = setTimeout(done, NETWORK_POLL_MS)
      this.waiters.add(done)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  private network(id: string): HttpDownloadNetwork {
    const network = this.runtime.state.networks.find((entry) => entry.id === id)
    if (!network) throw new Error(`Unknown network ${id}`)
    return network
  }

  private connection(networkId: string): StreamConnection {
    let connection = this.connections.get(networkId)
    if (!connection) {
      connection = new StreamConnection(() => this.host.networks.find(networkId), {
        timeoutMs: this.options.timeoutMs,
        connectTimeoutMs: this.options.connectTimeoutMs,
        proxy: () => this.host.getProxyForInterface?.(networkId)
      })
      this.connections.set(networkId, connection)
    }
    return connection
  }

  /** Sends one GET over `networkId`, following redirects. The browser's headers are worked out for
   * every hop, so a cookie only goes where the browser itself would send it. */
  private async send(
    networkId: string,
    url: string,
    range: HlsRange | undefined,
    signal: AbortSignal
  ): Promise<{ message: IncomingMessage; url: string }> {
    const { browser } = this.runtime.requestPayload
    let current = url
    for (let redirects = 0; ; redirects++) {
      const target = new URL(current)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new HlsUnsupportedError(
          `Mergelane can't download from ${target.protocol} addresses, only http and https.`
        )
      }
      const headers: Record<string, string> = {
        'Accept-Encoding': 'identity',
        ...requestHeaders(target, browser),
        ...(range && { Range: `bytes=${range.start}-${range.end}` })
      }
      const { res } = await this.connection(networkId).request(target, headers, signal)
      const location = res.headers.location
      if (!REDIRECTS.has(res.statusCode ?? 0) || !location) return { message: res, url: current }
      res.resume()
      if (redirects >= MAX_REDIRECTS) {
        throw new HlsLimitError(
          'redirects',
          `The server redirected more than ${MAX_REDIRECTS} times, so Mergelane stopped following it.`
        )
      }
      current = new URL(location, target).href
    }
  }

  /** The block a segment request is for: of those with its URL and range, one no request holds,
   * not yet in if there is one. Fetched again, a block starts over. */
  private claimBlock(
    indexes: number[] | undefined,
    range: HlsRange | undefined,
    networkId: string
  ): StreamSegmentState | undefined {
    const free = (indexes ?? []).filter((index) => !this.fetching.has(index))
    const index =
      free.find((candidate) => this.runtime.blocks[candidate].status !== 'completed') ?? free[0]
    if (index === undefined) return undefined
    const block = this.runtime.blocks[index]
    this.fetching.add(index)
    this.restart(block, networkId)
    block.status = 'downloading'
    block.interfaceId = networkId
    block.rangeEnd = range ? range.end - range.start : null
    return block
  }

  /** Back to nothing, for a block whose bytes aren't kept: its request failed, or it's fetched
   * again. */
  private restart(block: StreamSegmentState, networkId: string): void {
    if (retractBlock(block, 0, networkId) > 0) {
      recomputeAggregates(this.runtime.state, this.runtime.blocks)
    }
    block.status = 'pending'
  }

  /** An idle stream of `networkId` to show the request as, or a new one. */
  private claimStream(networkId: string, block: StreamSegmentState | undefined): HttpStreamState {
    const { state } = this.runtime
    let stream = state.streams.find(
      (candidate) => candidate.interfaceId === networkId && !this.busy.has(candidate.id)
    )
    if (!stream) {
      stream = {
        id: Math.max(-1, ...state.streams.map((other) => other.id)) + 1,
        interfaceId: networkId,
        rangeStart: 0,
        rangeEnd: null,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'pending'
      }
      state.streams.push(stream)
      state.peakStreams = Math.max(state.peakStreams, state.streams.length)
    }
    this.busy.add(stream.id)
    stream.status = 'downloading'
    stream.currentBlockIndex = block?.index
    this.host.scheduleUpdate()
    return stream
  }

  /**
   * The response body as the segment downloader reads it, counted on the way: each chunk goes to
   * its network's meter and speed limit (see Limits.take) and moves its block on. A body that
   * goes silent for longer than the timeout is dropped, so the request is tried again; stopping
   * the download drops it at once. Read to its end, the segment is in.
   */
  private meteredBody(
    response: IncomingMessage,
    request: Request,
    range: HlsRange | undefined,
    signal: AbortSignal
  ): AsyncIterable<Uint8Array> {
    const source = response[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const expected = range ? range.end - range.start + 1 : contentLength(response)
    let received = 0
    let settled = false
    let ended = false
    const settle = (complete: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(stall)
      signal.removeEventListener('abort', onAbort)
      this.ended(request, complete, signal)
    }
    // Both also settle a body nobody reads: the segment downloader can fail before it starts
    // (its part file couldn't be opened), and the request must not stay in flight.
    const stall = setTimeout(() => {
      response.destroy(new ConnectionError(new Error('The server stopped sending.')))
      settle(false)
    }, this.options.timeoutMs)
    const onAbort = (): void => {
      response.destroy(signal.reason as Error)
      settle(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        if (settled) return { done: true, value: undefined }
        let result: IteratorResult<Buffer>
        try {
          result = await source.next()
        } catch (error) {
          settle(false)
          throw error
        }
        if (result.done) {
          ended = true
          settle(expected === undefined || received >= expected)
          return { done: true, value: undefined }
        }
        stall.refresh()
        const chunk = result.value
        received += chunk.byteLength
        this.received(request, chunk.byteLength, received)
        const wait = this.host.limits.take(request.networkId, chunk.byteLength)
        if (wait > 0) await delay(wait, signal)
        return { done: false, value: chunk }
      },
      return: async () => {
        // Stopped early: done when what was wanted is all here (the rest of a whole file sent for
        // a range isn't needed), failed otherwise.
        settle(expected !== undefined && received >= expected)
        if (!ended) response.destroy()
        return { done: true, value: undefined }
      }
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }

  /** `bytes` more came in for `request`, `total` in all. */
  private received(request: Request, bytes: number, total: number): void {
    const { state, meters } = this.runtime
    meters.add(request.stream?.id ?? MANIFEST_CONNECTION, request.networkId, bytes)
    const { block, stream } = request
    if (!block || !stream) return
    const gained = advanceBlock(block, request.networkId, total)
    if (gained === 0) return
    stream.bytesDownloaded += gained
    this.network(request.networkId).bytesDownloaded += gained
    state.bytesDownloaded += gained
    if (state.totalBytes > 0 && state.bytesDownloaded > state.totalBytes) {
      state.totalBytes = state.bytesDownloaded
    }
    this.host.scheduleUpdate()
  }

  /** A request is over: its segment is in (`complete`), or its bytes go and it waits for the
   * segment downloader's next try. */
  private ended(request: Request, complete: boolean, signal: AbortSignal): void {
    const { networkId, block, stream } = request
    this.inFlight.set(networkId, Math.max(0, (this.inFlight.get(networkId) ?? 0) - 1))
    if (complete) {
      this.failures.delete(networkId)
    } else if (!this.stopped(signal)) {
      this.failures.set(networkId, (this.failures.get(networkId) ?? 0) + 1)
      const network = this.runtime.state.networks.find((entry) => entry.id === networkId)
      if (network?.status === 'on') network.retries += 1
    }
    if (block) {
      this.fetching.delete(block.index)
      if (complete) {
        block.rangeEnd ??= block.rangeStart + block.bytesDownloaded - 1
        block.status = 'completed'
      } else {
        this.restart(block, networkId)
      }
    }
    if (stream) {
      this.busy.delete(stream.id)
      if (stream.status === 'downloading') stream.status = 'pending'
      stream.currentBlockIndex = undefined
    }
    this.host.scheduleUpdate()
    this.notify()
  }
}
