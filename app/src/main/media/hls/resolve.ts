// Logic adapted from Awesome Downloader core/hls.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane (upstream fetchPlaylist / resolveHls); see
// docs/UPSTREAM.md.
//
// Section numbers refer to RFC 8216, https://www.rfc-editor.org/rfc/rfc8216.

import { HlsHttpError, HlsLimitError, HlsPlaylistError } from './errors'
import { discardBody, nodeFetch, readBody, scopeHeaders, type HlsFetch } from './http'
import {
  assertDownloadable,
  parsePlaylist,
  type MasterPlaylist,
  type MediaPlaylist,
  type Rendition,
  type Variant
} from './parse'
import { listVariants, selectVariant, type VariantOption, type VariantSelection } from './select'

/** Playlists larger than this are refused. 20,000 segments with long signed URLs fit. */
export const MAX_PLAYLIST_BYTES = 10 * 1024 * 1024

/** A master playlist may point at another master; past this many levels it is refused. */
export const MAX_MASTER_NESTING = 3

export interface FetchPlaylistOptions {
  fetch?: HlsFetch
  /** Headers from the user's browser session (Cookie, Referer, ...), meant for `source`. */
  headers?: Record<string, string>
  /** The URL the headers belong to; credentials are dropped for other origins. Default: the
   * playlist URL itself. */
  source?: string
  signal?: AbortSignal
}

export interface FetchedPlaylist {
  text: string
  /** The final URL after redirects: the base for the playlist's relative URIs (§4.1). */
  url: string
}

/** Downloads a playlist's text. Throws {@link HlsHttpError} unless the server answers 200,
 * {@link HlsLimitError} past {@link MAX_PLAYLIST_BYTES}, and {@link HlsPlaylistError} when it is
 * not UTF-8 (§4.1: playlists MUST be UTF-8). */
export async function fetchPlaylist(
  url: string,
  options: FetchPlaylistOptions = {}
): Promise<FetchedPlaylist> {
  const fetch = options.fetch ?? nodeFetch
  const headers = scopeHeaders(options.headers ?? {}, options.source ?? url, url)
  const response = await fetch(url, { headers, signal: options.signal })
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
        'The HLS playlist is larger than 10 MiB, which is more than Mergelane will read.'
      )
    }
    chunks.push(chunk)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new HlsPlaylistError('it is not UTF-8 text (§4.1)')
  }
  return { text, url: response.url ?? url }
}

export interface ResolveHlsOptions extends Omit<FetchPlaylistOptions, 'source'> {
  /** Which quality to take from the (top-level) master playlist. Default: highest bandwidth. */
  variant?: VariantSelection
}

/** A stream resolved down to the Media Playlists to download. */
export interface ResolvedHls {
  /** The URL resolution started from; the headers belong to its origin. */
  source: string
  /** The top-level master playlist, when the URL was one. */
  master?: MasterPlaylist
  /** The top-level master's qualities, best first, for a picker. Empty for a media playlist. */
  variants: VariantOption[]
  /** The variant chosen from the top-level master. */
  variant?: Variant
  /** The audio rendition downloaded as its own track, when there is one. */
  audioRendition?: Rendition
  /** The main track: the variant's Media Playlist (or the URL itself, if it was one). */
  video: MediaPlaylist
  /** The separate audio track's Media Playlist, when the variant has one. */
  audio?: MediaPlaylist
}

async function loadMedia(url: string, options: FetchPlaylistOptions): Promise<MediaPlaylist> {
  const fetched = await fetchPlaylist(url, options)
  const playlist = parsePlaylist(fetched.text, fetched.url)
  if (playlist.kind !== 'media') {
    // §4.3.4.1: a rendition's URI identifies a Media Playlist.
    throw new HlsPlaylistError('the audio rendition points at a master playlist (§4.3.4.1)')
  }
  assertDownloadable(playlist)
  return playlist
}

/**
 * Fetches `url` and follows master playlists down to the Media Playlist(s) to download: the
 * chosen variant (see {@link VariantSelection}) and, when its audio group has a rendition with its
 * own URI (§4.3.4.2.1), that audio rendition as a second track.
 *
 * Every playlist is checked with {@link assertDownloadable}, so live and encrypted streams are
 * refused here, before anything is downloaded. Masters nested deeper than
 * {@link MAX_MASTER_NESTING} levels are refused with {@link HlsLimitError}. Nested masters (not
 * standard HLS, but seen in the wild) use `variant.height` if given, else the highest bandwidth.
 */
export async function resolveHls(
  url: string,
  options: ResolveHlsOptions = {}
): Promise<ResolvedHls> {
  const fetchOptions: FetchPlaylistOptions = {
    fetch: options.fetch,
    headers: options.headers,
    signal: options.signal,
    source: url
  }
  let top: { master: MasterPlaylist; variant: Variant } | undefined
  let audioRendition: Rendition | undefined
  let current = url
  for (let masters = 0; ;) {
    const fetched = await fetchPlaylist(current, fetchOptions)
    const playlist = parsePlaylist(fetched.text, fetched.url)
    if (playlist.kind === 'media') {
      assertDownloadable(playlist)
      // An audio rendition can be the very playlist being downloaded (RFC 8216 §8.6: the
      // audio-only variant is main/english-audio.m3u8); then there is no second track.
      const audioUri = audioRendition?.uri
      const audio =
        audioUri !== undefined && audioUri !== current
          ? await loadMedia(audioUri, fetchOptions)
          : undefined
      return {
        source: url,
        ...(top ? { master: top.master, variant: top.variant } : {}),
        variants: top ? listVariants(top.master) : [],
        ...(audio ? { audioRendition, audio } : {}),
        video: playlist
      }
    }
    masters++
    if (masters > MAX_MASTER_NESTING) {
      throw new HlsLimitError(
        'nesting',
        `The HLS playlist nests master playlists more than ${MAX_MASTER_NESTING} levels deep.`
      )
    }
    const selection = selectVariant(
      playlist,
      top
        ? options.variant?.height === undefined
          ? {}
          : { height: options.variant.height }
        : options.variant
    )
    top ??= { master: playlist, variant: selection.variant }
    audioRendition = selection.audio
    current = selection.variant.uri
  }
}
