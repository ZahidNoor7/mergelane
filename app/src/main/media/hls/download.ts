// Logic adapted from Awesome Downloader core/hls.mjs and the runHls/assemble steps of
// core/engine.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane: byte ranges, init sections, an explicit resume record,
// progress estimates and an injectable fetch were added; see docs/UPSTREAM.md.
//
// Section numbers refer to RFC 8216, https://www.rfc-editor.org/rfc/rfc8216.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HlsError, HlsHttpError, HlsSegmentError } from './errors'
import {
  discardBody,
  nodeFetch,
  readBody,
  scopeHeaders,
  type HlsFetch,
  type HlsFetchResponse,
  type HlsRange
} from './http'
import { assertDownloadable, type ByteRange, type MediaPlaylist } from './parse'
import type { ResolvedHls } from './resolve'

/** Segments fetched at once per track. RFC 8216 §10 suggests "a reasonable number of concurrent
 * downloads (e.g., four)". */
export const DEFAULT_CONCURRENCY = 4
/** Extra attempts per segment after the first fails. */
export const DEFAULT_RETRIES = 3
/** Wait before the first retry; doubled for each one after. */
export const DEFAULT_RETRY_DELAY_MS = 500

/** One request of a track: the initialization section (if any) first, then every segment. */
export interface SegmentRequest {
  /** Position in the track's request list, and so in the output file. */
  index: number
  kind: 'init' | 'media'
  uri: string
  range?: HlsRange
  /** EXTINF seconds; 0 for the initialization section. */
  duration: number
}

/** Progress of one track. */
export interface HlsProgress {
  /** Bytes saved so far, including segments still arriving. */
  bytesDone: number
  /** Exact when every size is known (all byte ranges, or everything finished); otherwise
   * extrapolated from the bytes per second of finished segments; null before any is. */
  bytesTotalEstimate: number | null
  segmentsDone: number
  segmentsTotal: number
}

export interface DownloadTrackOptions {
  /** A finished Media Playlist (see {@link assertDownloadable}). */
  playlist: MediaPlaylist
  /** Where the track is saved. Written via a temporary file and a rename, replacing any file
   * there; the caller picks a free name. */
  outputPath: string
  /** Where segments wait until they are joined, with the resume record. Default
   * `<outputPath>.hls-parts`. Removed once the track is saved. */
  workDirectory?: string
  fetch?: HlsFetch
  /** Headers from the user's browser session, meant for `source`'s origin. */
  headers?: Record<string, string>
  /** The URL `headers` belong to: credentials are not sent to other origins. Default: the
   * playlist's URL. */
  source?: string
  /** Default {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number
  /** Default {@link DEFAULT_RETRIES}. */
  retries?: number
  /** Default {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number
  signal?: AbortSignal
  /** Called as bytes arrive and as segments finish. Called often: throttle in the caller. */
  onProgress?: (progress: HlsProgress) => void
}

export interface TrackResult {
  outputPath: string
  /** Size of the saved file. */
  bytes: number
  /** Requests in the track, the initialization section included. */
  segments: number
  /** Requests skipped because an earlier run had finished them. */
  resumedSegments: number
  /** {@link trackIdentity} of the track. */
  identity: string
}

function rangeOf(byteRange: ByteRange | undefined): { range?: HlsRange } {
  return byteRange
    ? { range: { start: byteRange.offset, end: byteRange.offset + byteRange.length - 1 } }
    : {}
}

/** What to fetch, in output order: the EXT-X-MAP initialization section first (§4.3.2.5), then
 * each segment, with its EXT-X-BYTERANGE as an HTTP range (§4.3.2.2). */
export function segmentRequests(playlist: MediaPlaylist): SegmentRequest[] {
  const requests: SegmentRequest[] = []
  const init = playlist.segments[0]?.init
  if (init) {
    requests.push({
      index: 0,
      kind: 'init',
      uri: init.uri,
      duration: 0,
      ...rangeOf(init.byteRange)
    })
  }
  for (const segment of playlist.segments) {
    requests.push({
      index: requests.length,
      kind: 'media',
      uri: segment.uri,
      duration: segment.duration,
      ...rangeOf(segment.byteRange)
    })
  }
  return requests
}

/** SHA-256 (hex) of the track's request list: URLs in order, with their byte ranges. A resume
 * record only applies to a track with the same identity. */
export function trackIdentity(requests: readonly SegmentRequest[]): string {
  const list = requests.map((request) =>
    request.range ? [request.uri, request.range.start, request.range.end] : [request.uri]
  )
  return createHash('sha256').update(JSON.stringify(list)).digest('hex')
}

