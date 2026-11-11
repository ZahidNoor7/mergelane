import type { LinkEvent } from '../../../shared/daemon-api'
import type { BrowserContact, BrowserId } from './browsers'
import type { CaptureRules } from './captureRules'
import type { Release, UpdateChannel } from './releases'
import type { ThemeId } from './themes'

export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  /** Used by the existing IPv4 same-subnet warning. */
  subnet?: string
}

/** Light, dark, or 'system' (Auto: follow the Mac), as nativeTheme.themeSource takes it. */
export type ThemeSource = 'system' | 'light' | 'dark'

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}

interface ProbeResultBase {
  requestedUrl: string
  /** URL after following redirects — this is what the download should actually fetch. */
  finalUrl: string
  supportsRanges: boolean
  /** null when the server did not report a size. */
  totalBytes: number | null
  suggestedFileName: string
  contentType: string | null
  /** Strong validators, used to detect if the remote content changes between pause and resume. */
  etag: string | null
  lastModified: string | null
}

export interface HttpProbeResult extends ProbeResultBase {
  kind: 'http'
}

export interface TorrentProbeResult extends ProbeResultBase {
  kind: 'torrent'
  torrent: TorrentInfo
}

export interface NzbProbeResult extends ProbeResultBase {
  kind: 'nzb'
  nzb: NzbInfo
}

/** An HLS or DASH video, or a YouTube video: tracks fetched in segments, joined into one file with
 * FFmpeg once they are in (see main/download/stream/). An HLS or DASH video's size isn't known
 * until it downloads; a YouTube quality's is (StreamVariant.bytes). */
export interface StreamProbeResult extends ProbeResultBase {
  kind: 'stream'
  stream: StreamInfo
}

/** `youtube`: a YouTube video, whose formats the bundled yt-dlp finds (ADR-0026). */
export type StreamProtocol = 'hls' | 'dash' | 'youtube'

/** One quality of a stream, for New download's picker. */
export interface StreamVariant {
  /** What StartStreamDownloadRequest.variantId takes: an HLS variant's id, a DASH video
   * representation's, or a YouTube video's yt-dlp format ids ("137+140", or "18" for one with
   * its sound in it). */
  id: string
  /** Bits per second, as the manifest declares it. */
  bandwidth: number
  width?: number
  height?: number
  frameRate?: number
  /** RFC 6381 codec strings, as the manifest names them. */
  codecs?: string[]
  /** What downloading it takes, in bytes, when that is known before it starts (YouTube's formats
   * say). */
  bytes?: number
}

export interface StreamInfo {
  protocol: StreamProtocol
  /** Best first. Empty when the link offers one quality only (an HLS media playlist). */
  variants: StreamVariant[]
  /** Its length in seconds, when the manifest says. */
  durationSeconds?: number
}

export type ProbeResult = HttpProbeResult | TorrentProbeResult | NzbProbeResult | StreamProbeResult

/** How the check of a magnet link is going, while it's still going: `noPeersYet` once its first
 * search came back empty and it's looking a little longer. */
export interface MagnetCheckStatus {
  /** The link as it was given to probeUrl. */
  link: string
  noPeersYet: boolean
}

export interface TorrentInfo {
  infoHash: string
  pieceLength: number
  /** Where each file will be written, relative to the destination folder, already checked to be
   * safe (see main/download/torrent/paths.ts). */
  files: { path: string; length: number }[]
  /** Trackers listed in the torrent's metadata. */
  trackers?: string[]
  /** Whether the torrent is marked private (BEP 27). */
  isPrivate?: boolean
}

export interface TorrentTrackersResult {
  defaultTrackers: string[]
  customTrackers: string[]
  isPrivate: boolean
}

/** What an NZB holds: Usenet articles, grouped into the files they make up once decoded. */
export interface NzbInfo {
  /** Identifies the NZB among those probed lately (see main/download/nzb/nzbFile.ts). */
  hash: string
  /** Each file as it will be saved in the download's folder, and what its articles add up to:
   * a little more than the file itself, since yEnc encodes it with some overhead. */
  files: { name: string; bytes: number; segments: number }[]
}

