import type { StreamVariant } from '../../../shared/types'
import { YoutubeError } from './errors'

/**
 * Reading yt-dlp's `--dump-single-json` for one YouTube video, strictly: every field Mergelane
 * uses is checked for its type, and a format that fails any check is left out rather than
 * guessed at. What's kept is only what Mergelane may download (ADR-0026, CLAUDE.md):
 *
 * - no format marked DRM, nor "maybe" DRM (`has_drm` is `true` or `"maybe"` in yt-dlp's
 *   YoutubeDL.py; anything but false or absent counts);
 * - plain HTTPS files only (`protocol` "https"): not HLS or DASH manifests, which YouTube uses for
 *   live streams, and not storyboards;
 * - with an exact size (`filesize`), so the file can be fetched in ranges over every network;
 * - in codecs our FFmpeg copies into MP4 or MKV;
 * - not marked "DAMAGED" or "MISSING POT" by yt-dlp: Mergelane never makes or sends PO tokens.
 */

/** yt-dlp's YouTube chunk size: its extractor sets `downloader_options.http_chunk_size` to
 * `10 << 20` for HTTPS formats (extractor/youtube/_video.py, 2026.10.26), and its FAQ says
 * "YouTube throttles any request with an http chunk size of > 10MB". No range Mergelane asks for
 * is bigger. */
export const MAX_CHUNK_BYTES = 10 << 20

export interface YoutubeFormat {
  /** yt-dlp's format id, e.g. "137" (YouTube's itag). */
  id: string
  url: string
  /** The headers yt-dlp would send with it (`http_headers`), minus any Mergelane never sends. */
  headers: Record<string, string>
  /** Exact size in bytes. */
  size: number
  /** The largest range to ask for at once. */
  chunkSize: number
  /** RFC 6381 codecs; undefined for a track without one. */
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  fps?: number
  /** Kilobits per second, as yt-dlp says (`tbr`). */
  bitrate?: number
  /** yt-dlp's `language_preference`: higher for the original and the default audio track. */
  languagePreference?: number
  /** Not to be asked for before this (ms since 1970): YouTube's wait for a pre-roll ad
   * (`available_at`). */
  availableAt?: number
  /** When its address stops working (ms since 1970), from the URL's `expire` parameter. */
  expiresAt?: number
}

export interface YoutubeVideo {
  id: string
  title: string
  durationSeconds?: number
  /** Only what Mergelane may download, in yt-dlp's order (worst first). */
  formats: YoutubeFormat[]
}

const FORMAT_ID = /^[A-Za-z0-9_-]{1,32}$/
/** Containers yt-dlp names for YouTube's files that our FFmpeg reads. */
const EXTENSIONS = new Set(['mp4', 'm4a', 'webm'])
/** First part of the codecs our FFmpeg can copy (see media/mux/codecs.ts and ADR-0028). */
const VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'vp9'])
const AUDIO_CODECS = new Set(['mp4a', 'opus', 'ac-3', 'ec-3'])
/** Hosts plain HTTP is accepted from: only the tests' local server. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Headers a format may not set: the connection's own, ranges and encodings (Mergelane sets
 * those), and credentials (Mergelane never sends any to YouTube). */
const BARRED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'upgrade',
  'keep-alive',
  'range',
  'accept-encoding',
  'cookie',
  'authorization',
  'proxy-authorization',
  'proxy-connection'
])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
// eslint-disable-next-line no-control-regex -- a header value never holds a control character
const HEADER_VALUE = /^[^\x00-\x08\x0a-\x1f\x7f]{0,2048}$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

/** A codec yt-dlp names, or undefined for "none" and for one our FFmpeg can't copy (null). */
function codec(value: unknown, known: ReadonlySet<string>): string | undefined | null {
  if (value === undefined || value === null || value === 'none') return undefined
  if (typeof value !== 'string' || value.length > 64) return null
  return known.has(value.toLowerCase().split('.')[0]) ? value : null
}

function headersOf(value: unknown): Record<string, string> | null {
  if (value === undefined) return {}
  if (!isObject(value)) return null
  const headers: Record<string, string> = {}
  for (const [name, text] of Object.entries(value)) {
    if (!HEADER_NAME.test(name) || typeof text !== 'string' || !HEADER_VALUE.test(text)) {
      return null
    }
    if (!BARRED_HEADERS.has(name.toLowerCase())) headers[name] = text
  }
  return headers
}

/** The format's address, when it is one Mergelane may fetch: https, or http on loopback. */
function addressOf(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return url
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url : null
  } catch {
    return null
  }
}

