import type {
  StreamProbeResult,
  StreamProtocol,
  StreamSegmentState,
  StreamVariant
} from '../../../shared/types'
import { streamQualityLabel } from '../../../shared/streamQuality'
import {
  listVideoQualities,
  parseMpd,
  planSelection,
  selectRepresentations,
  type ByteRange as DashByteRange,
  type Mpd,
  type TrackPlan
} from '../../media/dash'
import {
  HlsHttpError,
  HlsLimitError,
  MAX_PLAYLIST_BYTES,
  nodeFetch,
  resolveHls,
  segmentRequests,
  type ByteRange as HlsByteRange,
  type HlsFetch,
  type MediaPlaylist,
  type SegmentRequest
} from '../../media/hls'
import { discardBody, readBody } from '../../media/hls/http'
import { containerForCodecs, type Container } from '../../media/mux'

// What an HLS or DASH link is, and what downloading it takes: its tracks as Media Playlists, so
// one segment downloader (the HLS module's downloadHlsTrack) fetches both kinds.

/** HLS Playlists are identified by "the path ... MUST end with either .m3u8 or .m3u ... the HTTP
 * Content-Type MUST be "application/vnd.apple.mpegurl" or "audio/mpegurl"" (RFC 8216 §4); many
 * servers send the older application/x-mpegurl. `.m3u` and audio/mpegurl are left to plain-file
 * downloads: they are just as often a radio station's playlist. */
const HLS_TYPE = /^\s*(application\/vnd\.apple\.mpegurl|application\/x-mpegurl)\s*(;|$)/i
/** The MPD's registered media type and extension (ISO/IEC 23009-1, Annex C). */
const DASH_TYPE = /^\s*application\/dash\+xml\s*(;|$)/i

/** Whether a link is an HLS playlist or a DASH manifest, by the server's Content-Type first and
 * then by its path's extension; null for anything else. */
export function streamProtocolOf(contentType: string | undefined, url: URL): StreamProtocol | null {
  if (contentType && HLS_TYPE.test(contentType)) return 'hls'
  if (contentType && DASH_TYPE.test(contentType)) return 'dash'
  if (/\.m3u8$/i.test(url.pathname)) return 'hls'
  if (/\.mpd$/i.test(url.pathname)) return 'dash'
  return null
}

/** Names a manifest's path ends in that say nothing about the video. */
const GENERIC_NAMES = new Set([
  'master',
  'index',
  'playlist',
  'manifest',
  'main',
  'prog_index',
  'chunklist',
  'stream',
  'video',
  'media',
  'hls',
  'dash',
  'output',
  'out',
  'default'
])

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** A name for the video from its link, without an extension (the container decides that once the
 * quality is picked): the manifest's own name, or the nearest folder above it when that is a
 * generic one ("master.m3u8" in /talks/keynote-2026/hls/). */
export function streamTitle(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean).map(decoded)
  for (let index = parts.length - 1; index >= 0; index--) {
    const stem = parts[index].replace(/\.(m3u8|mpd)$/i, '').trim()
    if (stem && !GENERIC_NAMES.has(stem.toLowerCase())) return stem
  }
  return 'video'
}

/** Extensions a stream's name may already carry: replaced by the container's, not doubled. */
const MEDIA_EXTENSION = /\.(mp4|m4v|m4a|mkv|mka|webm|mov|ts|m3u8|mpd)$/i

/** `name` as a file of `container`: "Talk" and "Talk.mp4" become "Talk.mkv" for Matroska. */
export function streamFileName(name: string, container: Container): string {
  const stem = name.trim().replace(MEDIA_EXTENSION, '').trim() || 'video'
  return `${stem}.${container}`
}

export interface StreamFetchOptions {
  /** Default: the HLS module's nodeFetch. */
  fetch?: HlsFetch
  /** Headers from the user's browser session, meant for the manifest's origin. */
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** A DASH manifest's bytes and the URL that finally answered, through the same fetch as the
 * segments. Refused past the size HLS playlists are held to. */
export async function fetchManifest(
  url: string,
  options: StreamFetchOptions = {}
): Promise<{ bytes: Uint8Array; url: string }> {
  const fetch = options.fetch ?? nodeFetch
  const response = await fetch(url, { headers: options.headers ?? {}, signal: options.signal })
  if (response.status !== 200) {
    await discardBody(response.body)
    throw new HlsHttpError(response.status, url)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of readBody(response.body)) {
    size += chunk.byteLength
    if (size > MAX_PLAYLIST_BYTES) {
      throw new HlsLimitError(
        'playlist-size',
        'The DASH manifest is larger than 10 MiB, which is more than Mergelane will read.'
      )
    }
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), url: response.url ?? url }
}

