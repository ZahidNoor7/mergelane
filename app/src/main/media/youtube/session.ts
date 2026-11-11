import { setTimeout as sleep } from 'node:timers/promises'
import { streamQualityLabel } from '../../../shared/streamQuality'
import type { MediaPlaylist } from '../hls'
import { YoutubeError } from './errors'
import { chooseFormats, type YoutubeChoice, type YoutubeFormat, type YoutubeVideo } from './info'

/**
 * One run of a YouTube download: which address each network fetches each track from.
 *
 * YouTube's media addresses are signed for the address that asked for them (yt-dlp's FAQ:
 * "requests for the video ... must come from the same IP address"), and they expire. So each
 * network asks yt-dlp for its own (through a proxy pinned to it, see proxy.ts), they are kept in
 * memory only, never saved, and asked for again:
 *
 * - on every run: a resumed download, or one restored after a relaunch, starts by asking;
 * - when they are about to expire (the URL's `expire` parameter);
 * - when YouTube refuses one (HTTP 403).
 *
 * A network whose asking fails, or that is refused again and again, sits out the rest of the run;
 * the others carry on. The tracks themselves are listed under addresses of Mergelane's own
 * ({@link trackUri}), the same from run to run, so the segment downloader's resume record holds
 * while the real addresses change.
 */

/** Asked for again this long before its addresses expire. */
export const EXPIRY_MARGIN_MS = 60_000
/** A network asks again at most this many times in a row without a request getting through. */
export const MAX_REFRESHES = 2
/** The longest wait for YouTube's `available_at` (a pre-roll ad's length) that is honoured. */
const MAX_AVAILABILITY_WAIT_MS = 5 * 60_000

const SCHEME = 'mergelane-youtube:'

/** The address a track's segments are listed under: `mergelane-youtube://<video>/<format>`. It is
 * never fetched; {@link YoutubeSession.target} gives the real one for each network. */
export function trackUri(videoId: string, formatId: string): string {
  return `${SCHEME}//${videoId}/${formatId}`
}

/** The format id of a {@link trackUri}, or null for any other address. */
export function formatIdOf(uri: string): string | null {
  if (!uri.startsWith(`${SCHEME}//`)) return null
  const parts = uri.slice(SCHEME.length + 2).split('/')
  return parts.length === 2 && parts[1] !== '' ? parts[1] : null
}

/** A format as the finished playlist of byte ranges it amounts to: the whole file in order, each
 * range no bigger than the format's chunk size, so the segment downloader fetches it as it does
 * an HLS track. */
export function youtubeTrackPlaylist(
  videoId: string,
  format: YoutubeFormat,
  durationSeconds = 0
): MediaPlaylist {
  const uri = trackUri(videoId, format.id)
  const count = Math.ceil(format.size / format.chunkSize)
  const each = durationSeconds > 0 ? durationSeconds / count : 0
  return {
    kind: 'media',
    url: uri,
    targetDuration: Math.ceil(each),
    mediaSequence: 0,
    playlistType: 'VOD',
    endList: true,
    iFramesOnly: false,
    segments: Array.from({ length: count }, (_, index) => {
      const offset = index * format.chunkSize
      return {
        index,
        sequence: index,
        uri,
        duration: each,
        byteRange: { offset, length: Math.min(format.chunkSize, format.size - offset) },
        discontinuity: false
      }
    }),
    duration: durationSeconds
  }
}

/** What a download of one quality takes: its tracks, the main one first. */
export interface YoutubePlan {
  video: YoutubeVideo
  choice: YoutubeChoice
  /** `"137+140"`: what StartStreamDownloadRequest.variantId names. */
  variantId: string
  tracks: { role: 'video' | 'audio'; playlist: MediaPlaylist }[]
  /** RFC 6381 codecs of what is downloaded: what decides MP4 or MKV. */
  codecs: string[]
  quality: string
}