/** One of yt-dlp's formats, or null when Mergelane won't download it. */
export function readFormat(entry: unknown): YoutubeFormat | null {
  if (!isObject(entry)) return null
  const { format_id: id, protocol, has_drm: drm, ext, format_note: note } = entry
  if (typeof id !== 'string' || !FORMAT_ID.test(id)) return null
  // `false`, or left out: yt-dlp marks protected formats `true` and suspected ones "maybe".
  if (drm !== undefined && drm !== null && drm !== false) return null
  if (protocol !== 'https' && protocol !== 'http') return null
  if (typeof ext !== 'string' || !EXTENSIONS.has(ext)) return null
  if (note !== undefined && note !== null && typeof note !== 'string') return null
  if (typeof note === 'string' && /DAMAGED|MISSING POT/.test(note)) return null
  const url = addressOf(entry.url)
  const size = positiveInteger(entry.filesize)
  const headers = headersOf(entry.http_headers)
  if (!url || size === undefined || headers === null) return null
  const videoCodec = codec(entry.vcodec, VIDEO_CODECS)
  const audioCodec = codec(entry.acodec, AUDIO_CODECS)
  if (videoCodec === null || audioCodec === null) return null
  if (videoCodec === undefined && audioCodec === undefined) return null

  const options = entry.downloader_options
  const asked = isObject(options) ? positiveInteger(options.http_chunk_size) : undefined
  const expire = Number(url.searchParams.get('expire'))
  const availableAt = positive(entry.available_at)
  const width = positiveInteger(entry.width)
  const height = positiveInteger(entry.height)
  const fps = positive(entry.fps)
  const bitrate = positive(entry.tbr)
  const languagePreference = entry.language_preference
  return {
    id,
    url: url.href,
    headers,
    size,
    chunkSize: Math.min(asked ?? MAX_CHUNK_BYTES, MAX_CHUNK_BYTES),
    ...(videoCodec !== undefined && { videoCodec }),
    ...(audioCodec !== undefined && { audioCodec }),
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(fps !== undefined && { fps }),
    ...(bitrate !== undefined && { bitrate }),
    ...(Number.isSafeInteger(languagePreference) && {
      languagePreference: languagePreference as number
    }),
    ...(availableAt !== undefined && { availableAt: availableAt * 1000 }),
    ...(Number.isSafeInteger(expire) && expire > 0 && { expiresAt: expire * 1000 })
  }
}

/**
 * The video in yt-dlp's JSON, with only the formats Mergelane may download. Fails with what to
 * tell the user for anything that isn't one video that has finished being broadcast, and for a
 * video with nothing left to download.
 */
export function parseVideo(json: string): YoutubeVideo {
  let info: unknown
  try {
    info = JSON.parse(json)
  } catch {
    throw new YoutubeError('bad-answer')
  }
  if (!isObject(info)) throw new YoutubeError('bad-answer')
  // -J of a playlist prints the playlist; --no-playlist and youtubeLink() make that unlikely.
  if (info._type !== undefined && info._type !== 'video') {
    throw new YoutubeError(
      'bad-answer',
      'This isn’t one YouTube video. Mergelane downloads one video at a time.'
    )
  }
  const { id, title, live_status: live } = info
  if (typeof id !== 'string' || typeof title !== 'string' || info.extractor_key !== 'Youtube') {
    throw new YoutubeError('bad-answer')
  }
  if (live === 'is_live' || info.is_live === true) throw new YoutubeError('live')
  if (live === 'is_upcoming') throw new YoutubeError('premiere')
  if (live === 'post_live') {
    throw new YoutubeError(
      'live',
      'This live stream has just ended and YouTube is still preparing it. Try again later.'
    )
  }
  if (!Array.isArray(info.formats)) throw new YoutubeError('no-formats')
  const formats = info.formats
    .map(readFormat)
    .filter((format): format is YoutubeFormat => format !== null)
  if (formats.length === 0) {
    // Everything was left out: say so plainly when it was for DRM.
    const protectedOnly = info.formats.some(
      (format) => isObject(format) && (format.has_drm === true || format.has_drm === 'maybe')
    )
    throw new YoutubeError(protectedOnly ? 'drm' : 'no-formats')
  }
  const duration = positive(info.duration)
  return {
    id,
    title: title.trim() || id,
    ...(duration !== undefined && { durationSeconds: duration }),
    formats
  }
}

// ---- Qualities --------------------------------------------------------------------------------

/** How well a video codec plays on a Mac, best first: H.264 everywhere, then HEVC, then AV1
 * (hardware on newer chips), then VP9. */
const VIDEO_ORDER = ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'vp9']

const fourcc = (codec: string | undefined): string => (codec ?? '').toLowerCase().split('.')[0]
const rankOf = (codec: string | undefined): number => {
  const index = VIDEO_ORDER.indexOf(fourcc(codec))
  return index < 0 ? VIDEO_ORDER.length : index
}