const RECORD_FILE = 'resume.json'
const RECORD_VERSION = 1
const OWN_FILE = /^(\d+\.part(\.tmp)?|resume\.json(\.tmp)?)$/

const partName = (index: number): string => `${String(index).padStart(5, '0')}.part`

interface ResumeRecord {
  version: number
  identity: string
  segments: number
  /** Finished requests: index → size in bytes. */
  done: Record<string, unknown>
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readRecord(path: string): Promise<ResumeRecord | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  const record = parsed as Partial<ResumeRecord> | null
  if (
    record?.version !== RECORD_VERSION ||
    typeof record.identity !== 'string' ||
    typeof record.done !== 'object' ||
    record.done === null
  ) {
    return undefined
  }
  return record as ResumeRecord
}

/** Deletes this module's files in `directory` (never anything else, so a mistaken work directory
 * can't cost the user files). */
async function removeOwnFiles(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (OWN_FILE.test(name)) await rm(join(directory, name), { force: true })
  }
}

/** The resume record: which requests of the track are finished, saved next to their parts. A
 * part counts as finished only if the record lists it with the size it has on disk. */
class ResumeStore {
  private writing: Promise<void> | undefined
  private dirty = false

  private constructor(
    readonly directory: string,
    private readonly identity: string,
    private readonly count: number,
    readonly done: Map<number, number>
  ) {}

  static async open(directory: string, identity: string, count: number): Promise<ResumeStore> {
    await mkdir(directory, { recursive: true })
    const record = await readRecord(join(directory, RECORD_FILE))
    const done = new Map<number, number>()
    if (record?.identity === identity && record.segments === count) {
      for (const [key, size] of Object.entries(record.done)) {
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || index >= count) continue
        const onDisk = await sizeOf(join(directory, partName(index)))
        if (onDisk !== undefined && onDisk === size) done.set(index, onDisk)
      }
    } else {
      // Parts of another playlist, or left before any record was written: not trustworthy.
      await removeOwnFiles(directory)
    }
    const store = new ResumeStore(directory, identity, count, done)
    await store.save()
    return store
  }

  markDone(index: number, size: number): Promise<void> {
    this.done.set(index, size)
    return this.save()
  }

  /** Writes the record (temp file + rename, so a crash leaves the old or the new one). Saves
   * requested while one is being written are coalesced into one more write. */
  save(): Promise<void> {
    this.dirty = true
    this.writing ??= this.drain()
    return this.writing
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false
        const record: ResumeRecord = {
          version: RECORD_VERSION,
          identity: this.identity,
          segments: this.count,
          done: Object.fromEntries(this.done)
        }
        const path = join(this.directory, RECORD_FILE)
        await writeFile(`${path}.tmp`, JSON.stringify(record))
        await rename(`${path}.tmp`, path)
      }
    } finally {
      this.writing = undefined
    }
  }

  /** Removes the parts and the record, then the directory if nothing else is in it. */
  async finish(): Promise<void> {
    await removeOwnFiles(this.directory)
    await rmdir(this.directory).catch(() => {})
  }
}

/** Running totals behind {@link HlsProgress}. */
class Progress {
  private knownBytes = 0
  private unknownCount = 0
  private unknownDuration = 0
  private sampleBytes = 0
  private sampleDuration = 0
  private completedBytes = 0
  private completedCount = 0
  private readonly inFlight = new Map<number, number>()
  private readonly total: number

  constructor(requests: readonly SegmentRequest[], done: ReadonlyMap<number, number>) {
    this.total = requests.length
    for (const request of requests) {
      if (request.range) this.knownBytes += request.range.end - request.range.start + 1
      else {
        this.unknownCount++
        this.unknownDuration += request.duration
      }
      const size = done.get(request.index)
      if (size !== undefined) this.complete(request, size)
    }
  }

  receive(index: number, bytes: number): void {
    this.inFlight.set(index, bytes)
  }

  complete(request: SegmentRequest, size: number): void {
    this.inFlight.delete(request.index)
    this.completedBytes += size
    this.completedCount++
    if (!request.range) {
      this.unknownCount--
      this.unknownDuration -= request.duration
      this.knownBytes += size
    }
    if (request.kind === 'media') {
      this.sampleBytes += size
      this.sampleDuration += request.duration
    }
  }