/** One of a torrent download's files, for listing them while it runs. */
export interface TorrentFileEntry {
  /** As TorrentInfo's: relative to the destination folder, the torrent's own folder first. */
  path: string
  length: number
  /** Chosen to be downloaded. */
  chosen: boolean
}

/** `queued`: waiting for one of the downloads running at once to end (see
 * AppSettings.downloadsAtOnce). */
export type DownloadStatus =
  'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** An HTTP stream's state. `pending` means it is waiting for work: it holds no block, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one (`currentBlockIndex` says which). A stream that fails for good leaves the list;
 * what went wrong is its network's to report (see DownloadNetwork). */
export type HttpStreamStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'cancelled'

/** One connection to the server, through one network. Streams come and go as the download
 * runs; what a network has done is kept on its DownloadNetwork. */
export interface HttpStreamState {
  id: number
  /** The network it runs on: a DownloadNetwork's id. */
  interfaceId: string
  rangeStart: number
  /** null means an open-ended range (download to end of file). */
  rangeEnd: number | null
  /** New bytes it has delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  status: HttpStreamStatus
  /** The block this stream is fetching. Unset whenever it holds none (idle, retrying, paused, done). */
  currentBlockIndex?: number
  /** True while this stream is racing another stream for `currentBlockIndex`, because that one
   * was too slow — see main/download/scheduler.ts. Whichever finishes first wins. */
  hedge?: boolean
  /** True while this stream is fetching the back part of `currentBlockIndex`, split off from what
   * another stream had left of it — see main/download/scheduler.ts. Each fetches its own part. */
  split?: boolean
}

/** A live BitTorrent peer connection. A peer does not own a piece: it may contribute blocks to
 * several pieces, and several peers may contribute to one piece. */
export interface TorrentPeerState {
  /** Unique in the download, in the order its peers connected: "Peer #(id + 1)". */
  id: number
  interfaceId: string
  status: 'connected' | 'receiving'
  /** The client it runs, as its peer id names it ("qBittorrent 4.6.2"); null when unknown. */
  client: string | null
  bytesDownloaded: number
  speedBytesPerSec: number
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
}

export type HttpBlockStatus = 'pending' | 'downloading' | 'completed'
/** `skipped`: a piece that none of the files chosen for this torrent needs. */
export type TorrentPieceStatus = HttpBlockStatus | 'skipped'

interface WorkUnitState {
  index: number
  rangeStart: number
  rangeEnd: number | null
  /** The network currently leasing this block (or the last one to touch it). Only meaningful
   * as "who is working on it now" — for who actually *delivered* the bytes, read
   * `bytesByInterface`, since a block can be started on one network and finished on another
   * after a retry or a pause/resume. */
  interfaceId?: string
  bytesDownloaded: number
  /** Bytes of this block delivered by each network, keyed by interface id. Summing to
   * `bytesDownloaded`, this is what the block grid colors by, so a block split across
   * networks is attributed to all of them instead of only the one that happened to finish it. */
  bytesByInterface: Record<string, number>
}

export interface HttpBlockState extends WorkUnitState {
  kind: 'http'
  status: HttpBlockStatus
}

export interface TorrentPieceState extends WorkUnitState {
  kind: 'torrent'
  status: TorrentPieceStatus
  /** Bytes received in this run but not yet hash-verified. This is live activity, not durable
   * progress, and may fall back to zero after a failed verification. */
  provisionalBytes: number
}

/** `missing`: the news server no longer has the article, or sent it damaged. What the article
 * held is left as zeros in its file, for a par2 repair to restore. */
export type NzbSegmentStatus = HttpBlockStatus | 'missing'

/** One Usenet article of an NZB download. Its range is in the NZB's own byte count, the articles
 * as posted, one after the other: the files' real sizes are only known once they come in. */
export interface NzbSegmentState extends WorkUnitState {
  kind: 'nzb'
  status: NzbSegmentStatus
}

/** One request of a stream download: its video or audio track's initialization section, or one of
 * its segments. Its size is known from the start only for a byte range of a file; any other is
 * open-ended (`rangeEnd` null) until it is in. A segment only ever counts whole. */
export interface StreamSegmentState extends WorkUnitState {
  kind: 'stream'
  status: HttpBlockStatus
}

export type DownloadUnitState =
  HttpBlockState | TorrentPieceState | NzbSegmentState | StreamSegmentState