/** The plan for `variantId` (left out: the best quality) of a video yt-dlp described. */
export function youtubePlan(video: YoutubeVideo, variantId: string | undefined): YoutubePlan {
  const choice = chooseFormats(video, variantId)
  const { main, audio } = choice
  const tracks: YoutubePlan['tracks'] = [
    { role: 'video', playlist: youtubeTrackPlaylist(video.id, main, video.durationSeconds) }
  ]
  if (audio) {
    tracks.push({
      role: 'audio',
      playlist: youtubeTrackPlaylist(video.id, audio, video.durationSeconds)
    })
  }
  const bandwidth = ((main.bitrate ?? 0) + (audio?.bitrate ?? 0)) * 1000
  return {
    video,
    choice,
    variantId: audio ? `${main.id}+${audio.id}` : main.id,
    tracks,
    codecs: [main.videoCodec, main.audioCodec, audio?.audioCodec].filter(
      (codec): codec is string => codec !== undefined
    ),
    quality: streamQualityLabel({ height: main.height, bandwidth })
  }
}

/** A network can't carry this download's requests for the rest of the run: `reason` says why, in
 * words fit to show beside it. */
export class YoutubeNetworkError extends Error {
  constructor(
    readonly networkId: string,
    readonly reason: YoutubeError
  ) {
    super(reason.message)
    this.name = 'YoutubeNetworkError'
  }
}

/** Where to send one request: the address and headers for that network, now. */
export interface YoutubeTarget {
  url: string
  headers: Record<string, string>
  /** Which asking they came from, for {@link YoutubeSession.refused}. */
  generation: number
}

interface Entry {
  generation: number
  /** The plan's formats as this network was given them, by id. */
  formats: Map<string, YoutubeFormat>
  /** YouTube refused one of its addresses. */
  refused: boolean
  /** It was asked for because the ones before had expired: if these expire soon too, they're
   * used all the same rather than asked for again and again. */
  forExpiry: boolean
}

export interface YoutubeSessionOptions {
  variantId: string | undefined
  /** Asks yt-dlp about the video through network `networkId`. */
  extract: (networkId: string, signal: AbortSignal) => Promise<YoutubeVideo>
  /** The run's signal: stopping the download stops every asking. */
  signal: AbortSignal
  now?: () => number
}

function asYoutubeError(error: unknown): YoutubeError {
  if (error instanceof YoutubeError) return error
  return new YoutubeError(
    'failed',
    `yt-dlp couldn’t read this video: ${error instanceof Error ? error.message : String(error)}`
  )
}