/** One track to download: the main one (video, or the only one) or a separate audio track. */
export interface StreamTrack {
  role: 'video' | 'audio'
  playlist: MediaPlaylist
}

/** A stream resolved down to what to download, for the quality asked for. */
export interface ResolvedStream {
  protocol: StreamProtocol
  /** The main track first. */
  tracks: StreamTrack[]
  /** RFC 6381 codecs of what is downloaded, for choosing the container. */
  codecs: string[]
  durationSeconds?: number
  /** The chosen quality's label, when the stream offers a choice. */
  quality?: string
}

function hlsByteRange(range: DashByteRange): HlsByteRange {
  return { offset: range.start, length: range.end - range.start + 1 }
}

/**
 * The adapter from DASH to the one segment downloader: a DASH track plan as the finished,
 * unencrypted Media Playlist it amounts to. Its requests come out of segmentRequests() as the plan
 * has them — the initialization segment first, then every media segment in order, each byte range
 * kept — so downloadHlsTrack fetches, resumes and joins a DASH track exactly as an HLS one. The
 * period's length is shared out over the segments: it only feeds the size estimate.
 */
export function dashTrackPlaylist(plan: TrackPlan, mpd: Mpd): MediaPlaylist {
  const total = mpd.durationSeconds ?? 0
  const each = plan.media.length > 0 && total > 0 ? total / plan.media.length : 0
  const init = plan.init && {
    uri: plan.init.url,
    ...(plan.init.range && { byteRange: hlsByteRange(plan.init.range) })
  }
  return {
    kind: 'media',
    url: mpd.url,
    targetDuration: Math.ceil(each),
    mediaSequence: 0,
    playlistType: 'VOD',
    endList: true,
    iFramesOnly: false,
    segments: plan.media.map((request, index) => ({
      index,
      sequence: index,
      uri: request.url,
      duration: each,
      ...(request.range && { byteRange: hlsByteRange(request.range) }),
      ...(init && { init }),
      discontinuity: false
    })),
    duration: total
  }
}

/**
 * Fetches the manifest and works out what downloading `variantId` (left out: the best quality)
 * takes. Every refusal of the media modules comes through as it is — a live stream, protection,
 * too many segments — with a message fit to show.
 */
export async function resolveStream(
  url: string,
  protocol: StreamProtocol,
  variantId: string | undefined,
  options: StreamFetchOptions = {}
): Promise<ResolvedStream> {
  if (protocol === 'hls') {
    const resolved = await resolveHls(url, {
      fetch: options.fetch,
      headers: options.headers,
      signal: options.signal,
      ...(variantId !== undefined && { variant: { id: variantId } })
    })
    const tracks: StreamTrack[] = [{ role: 'video', playlist: resolved.video }]
    if (resolved.audio) tracks.push({ role: 'audio', playlist: resolved.audio })
    const variant = resolved.variant
    return {
      protocol,
      tracks,
      codecs: variant?.codecs ?? [],
      durationSeconds: resolved.video.duration,
      ...(variant && {
        quality: streamQualityLabel({
          height: variant.resolution?.height,
          bandwidth: variant.bandwidth
        })
      })
    }
  }

  const manifest = await fetchManifest(url, options)
  const mpd = parseMpd(manifest.bytes, manifest.url)
  const selection = selectRepresentations(
    mpd,
    variantId === undefined ? {} : { videoId: variantId }
  )
  const plans = planSelection(mpd, selection)
  const tracks: StreamTrack[] = []
  if (plans.video) tracks.push({ role: 'video', playlist: dashTrackPlaylist(plans.video, mpd) })
  if (plans.audio) {
    // Audio alone is the main track.
    tracks.push({
      role: tracks.length > 0 ? 'audio' : 'video',
      playlist: dashTrackPlaylist(plans.audio, mpd)
    })
  }
  const { video, audio } = selection
  const qualities = listVideoQualities(mpd)
  return {
    protocol,
    tracks,
    codecs: [video?.codecs, audio?.codecs].filter((codec): codec is string => !!codec),
    durationSeconds: mpd.durationSeconds,
    ...(video &&
      qualities.length > 1 && {
        quality: streamQualityLabel({ height: video.height, bandwidth: video.bandwidth })
      })
  }
}