/**
 * - on: in use.
 * - off: the user switched it off. A network that turns up mid-download starts off.
 * - offline: not connected to this computer. It's used again as soon as it is.
 * - unreachable: connected, but the server can't be reached through it. One connection keeps
 *   trying, and the rest follow once it gets through.
 * - failed: the server kept refusing requests over it (`error` says how). Switching it off and
 *   on, reconnecting it, or resuming tries again.
 * - limit: it has used up its data for the chosen period (NetworkPreference.dataLimit). It's used again
 *   once the period ends or the limit is raised.
 * - routed: Networks' "Downloads use" sends every download over another network (DownloadRouting). The
 *   download's own choice (`enabled`) is kept for when routing is back on all networks.
 */
export type NetworkStatus = 'on' | 'off' | 'offline' | 'unreachable' | 'failed' | 'limit' | 'routed'

/** Networks › Which network carries what (the final design's RoutingPanel, ADR-0040 and ADR-0041). */
export interface DownloadRouting {
  /** 'all': every download uses the networks it has on; otherwise a NetworkInterfaceInfo id that
   * every download goes over, the running ones included. */
  down: string
  /** 'all': a torrent uploads over the networks it downloads over; otherwise a NetworkInterfaceInfo
   * id that every torrent upload goes out over, whichever network downloads use (ADR-0041). */
  up: string
  /** When the chosen network is gone: true, transfers use their own networks meanwhile; false, they
   * wait for it. One switch for both directions, as the design has it. */
  fallback: boolean
}

export const DEFAULT_ROUTING: DownloadRouting = { down: 'all', up: 'all', fallback: true }

/** A network as one download sees it: whether the user has it on, and how it is doing. */
interface DownloadNetworkBase {
  /** A NetworkInterfaceInfo id. */
  id: string
  /** Its name and kind as the OS last reported them. */
  label: string
  kind: NetworkInterfaceKind
  /** The user's choice; `status` is what came of it. */
  enabled: boolean
  status: NetworkStatus
  error?: string
  /** Bytes of the file it delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Requests over it that failed and were tried again. */
  retries: number
}

export interface HttpDownloadNetwork extends DownloadNetworkBase {
  transfer: 'http'
}

export interface TorrentDownloadNetwork extends DownloadNetworkBase {
  transfer: 'torrent'
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
}

export type DownloadNetwork = HttpDownloadNetwork | TorrentDownloadNetwork

interface DownloadStateBase {
  id: string
  url: string
  fileName: string
  destinationPath: string
  /** 0 means the size could not be determined ahead of time. */
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Seconds left at this speed, smoothed (see updateTimeLeft); unset when there's no telling:
   * the size unknown, or nothing moving. */
  timeLeftSeconds?: number
  status: DownloadStatus
  error?: string
  /** For an error: whether resuming can pick up where it stopped. False when the progress was
   * thrown away, e.g. the file changed on the server. */
  resumable?: boolean
  startedAt: number
  /** Enrolled in the scheduled queue; survives relaunches until manually paused. */
  scheduled?: boolean
  /** While queued: its place in the queue, lowest first. */
  queuedAt?: number
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** Each network's speed, by network id, sampled once a second over the last minute it ran.
   * Every series is as long as the others, so they line up in time. */
  speedHistory?: Record<string, number[]>
  /** The best combined speed held for a few seconds, so it only ever rises; unset until it has
   * run that long. A download done sooner gets the best speed it showed. */
  peakSpeedBytesPerSec?: number
  /** The update this state is as of (see DownloadUpdate). */
  seq?: number
}

export interface HttpDownloadState extends DownloadStateBase {
  kind: 'http'
  networks: HttpDownloadNetwork[]
  streams: HttpStreamState[]
  peakStreams: number
  blocks: HttpBlockState[]
  totalBlocks: number
  blockSizeBytes: number
  /** The disk can't keep up: most streams are waiting for their writes (see concurrency.ts). */
  diskLimited?: boolean
  fromBrowser?: string
}