  snapshot(): HlsProgress {
    let bytesDone = this.completedBytes
    for (const bytes of this.inFlight.values()) bytesDone += bytes
    let estimate: number | null = this.knownBytes
    if (this.unknownCount > 0) {
      estimate =
        this.sampleDuration > 0
          ? Math.round(
              this.knownBytes + (this.sampleBytes / this.sampleDuration) * this.unknownDuration
            )
          : null
    }
    return {
      bytesDone,
      bytesTotalEstimate: estimate === null ? null : Math.max(estimate, bytesDone),
      segmentsDone: this.completedCount,
      segmentsTotal: this.total
    }
  }
}

interface TrackContext {
  fetch: HlsFetch
  headers: Record<string, string>
  source: string
  directory: string
  /** The caller's signal combined with "a sibling segment failed for good". */
  signal: AbortSignal
  retries: number
  retryDelayMs: number
  progress: Progress
  report: () => void
}

function contentLength(response: HlsFetchResponse): number | undefined {
  const value = response.headers?.['content-length']
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

/** A 206 that names a Content-Range must name the range asked for. */
function rangeMatches(response: HlsFetchResponse, range: HlsRange): boolean {
  const value = response.headers?.['content-range']
  if (value === undefined) return true
  const match = /^bytes (\d+)-(\d+)\//.exec(value)
  return match !== null && Number(match[1]) === range.start && Number(match[2]) === range.end
}

/** One attempt at one request, saved as its part file. Resolves with its size. */
async function fetchOnce(context: TrackContext, request: SegmentRequest): Promise<number> {
  const { range } = request
  const response = await context.fetch(request.uri, {
    headers: scopeHeaders(context.headers, context.source, request.uri),
    signal: context.signal,
    ...(range ? { range } : {})
  })
  // A server may ignore Range and answer 200 with the whole resource (RFC 9110 §14.2); then the
  // sub-range is cut out of it here.
  const sliced = range !== undefined && response.status === 200
  if (range && response.status === 206 && !rangeMatches(response, range)) {
    await discardBody(response.body)
    throw new Error('the server sent a different byte range than the one asked for')
  }
  if (response.status !== 200 && !(range && response.status === 206)) {
    await discardBody(response.body)
    throw new HlsHttpError(response.status, request.uri)
  }
  const expected = range ? range.end - range.start + 1 : contentLength(response)
  let skip = sliced && range ? range.start : 0

  const finalPath = join(context.directory, partName(request.index))
  const tempPath = `${finalPath}.tmp`
  const file = await open(tempPath, 'w')
  let written = 0
  try {
    for await (const chunk of readBody(response.body)) {
      context.signal.throwIfAborted()
      let data = chunk
      if (skip > 0) {
        const dropped = Math.min(skip, data.byteLength)
        skip -= dropped
        data = data.subarray(dropped)
      }
      if (expected !== undefined && written + data.byteLength > expected) {
        if (!range) throw new Error(`the server sent more than the ${expected} bytes it announced`)
        data = data.subarray(0, expected - written)
      }
      if (data.byteLength === 0) continue
      await file.writeFile(data)
      written += data.byteLength
      context.progress.receive(request.index, written)
      context.report()
      // The rest of a whole-resource answer isn't needed.
      if (sliced && written === expected) break
    }
    if (expected !== undefined && written !== expected) {
      throw new Error(`the server sent ${written} of ${expected} bytes`)
    }
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(tempPath, { force: true })
    throw error
  }
  await file.close()
  await rename(tempPath, finalPath)
  return written
}

/** Worth another attempt: network failures, short bodies and transient HTTP statuses. Not:
 * refusals and limits this module raised on purpose, or statuses like 403/404. */
function retryable(error: unknown): boolean {
  if (error instanceof HlsHttpError) return error.transient
  return !(error instanceof HlsError)
}

async function fetchWithRetries(context: TrackContext, request: SegmentRequest): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    context.progress.receive(request.index, 0)
    try {
      return await fetchOnce(context, request)
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      if (attempt >= context.retries || !retryable(error)) {
        throw new HlsSegmentError(request.index, request.uri, error)
      }
    }
    try {
      await sleep(context.retryDelayMs * 2 ** attempt, undefined, { signal: context.signal })
    } catch {
      throw context.signal.reason
    }
  }
}

/** Joins the parts, in order, into `outputPath`. */
async function assemble(
  directory: string,
  requests: readonly SegmentRequest[],
  outputPath: string,
  signal: AbortSignal | undefined
): Promise<number> {
  const temporary = `${outputPath}.hls-assembling`
  const output = await open(temporary, 'w')
  let bytes = 0
  try {
    for (const request of requests) {
      const part = createReadStream(join(directory, partName(request.index)))
      for await (const chunk of part as AsyncIterable<Buffer>) {
        signal?.throwIfAborted()
        await output.writeFile(chunk)
        bytes += chunk.byteLength
      }
    }
    await output.sync()
  } catch (error) {
    await output.close()
    await rm(temporary, { force: true })
    throw error
  }
  await output.close()
  await rename(temporary, outputPath)
  return bytes
}

