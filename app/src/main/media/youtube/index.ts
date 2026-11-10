/**
 * YouTube videos through the bundled yt-dlp only, with no cookies and no PO tokens (ADR-0026):
 * yt-dlp finds a video's formats (ytdlp.ts, info.ts), each network asks for its own addresses
 * through a loopback proxy pinned to it (proxy.ts, session.ts), and Mergelane's own segmented
 * downloader fetches them (download/stream/streamTransfer.ts) before FFmpeg joins the tracks.
 *
 * Like the mux module, this one doesn't import `electron`, so the e2e suite's Layer B runs it in
 * plain Node.
 *
 * @module
 */

export { SIGN_IN_MESSAGE, YoutubeError, ytDlpFailure, type YoutubeErrorCode } from './errors'
export {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SAFETY_ARGS,
  runYtDlp,
  ytDlpArgs,
  ytDlpEnv,
  type YtDlpOptions
} from './ytdlp'
export {
  MAX_CHUNK_BYTES,
  chooseFormats,
  parseVideo,
  pickAudio,
  readFormat,
  youtubeChoices,
  youtubeVariants,
  type YoutubeChoice,
  type YoutubeFormat,
  type YoutubeVideo
} from './info'
export { startLoopbackProxy, type Dial, type LoopbackProxy } from './proxy'
export {
  EXPIRY_MARGIN_MS,
  MAX_REFRESHES,
  YoutubeNetworkError,
  YoutubeSession,
  formatIdOf,
  trackUri,
  youtubePlan,
  youtubeTrackPlaylist,
  type YoutubePlan,
  type YoutubeSessionOptions,
  type YoutubeTarget
} from './session'