export interface TorrentDownloadState extends DownloadStateBase {
  kind: 'torrent'
  networks: TorrentDownloadNetwork[]
  peers: TorrentPeerState[]
  peakPeers: number
  pieces: TorrentPieceState[]
  totalPieces: number
  pieceLength: number
  /** How many files it has, how many are chosen, and which (by index; unset: every one). */
  files: { chosen: number; total: number; selected?: number[] }
  /** Its files come in the torrent's folder (`fileName`), rather than as one file. */
  folder: boolean
  /** Of `totalBytes`, the bytes of pieces that no chosen file needs. */
  skippedBytes: number
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
}

/** One file of an NZB download. */
export interface NzbFileState {
  /** As it is saved, in the download's folder. */
  name: string
  /** What its articles add up to, as the NZB counts them. */
  bytes: number
  /** Its real size, from its articles' yEnc headers; unset until one has come in. */
  size?: number
  segments: number
  /** Articles the server didn't have, or sent damaged (see NzbSegmentStatus). */
  missing: number
}

/** A Usenet download: an NZB's articles, fetched over connections to the user's news server. Its
 * streams are those connections, its blocks the articles. */
export interface NzbDownloadState extends DownloadStateBase {
  kind: 'nzb'
  networks: HttpDownloadNetwork[]
  streams: HttpStreamState[]
  peakStreams: number
  blocks: NzbSegmentState[]
  totalBlocks: number
  nzbFiles: NzbFileState[]
  /** Of `totalBytes`, the bytes of articles that are missing. */
  missingBytes: number
  /** The news server it downloads from, by host name. */
  server: string
}

/** An HLS or DASH video: its segments fetched over every network in use, then joined into one
 * file with FFmpeg. Its streams are the segment requests in flight, its blocks the segments, the
 * video track's first. `totalBytes` is an estimate until every segment is in. */
export interface StreamDownloadState extends DownloadStateBase {
  kind: 'stream'
  protocol: StreamProtocol
  /** The quality being downloaded, e.g. "1080p"; unset when the link offers one only. */
  quality?: string
  networks: HttpDownloadNetwork[]
  streams: HttpStreamState[]
  peakStreams: number
  blocks: StreamSegmentState[]
  totalBlocks: number
  /** How many of the blocks each track has, the main (video) track's first, then any separate
   * audio track's. */
  trackSegments: number[]
  /** RFC 6381 codecs of what is downloaded, as the manifest declares them: what decides MP4 or
   * MKV, kept so the tracks can be joined without asking the server again. */
  codecs: string[]
  /** Its length in seconds, when the manifest says. */
  durationSeconds?: number
  /** Every segment is in, and FFmpeg is joining the tracks into the file. */
  muxing?: boolean
  fromBrowser?: string
}

export type DownloadState =
  HttpDownloadState | TorrentDownloadState | NzbDownloadState | StreamDownloadState

/** A finished download as history keeps it: its state without the work units and connections,
 * which only a running download needs. */
export type FinishedDownload = (
  | Omit<HttpDownloadState, 'blocks' | 'streams'>
  | Omit<TorrentDownloadState, 'pieces' | 'peers'>
  | Omit<NzbDownloadState, 'blocks' | 'streams'>
  | Omit<StreamDownloadState, 'blocks' | 'streams'>
) & {
  /** The blocks or pieces it was written in (a torrent's: those its chosen files needed; an
   * NZB's: its articles that came in). */
  unitsWritten: number
  /** Set when listed: its file or folder is no longer where it was saved. */
  missing?: boolean
  /** Chosen torrent files (or an NZB's files) relative to its destination folder, retained for
   * safe file removal. */
  downloadedFiles?: string[]
}

/** What the main process sends as a download changes: everything but its blocks, and only the
 * blocks that changed since it last sent. A download can have tens of thousands of blocks, and
 * copying every one several times a second would cost the process that carries every byte. A
 * snapshot is the same with every block in it. */
export interface HttpDownloadUpdate {
  seq: number
  state: Omit<HttpDownloadState, 'blocks'>
  blocks: HttpBlockState[]
}

export interface TorrentDownloadUpdate {
  seq: number
  state: Omit<TorrentDownloadState, 'pieces'>
  pieces: TorrentPieceState[]
}

export interface NzbDownloadUpdate {
  seq: number
  state: Omit<NzbDownloadState, 'blocks'>
  blocks: NzbSegmentState[]
}

export interface StreamDownloadUpdate {
  seq: number
  state: Omit<StreamDownloadState, 'blocks'>
  blocks: StreamSegmentState[]
}