/** yt-dlp names YouTube's reworked copies of a format by suffix: "-drc" for sound with its dynamic
 * range compressed, "-sr" for "AI-upscaled" picture (extractor/youtube/_video.py). The originals
 * come first. */
const original = (format: YoutubeFormat): number => (/-(?:drc|sr)$/.test(format.id) ? 0 : 1)

const isVideo = (format: YoutubeFormat): boolean => format.videoCodec !== undefined
const isAudioOnly = (format: YoutubeFormat): boolean =>
  format.videoCodec === undefined && format.audioCodec !== undefined

/** The sound for `video`: the original (or default) language first, then the original sound (not
 * its "-drc" copy), AAC beside H.264 (the pair every Mac plays) and Opus beside the rest, then
 * the higher bit rate. */
export function pickAudio(
  video: YoutubeFormat | undefined,
  formats: readonly YoutubeFormat[]
): YoutubeFormat | undefined {
  const preferAac = video === undefined || ['avc1', 'avc3'].includes(fourcc(video.videoCodec))
  const score = (format: YoutubeFormat): number[] => {
    const aac = fourcc(format.audioCodec) === 'mp4a'
    return [
      format.languagePreference ?? -1,
      original(format),
      aac === preferAac ? 1 : 0,
      format.bitrate ?? 0,
      format.size
    ]
  }
  return formats.filter(isAudioOnly).reduce<YoutubeFormat | undefined>((best, format) => {
    if (!best) return format
    const [a, b] = [score(format), score(best)]
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? format : best
    return best
  }, undefined)
}

/** The video for one height: separate video before video with its sound in it, the original before
 * an upscaled copy, then the codec that plays best, then the higher frame rate and bit rate. */
function better(a: YoutubeFormat, b: YoutubeFormat): YoutubeFormat {
  const score = (format: YoutubeFormat): number[] => [
    format.audioCodec === undefined ? 1 : 0,
    original(format),
    -rankOf(format.videoCodec),
    format.fps ?? 0,
    format.bitrate ?? 0
  ]
  const [x, y] = [score(a), score(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b
  return a
}

/** A quality's tracks: its video (or the only track), and separate sound when it has some. */
export interface YoutubeChoice {
  main: YoutubeFormat
  audio?: YoutubeFormat
}

const choiceId = (choice: YoutubeChoice): string =>
  choice.audio ? `${choice.main.id}+${choice.audio.id}` : choice.main.id

/** The video's qualities, best first: one per picture height, each with its sound; or, for a
 * video that is only sound, that. */
export function youtubeChoices(video: YoutubeVideo): YoutubeChoice[] {
  const byHeight = new Map<number, YoutubeFormat>()
  for (const format of video.formats.filter(isVideo)) {
    const height = format.height ?? 0
    const kept = byHeight.get(height)
    byHeight.set(height, kept ? better(kept, format) : format)
  }
  const choices = [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, main]): YoutubeChoice => {
      const audio = main.audioCodec === undefined ? pickAudio(main, video.formats) : undefined
      return audio ? { main, audio } : { main }
    })
  if (choices.length > 0) return choices
  const audio = pickAudio(undefined, video.formats)
  return audio ? [{ main: audio }] : []
}

/** The choices as New download's picker lists them. */
export function youtubeVariants(video: YoutubeVideo): StreamVariant[] {
  return youtubeChoices(video).map((choice) => {
    const { main, audio } = choice
    const codecs = [main.videoCodec, main.audioCodec, audio?.audioCodec].filter(
      (codec): codec is string => codec !== undefined
    )
    return {
      id: choiceId(choice),
      bandwidth: Math.round(((main.bitrate ?? 0) + (audio?.bitrate ?? 0)) * 1000),
      ...(main.width !== undefined && { width: main.width }),
      ...(main.height !== undefined && { height: main.height }),
      ...(main.fps !== undefined && { frameRate: main.fps }),
      codecs,
      bytes: main.size + (audio?.size ?? 0)
    }
  })
}

/** The formats a variant id names ("137+140", or "18"), or the best choice when it names none.
 * Fails when they are no longer offered: a video's formats can change between runs. */
export function chooseFormats(video: YoutubeVideo, variantId: string | undefined): YoutubeChoice {
  if (variantId === undefined) {
    const [best] = youtubeChoices(video)
    if (!best) throw new YoutubeError('no-formats')
    return best
  }
  const [mainId, audioId, extra] = variantId.split('+')
  const find = (id: string | undefined): YoutubeFormat | undefined =>
    video.formats.find((format) => format.id === id)
  const main = find(mainId)
  const audio = audioId === undefined ? undefined : find(audioId)
  if (!main || extra !== undefined || (audioId !== undefined && (!audio || !isAudioOnly(audio)))) {
    throw new YoutubeError('format-gone')
  }
  return audio ? { main, audio } : { main }
}