/** The container 'auto' muxing picks for a resolved stream (see containerForCodecs). */
export function streamContainer(resolved: ResolvedStream): Container {
  return containerForCodecs(resolved.codecs)
}

/** What New download shows for an HLS or DASH link: its qualities, best first, once the best one
 * has been checked to be downloadable — so a live or protected stream is refused here, before
 * anything is started. */
export async function describeStream(
  protocol: StreamProtocol,
  requestedUrl: string,
  finalUrl: string,
  contentType: string | null,
  options: StreamFetchOptions = {}
): Promise<StreamProbeResult> {
  let variants: StreamVariant[]
  let durationSeconds: number | undefined
  if (protocol === 'hls') {
    const resolved = await resolveHls(finalUrl, options)
    variants = resolved.variants.map((variant) => ({
      id: variant.id,
      bandwidth: variant.bandwidth,
      ...(variant.resolution && {
        width: variant.resolution.width,
        height: variant.resolution.height
      }),
      ...(variant.frameRate !== undefined && { frameRate: variant.frameRate }),
      ...(variant.codecs && { codecs: variant.codecs })
    }))
    durationSeconds = resolved.video.duration
  } else {
    const manifest = await fetchManifest(finalUrl, options)
    const mpd = parseMpd(manifest.bytes, manifest.url)
    planSelection(mpd, selectRepresentations(mpd))
    variants = listVideoQualities(mpd).map((quality) => ({
      id: quality.id,
      bandwidth: quality.bandwidth,
      ...(quality.width !== undefined && { width: quality.width }),
      ...(quality.height !== undefined && { height: quality.height }),
      ...(quality.codecs !== undefined && { codecs: [quality.codecs] })
    }))
    durationSeconds = mpd.durationSeconds
  }
  return {
    kind: 'stream',
    requestedUrl,
    finalUrl,
    // Its segments are fetched over every network, whatever the server says of ranges.
    supportsRanges: true,
    totalBytes: null,
    suggestedFileName: streamTitle(new URL(finalUrl)),
    contentType,
    etag: null,
    lastModified: null,
    stream: {
      protocol,
      variants,
      ...(durationSeconds !== undefined && durationSeconds > 0 && { durationSeconds })
    }
  }
}

/** One track's requests, in the order the segment downloader fetches them, and where its blocks
 * start among the download's. */
export interface PlannedTrack extends StreamTrack {
  requests: SegmentRequest[]
  /** Index of its first block. */
  first: number
}

/** The tracks with their requests laid out one after the other, the main track's first. */
export function planTracks(tracks: readonly StreamTrack[]): PlannedTrack[] {
  let first = 0
  return tracks.map((track) => {
    const requests = segmentRequests(track.playlist)
    const planned = { ...track, requests, first }
    first += requests.length
    return planned
  })
}

/** A block per request, sized when it is a byte range and open-ended otherwise. */
export function planStreamBlocks(tracks: readonly PlannedTrack[]): StreamSegmentState[] {
  return tracks.flatMap((track) =>
    track.requests.map((request): StreamSegmentState => ({
      kind: 'stream',
      index: track.first + request.index,
      rangeStart: 0,
      rangeEnd: request.range ? request.range.end - request.range.start : null,
      status: 'pending',
      bytesDownloaded: 0,
      bytesByInterface: {}
    }))
  )
}

/** How many requests each track has, the main track's first: what a download's blocks were
 * planned for. */
export function trackShape(tracks: readonly PlannedTrack[]): number[] {
  return tracks.map((track) => track.requests.length)
}

/** Whether a fresh resolution still has the requests a download's blocks were planned for: the
 * same tracks with as many requests each. Signed URLs may change between runs; their count
 * doesn't. */
export function sameShape(tracks: readonly PlannedTrack[], shape: readonly number[]): boolean {
  const now = trackShape(tracks)
  return now.length === shape.length && now.every((count, index) => count === shape[index])
}