export type DownloadUpdate =
  HttpDownloadUpdate | TorrentDownloadUpdate | NzbDownloadUpdate | StreamDownloadUpdate

/** User customization for one physical network, keyed by NetworkInterfaceInfo.id — lets a
 * cryptic OS device name (e.g. "feth0") get a real label, and a color distinct from its
 * kind's default. Persisted in the main process, independent of any single download. */
export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5'

export interface ProxyConfig {
  enabled: boolean
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

export type DataLimitPeriod = 'day' | 'week' | 'month'

export interface NetworkPreference {
  customName?: string
  /** One of the app's curated swatch ids (see NETWORK_COLOR_SWATCHES) — not a raw hex, so every
   * swatch is guaranteed to have a legible on-solid text color already picked out for it. */
  colorId?: string
  /** Optional per-interface proxy configuration. */
  proxy?: ProxyConfig
  /** Left out of the last download started, so New download starts without it too (it remembers
   * the last pick, like the folder). A click there puts it back. */
  off?: boolean
  /** Bytes a second all downloads together may take over it. */
  speedLimit?: number
  /** Bytes a second all torrent uploads together may send over it (ADR-0041). */
  uploadLimit?: number
  /** Bytes Mergelane may receive in the chosen calendar period. */
  dataLimit?: number
  /** Defaults to month for existing settings. Weeks start Monday in local time. */
  dataLimitPeriod?: DataLimitPeriod
}

export type NetworkPreferences = Record<string, NetworkPreference>

/** One link as system-wide merging sees it (from mergelane-daemon). Rates are bytes per second of
 * traffic the daemon merged, not everything on the link. */
export interface SystemMergeLink {
  name: string
  state: 'up' | 'unknown' | 'down'
  rxBps: number
  txBps: number
  activeFlows: number
}

/** One change in a link's state, as mergelane-daemon logged it (its `events` method): `at`
 * (RFC 3339), `link`, `from` and `to` (`gone` while the interface isn't there), and `reason`. */
export type SystemMergeLinkEvent = LinkEvent

/** A time a link stopped carrying traffic (lost its internet, or disappeared), and when it came
 * back. Built from the event log (see main/daemon/snapshot.ts). */
export interface SystemMergeOutage {
  link: string
  /** `gone` once the link itself disappeared during the outage. */
  kind: 'down' | 'gone'
  /** When it stopped, RFC 3339. */
  at: string
  /** When it was up again; absent while it is still out. */
  backAt?: string
  /** Why it stopped: the daemon's reason for the first change, e.g. `probe-failed` or `lost`. */
  reason: LinkEvent['reason']
}

/** System-wide merging, as the app shows it (see main/daemon/daemon.ts). */
export interface SystemMergeSnapshot {
  /** The helper is installed in /Library (done once, with an administrator password). */
  installed: boolean
  /** The helper answered just now. */
  reachable: boolean
  state: 'off' | 'on' | 'starting' | 'stopping'
  /** Why merging is off when nobody asked for that, e.g. another VPN is on. */
  reason?: string
  /** The last request that failed, in words for the user. */
  error?: string
  links: SystemMergeLink[]
  /** This app's version, which the bundled helper shares. */
  appVersion: string
  /** The running helper's version, when it answered. */
  helperVersion?: string
  /** The running helper isn't the one this app bundles: another version, another protocol, or
   * missing a method the app uses. Installing again (the Update button) replaces it. */
  helperOutdated: boolean
  /** Whether merging turns itself back on after the helper restarts (ADR-0007's setting); absent
   * when the helper is too old to have it. */
  autoResume?: boolean
  /** The daemon's recent link changes, oldest first; empty when it can't say. */
  events: SystemMergeLinkEvent[]
  /** The same log as outages, oldest first: what the failover history shows. */
  outages: SystemMergeOutage[]
}

/** Where the app's own update is (main/updater.ts, docs/DECISIONS.md ADR-0036). */
export interface UpdateState {
  /** idle: not checked since launch, or a found version was skipped; current: the check found
   * nothing newer; available: `latest` is newer; downloading, then verifying (its SHA-256), then
   * ready: `latest`'s disk image is downloaded and checked, waiting to be opened; error: a check or
   * a download failed (`error` says why). */
  status:
    'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'verifying' | 'ready' | 'error'
  /** This app's version. */
  version: string
  channel: UpdateChannel
  /** Check once a day while the app runs. */
  autoCheck: boolean
  /** With automatic checks, download a found update by itself (installing still waits). */
  backgroundDownload: boolean
  /** Bytes of the disk image downloaded so far, while downloading. */
  progress: { received: number; total: number } | null
  /** When GitHub last answered a check; null if it never has. */
  lastChecked: number | null
  /** The newer release, while status is 'available'. */
  latest: Release | null
  /** The version the user chose to skip. */
  skipped: string | null
  /** What went wrong, in plain words, while status is 'error'. */
  error: string | null
}

/** What macOS says about Mergelane opening at login (app.getLoginItemSettings().status), or
 * 'unavailable' in a build that never registers itself (development, tests, not macOS). */
export type LoginItemStatus =
  'enabled' | 'requires-approval' | 'not-registered' | 'not-found' | 'unavailable'

export interface LoginItemState {
  on: boolean
  status: LoginItemStatus
}

/** A repeating window for all transfers, interpreted in the computer's local timezone. */
export interface DownloadSchedule {
  enabled: boolean
  /** Minutes since local midnight. Equal start/stop times are invalid. */
  startMinute: number
  endMinute: number
  /** Days on which a window starts, Sunday = 0. */
  days: number[]
  /** Last local date on which a window may start (YYYY-MM-DD). */
  endDate?: string
}

/** What app-settings.json holds, and what the renderer sends to change it (merged over the saved
 * values, `undefined` clearing one). A missing field was never set. */
export interface AppSettings {
  downloadSchedule?: DownloadSchedule
  themeSource?: ThemeSource
  /** The colour theme (shared/themes.ts). Missing or unknown means the default, Porcelain. */
  appearanceTheme?: ThemeId
  /** Settings › Browser extensions › What the extension does (ADR-0039). Missing: the defaults. */
  captureRules?: CaptureRules
  /** When each browser's extension last reached Mergelane, and its version (ADR-0039). */
  browserContacts?: Partial<Record<BrowserId, BrowserContact>>
  /** Networks › Which network carries what. Missing: every network, with fallback. */
  routing?: DownloadRouting
  /** Only ever saved as false: the menu bar shows the merged speed unless turned off (ADR-0037). */
  menuBarSpeed?: boolean
  /** Only ever saved as false: a finished download posts a notification unless turned off. */
  notifyWhenDone?: boolean
  /** Only ever saved as false: Mergelane checks for updates once a day unless turned off. */
  updateAutoCheck?: boolean
  /** Only ever saved as 'beta': Stable is the default. */
  updateChannel?: UpdateChannel
  /** Only ever saved as true: downloading found updates by themselves is off unless turned on. */
  updateBackgroundDownload?: boolean
  /** A version the user chose to skip. */
  updateSkipped?: string
  /** When GitHub last answered an update check, in milliseconds since the epoch. */
  updateLastChecked?: number
  /** The last destination folder picked. */
  destinationDir?: string
  /** User customizations (name/color) per network interface id. */
  networkPreferences?: NetworkPreferences
  /** How many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce?: number
  /** Bytes a second every download together may take, over every network; unset: no limit. */
  speedLimit?: number
  /** Bytes a second every torrent upload together may send, over every network; unset: no limit.
   * Slow mode doesn't touch it (ADR-0041). */
  uploadLimit?: number
  /** While on, slowModeSpeed stands in for speedLimit: a one-click lower limit for calls. */
  slowMode?: boolean
  slowModeSpeed?: number
  /** How speeds are shown everywhere; sizes stay in bytes either way. */
  speedUnit?: SpeedUnit
  browserExtensionUsed?: boolean
  /** The Liquid Glass theme's look: clear (the default) or tinted, thicker glass. */
  glassLook?: GlassLook
  /** Liquid Glass drawn solid, as Reduce Transparency does; only ever saved as true. */
  solidGlass?: boolean
}

export type GlassLook = 'clear' | 'tinted'

/** bytes: MB/s. bits: Mbps, as internet plans and speed tests count them. */
export type SpeedUnit = 'bytes' | 'bits'

export const DOWNLOADS_AT_ONCE = { default: 2, min: 1, max: 4 }
/** Seconds of speed history a download keeps (a sample a second), and so the span the throughput
 * chart always shows. */
export const SPEED_HISTORY_SECONDS = 60
export const DEFAULT_SLOW_MODE_SPEED = 2 * 1024 ** 2

/** Everything the renderer needs for its first paint, read synchronously by the preload so no
 * saved value flashes in over a default a moment after launch. */
export interface InitialState {
  downloadSchedule?: DownloadSchedule
  homeDir: string
  downloadsDir: string
  themeSource: ThemeSource
  appearanceTheme: ThemeId
  networkPreferences: NetworkPreferences
  downloadsAtOnce: number
  speedLimit?: number
  uploadLimit?: number
  slowMode: boolean
  slowModeSpeed: number
  speedUnit: SpeedUnit
  glassLook: GlassLook
  solidGlass: boolean
  menuBarSpeed: boolean
  notifyWhenDone: boolean
  captureRules: CaptureRules
  routing: DownloadRouting
  /** The last folder picked, if it still exists — otherwise the renderer uses downloadsDir. */
  destinationDir?: string
}

interface StartDownloadRequestBase {
  url: string
  destinationDir: string
  suggestedFileName: string
  /** 0 means unknown. */
  totalBytes: number
  supportsRanges: boolean
  /** The networks to start on. Every other one starts switched off. */
  interfaceIds: string[]
  etag: string | null
  lastModified: string | null
}

export interface StartHttpDownloadRequest extends StartDownloadRequestBase {
  kind: 'http'
  /** Streams per network the user picked; left out, the count is decided automatically. */
  streamsPerNetwork?: number
  browser?: BrowserContext
}

/** The fields of chrome.cookies.Cookie that decide where it's sent. */
export interface BrowserCookie {
  name: string
  value: string
  /** With or without a leading dot: `hostOnly` decides whether subdomains get it. */
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
}

/** So a link that needs a signed-in session, or checks the page it came from, works as it does
 * in the browser. */
export interface BrowserContext {
  cookies: BrowserCookie[]
  referer?: string
  userAgent?: string
  name?: string
}

export interface PendingLink {
  id: string
  url: string
  /** Reused by New download: checking a single-use link again would spend it. */
  probe?: ProbeResult
  from?: string
  signedInTo?: string
  /** A failed download this looks like the same file as, for the user to resume instead. */
  resumes?: { id: string; fileName: string }
}

export interface StartTorrentDownloadRequest extends StartDownloadRequestBase {
  kind: 'torrent'
  /** The download starts from the .torrent retained when this info hash was probed. */
  infoHash: string
  /** For a torrent: the files to download, as indexes into its probe's `files`. Left out: all. */
  selectedFiles?: number[]
}

export interface StartNzbDownloadRequest extends StartDownloadRequestBase {
  kind: 'nzb'
  /** The download starts from the NZB retained when it was probed (see NzbInfo.hash). */
  nzbHash: string
}

export interface StartStreamDownloadRequest extends StartDownloadRequestBase {
  kind: 'stream'
  protocol: StreamProtocol
  /** The quality picked, a StreamVariant's id; left out: the best. */
  variantId?: string
  browser?: BrowserContext
}

export type StartDownloadRequest =
  | StartHttpDownloadRequest
  | StartTorrentDownloadRequest
  | StartNzbDownloadRequest
  | StartStreamDownloadRequest

/** The news server NZB downloads come from, as the window sees it: never its password. */
export interface UsenetServer {
  /** NZBs download from it; off, an NZB link downloads as a plain file. */
  enabled: boolean
  host: string
  port: number
  tls: boolean
  username: string
  /** How many connections the server allows at once, for every network together. */
  connections: number
  /** A password is set. */
  hasPassword: boolean
  /** Its password is kept only until Mergelane quits: this computer offers no keychain to seal it
   * with (see main/download/nzb/usenetServer.ts). */
  passwordInMemory?: boolean
}

/** What the window sends to set the news server, or to test one. `password` or `enabled` left out
 * keeps the one already saved. */
export interface UsenetServerInput {
  enabled?: boolean
  host: string
  port: number
  tls: boolean
  username: string
  connections: number
  password?: string
}