/** `promise`, or the signal's reason once it is aborted, whichever comes first. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export class YoutubeSession {
  private planned: Promise<YoutubePlan> | null = null
  /** By network: its latest asking, settled or not. */
  private entries = new Map<string, Promise<Entry>>()
  /** By network: its latest asking that succeeded. */
  private current = new Map<string, Entry>()
  /** By network: askings in a row since a request last got through. */
  private refreshes = new Map<string, number>()
  /** Networks that sit out the rest of the run, and why. */
  private readonly broken = new Map<string, YoutubeError>()
  private generation = 0
  private readonly now: () => number

  constructor(private readonly options: YoutubeSessionOptions) {
    this.now = options.now ?? Date.now
  }

  /** Why each network that sits out does, so far. */
  get failures(): ReadonlyMap<string, YoutubeError> {
    return this.broken
  }

  /**
   * Asks over every network in `networkIds` at once, and resolves with the plan from the first
   * that answers. The others' answers are kept as they come, for their own requests. Fails, with
   * the first network's reason, only when every one fails.
   */
  start(networkIds: readonly string[]): Promise<YoutubePlan> {
    if (this.planned) return this.planned
    if (networkIds.length === 0) {
      return Promise.reject(new YoutubeError('network', 'No network is on for this download.'))
    }
    const videos = networkIds.map((id) => {
      const video = this.options.extract(id, this.options.signal)
      this.adopt(id, video, false)
      return video
    })
    this.planned = Promise.any(videos).then(
      (video) => youtubePlan(video, this.options.variantId),
      (failure: AggregateError) => {
        throw asYoutubeError(failure.errors[0])
      }
    )
    return this.planned
  }

  /** Records an asking of `networkId` as its latest: once it answers, its addresses for the
   * plan's formats. One that fails, or doesn't have them, puts the network out. */
  private adopt(networkId: string, video: Promise<YoutubeVideo>, forExpiry: boolean): void {
    const generation = ++this.generation
    const entry = video.then(async (answer): Promise<Entry> => {
      const plan = await this.planned!
      const formats = new Map<string, YoutubeFormat>()
      for (const wanted of [plan.choice.main, plan.choice.audio]) {
        if (!wanted) continue
        const found = answer.formats.find((format) => format.id === wanted.id)
        if (!found || found.size !== wanted.size) {
          throw new YoutubeError(
            'format-gone',
            'YouTube gave this network a different version of the video, so it sits this one out.'
          )
        }
        formats.set(found.id, found)
      }
      const result: Entry = { generation, formats, refused: false, forExpiry }
      if (this.entries.get(networkId) === entry) this.current.set(networkId, result)
      return result
    })
    entry.catch((error: unknown) => {
      if (this.entries.get(networkId) === entry && !this.options.signal.aborted) {
        this.broken.set(networkId, asYoutubeError(error))
      }
    })
    this.entries.set(networkId, entry)
  }

  /** Asks again over `networkId`, unless it has done so too often in a row: then it sits out. */
  private refresh(networkId: string, forExpiry: boolean): void {
    const count = (this.refreshes.get(networkId) ?? 0) + 1
    if (count > MAX_REFRESHES) {
      this.broken.set(
        networkId,
        new YoutubeError(
          'failed',
          'YouTube kept refusing this network’s requests (HTTP 403), so it sits this download out.'
        )
      )
      return
    }
    this.refreshes.set(networkId, count)
    this.current.delete(networkId)
    this.adopt(networkId, this.options.extract(networkId, this.options.signal), forExpiry)
  }

  /**
   * The address and headers to fetch `uri` (a {@link trackUri}) over `networkId` with. Waits for
   * the network's asking, asks again when its addresses were refused or are about to expire, and
   * waits out YouTube's `available_at`. Fails with a {@link YoutubeNetworkError} when the network
   * sits out; with the signal's reason when stopped.
   */
  async target(networkId: string, uri: string, signal: AbortSignal): Promise<YoutubeTarget> {
    const formatId = formatIdOf(uri)
    if (formatId === null) throw new TypeError(`Not a YouTube track address: ${uri}`)
    if (!this.planned) throw new Error('The session hasn’t started')
    await until(this.planned, signal)
    for (;;) {
      signal.throwIfAborted()
      const broken = this.broken.get(networkId)
      if (broken) throw new YoutubeNetworkError(networkId, broken)
      if (!this.entries.has(networkId)) {
        // A network switched on after the run started.
        this.adopt(networkId, this.options.extract(networkId, this.options.signal), false)
      }
      const pending = this.entries.get(networkId)!
      let entry: Entry
      try {
        entry = await until(pending, signal)
      } catch (error) {
        signal.throwIfAborted()
        // Its failure is recorded (see adopt); unless a newer asking took its place.
        if (this.entries.get(networkId) === pending) {
          throw new YoutubeNetworkError(
            networkId,
            this.broken.get(networkId) ?? asYoutubeError(error)
          )
        }
        continue
      }
      if (this.entries.get(networkId) !== pending) continue
      const format = entry.formats.get(formatId)
      if (!format) throw new TypeError(`Format ${formatId} isn’t one this download fetches`)
      if (entry.refused) {
        this.refresh(networkId, false)
        continue
      }
      if (
        format.expiresAt !== undefined &&
        this.now() >= format.expiresAt - EXPIRY_MARGIN_MS &&
        !entry.forExpiry
      ) {
        this.refresh(networkId, true)
        continue
      }
      const wait = Math.min((format.availableAt ?? 0) - this.now(), MAX_AVAILABILITY_WAIT_MS)
      if (wait > 0) await sleep(wait, undefined, { signal })
      return { url: format.url, headers: { ...format.headers }, generation: entry.generation }
    }
  }

  /** YouTube refused an address `networkId` was given in asking `generation` (HTTP 403): its next
   * request asks again. Refusals of older askings change nothing. */
  refused(networkId: string, generation: number): void {
    const entry = this.current.get(networkId)
    if (entry?.generation === generation) entry.refused = true
  }

  /** `networkId` is back (switched on again, reconnected): it asks again, though it sat out. */
  retry(networkId: string): void {
    if (!this.broken.delete(networkId)) return
    this.refreshes.delete(networkId)
    this.entries.delete(networkId)
    this.current.delete(networkId)
  }

  /** A request over `networkId` got through: its askings in a row start over. */
  delivered(networkId: string): void {
    this.refreshes.delete(networkId)
  }
}
