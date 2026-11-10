// Logic adapted from Awesome Downloader core/hls.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)

/**
 * HLS (HTTP Live Streaming, RFC 8216) downloading for finished, unencrypted streams.
 *
 * Typical use:
 *
 * ```ts
 * const resolved = await resolveHls(url, { headers, signal })      // master → media playlists
 * resolved.variants                                                 // for a quality picker
 * await downloadHls(resolved, { videoPath, audioPath, signal })     // one file per track
 * ```
 *
 * Refused with typed {@link HlsError}s whose messages can be shown as-is: live streams
 * ({@link HlsLiveStreamError}), any encryption or HDCP requirement ({@link HlsProtectedStreamError};
 * Mergelane never fetches keys or decrypts), more than {@link MAX_SEGMENTS} segments or masters
 * nested more than {@link MAX_MASTER_NESTING} deep ({@link HlsLimitError}).
 *
 * The module is self-contained: it does not touch the download manager, settings or UI.
 *
 * @module
 */

export {
  HlsError,
  HlsHttpError,
  HlsLimitError,
  HlsLiveStreamError,
  HlsPlaylistError,
  HlsProtectedStreamError,
  HlsSegmentError,
  HlsUnsupportedError,
  HlsVariantNotFoundError,
  type HlsErrorCode,
  type HlsLimit
} from './errors'

export {
  MAX_SEGMENTS,
  assertDownloadable,
  parseAttributeList,
  parsePlaylist,
  type ByteRange,
  type HlsPlaylist,
  type InitSection,
  type MasterPlaylist,
  type MediaPlaylist,
  type MediaSegment,
  type Rendition,
  type Variant
} from './parse'

export {
  listVariants,
  selectAudioRendition,
  selectVariant,
  type SelectedVariant,
  type VariantOption,
  type VariantSelection
} from './select'

export {
  createNodeFetch,
  nodeFetch,
  scopeHeaders,
  type HlsBody,
  type HlsFetch,
  type HlsFetchInit,
  type HlsFetchResponse,
  type HlsRange,
  type NodeFetchOptions
} from './http'

export {
  MAX_MASTER_NESTING,
  MAX_PLAYLIST_BYTES,
  fetchPlaylist,
  resolveHls,
  type FetchPlaylistOptions,
  type FetchedPlaylist,
  type ResolveHlsOptions,
  type ResolvedHls
} from './resolve'

export {
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  downloadHls,
  downloadHlsTrack,
  segmentRequests,
  trackIdentity,
  type DownloadHlsOptions,
  type DownloadHlsResult,
  type DownloadTrackOptions,
  type HlsProgress,
  type SegmentRequest,
  type TrackResult
} from './download'