/**
 * Downloads one Media Playlist's segments into a single file: the EXT-X-MAP initialization
 * section first, then every segment in order, byte ranges honoured.
 *
 * Up to `concurrency` segments are fetched at once; each is retried with exponential backoff on
 * network errors, short bodies and transient statuses (408, 429, 5xx). Finished segments are kept
 * with a resume record keyed by {@link trackIdentity}, so a later call for the same track (after
 * an abort, a failure or a crash) fetches only what is missing.
 *
 * Rejects with the signal's reason when aborted, {@link HlsSegmentError} when a segment fails for
 * good (the other segments stop; finished ones stay for resume), and the errors of
 * {@link assertDownloadable} for a playlist that can't be saved.
 */
export async function downloadHlsTrack(options: DownloadTrackOptions): Promise<TrackResult> {
  const { playlist, outputPath, signal, onProgress } = options
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const retries = options.retries ?? DEFAULT_RETRIES
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a whole number of at least 1')
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('retries must be a whole number of at least 0')
  }
  assertDownloadable(playlist)
  signal?.throwIfAborted()

  const requests = segmentRequests(playlist)
  const identity = trackIdentity(requests)
  const store = await ResumeStore.open(
    options.workDirectory ?? `${outputPath}.hls-parts`,
    identity,
    requests.length
  )
  const resumedSegments = store.done.size
  const progress = new Progress(requests, store.done)
  const report = (): void => onProgress?.(progress.snapshot())
  report()

  const failure = new AbortController()
  const context: TrackContext = {
    fetch: options.fetch ?? nodeFetch,
    headers: options.headers ?? {},
    source: options.source ?? playlist.url,
    directory: store.directory,
    signal: signal ? AbortSignal.any([signal, failure.signal]) : failure.signal,
    retries,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    progress,
    report
  }
  const pending = requests.filter((request) => !store.done.has(request.index))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      context.signal.throwIfAborted()
      const request = pending[next++]
      const size = await fetchWithRetries(context, request)
      progress.complete(request, size)
      await store.markDone(request.index, size)
      report()
    }
  }
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker().catch((error: unknown) => {
        // Stop the other workers: the track can't finish anyway.
        failure.abort(error)
        throw error
      })
    )
  )
  if (signal?.aborted) throw signal.reason
  const failed = outcomes.find((outcome) => outcome.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason

  const bytes = await assemble(store.directory, requests, outputPath, signal)
  await store.finish()
  return { outputPath, bytes, segments: requests.length, resumedSegments, identity }
}

export interface DownloadHlsOptions extends Omit<
  DownloadTrackOptions,
  'playlist' | 'outputPath' | 'workDirectory' | 'source' | 'onProgress'
> {
  /** Where the main (video) track is saved. */
  videoPath: string
  /** Where the separate audio track is saved; required when the stream has one. */
  audioPath?: string
  onProgress?: (track: 'video' | 'audio', progress: HlsProgress) => void
}

export interface DownloadHlsResult {
  video: TrackResult
  audio?: TrackResult
}

/**
 * Downloads a {@link ResolvedHls} stream: the main track to `videoPath` and, when there is a
 * separate audio rendition, the audio track to `audioPath`, one after the other. Each file is a
 * plain concatenation of its track's segments; combining them into one video is a muxing step
 * (FFmpeg) outside this module.
 */
export async function downloadHls(
  resolved: ResolvedHls,
  options: DownloadHlsOptions
): Promise<DownloadHlsResult> {
  const { videoPath, audioPath, onProgress, ...shared } = options
  if (resolved.audio && audioPath === undefined) {
    throw new TypeError('This stream has a separate audio track: pass audioPath for it.')
  }
  const video = await downloadHlsTrack({
    ...shared,
    playlist: resolved.video,
    outputPath: videoPath,
    source: resolved.source,
    onProgress: onProgress && ((progress) => onProgress('video', progress))
  })
  if (!resolved.audio || audioPath === undefined) return { video }
  const audio = await downloadHlsTrack({
    ...shared,
    playlist: resolved.audio,
    outputPath: audioPath,
    source: resolved.source,
    onProgress: onProgress && ((progress) => onProgress('audio', progress))
  })
  return { video, audio }
}
