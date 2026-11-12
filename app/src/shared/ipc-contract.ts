import type { AppUsage } from './appUsage'
import type { BrowserId, BrowsersReport, ExtensionSaved } from './browsers'
import type { NetworkActivity } from './networkActivity'
import type { UpdateChannel } from './releases'
import type {
  AppSettings,
  DownloadUpdate,
  FinishedDownload,
  LoginItemState,
  NetworkInterfaceInfo,
  PendingLink,
  ProbeResult,
  StartDownloadRequest,
  SystemMergeRemoval,
  SystemMergeSnapshot,
  TorrentFileEntry,
  TorrentTrackersResult,
  UpdateState,
  UsenetServer,
  UsenetServerInput
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged, magnetCheckStatus, historyChanged,
 * linkReceived, updateStateChanged, showUpdates, networkActivityChanged and saveDiagnosticsRequested) — one source of truth for
 * both mergelaneApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  /** A .torrent or .nzb file to download from, picked in the OS's dialog. */
  chooseDownloadFile: { args: []; result: string | null }
  readClipboardText: { args: []; result: string }
  /** Shows a download's file in its folder, by the download's own path. False when nothing is
   * there any more: history is re-sent, with it marked missing. */
  revealDownload: { args: [id: string]; result: boolean }
  /** Opens a download's file (a torrent's folder) with the OS default. False when it's gone or
   * nothing could open it. */
  openDownload: { args: [id: string]; result: boolean }
  /** `linkId`: the PendingLink whose browser sign-in it starts with. */
  startDownload: { args: [request: StartDownloadRequest, linkId?: string]; result: string }
  /** Every download, oldest first, each as a snapshot. */
  listDownloads: { args: []; result: DownloadUpdate[] }
  /** Finished downloads, newest first. One is forgotten with removeDownload. */
  listHistory: { args: []; result: FinishedDownload[] }
  /** Forgets every finished download; their files stay. */
  clearHistory: { args: []; result: void }
  /** Bytes each network has received and sent in its selected calendar period, by id (see NetworkPreference.dataLimit). */
  networkUsage: { args: []; result: Record<string, number> }
  /** System-wide merging through mergelane-daemon (main/daemon/daemon.ts). */
  systemMerge: { args: []; result: SystemMergeSnapshot }
  setSystemMerge: { args: [on: boolean]; result: SystemMergeSnapshot }
  /** Installs the bundled helper, or updates an older one (an administrator password prompt). */
  installSystemMerge: { args: []; result: SystemMergeSnapshot }
  /** Turns system merge off, then removes the helper (one administrator password prompt). */
  removeSystemMerge: { args: []; result: SystemMergeRemoval }
  /** Whether merging turns itself back on after the helper restarts. */
  setSystemMergeAutoResume: { args: [enabled: boolean]; result: SystemMergeSnapshot }
  /** Keeps each website on one network while system merge is on, or not (ADR-0048). */
  setSystemMergeStickySites: { args: [enabled: boolean]; result: SystemMergeSnapshot }
  resetNetworkUsage: { args: [id: string]; result: void }
  /** Bytes free on the drive holding `dir`; null when it can't be told. */
  freeSpace: { args: [dir: string]; result: number | null }
  appUsage: { args: []; result: AppUsage }
  /** A torrent download's files, in the torrent's order; empty for any other download. */
  torrentFiles: { args: [id: string]; result: TorrentFileEntry[] }
  /** Which of a torrent download's files to fetch, by index, as it runs or not. Refused for one
   * already downloaded, or with no room on disk for what's added. */
  chooseTorrentFiles: { args: [id: string, selected: number[]]; result: void }
  /** The trackers for a torrent download: default trackers from the metadata, and custom ones added. */
  torrentTrackers: { args: [id: string]; result: TorrentTrackersResult }
  /** Adds custom trackers to a torrent download. */
  addTorrentTrackers: { args: [id: string, trackers: string[]]; result: TorrentTrackersResult }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  /** A fresh link to the same file, for a download whose link stopped working; it resumes. */
  relinkDownload: { args: [id: string, url: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  /** Removes a download, cancelling one under way. A finished one's file stays, unless
   * `trashFile`: then it goes to the Trash. */
  removeDownload: { args: [id: string, options?: { trashFile?: boolean }]; result: void }
  updateState: { args: []; result: UpdateState }
  /** Asks GitHub now; resolves with the state the check ended in. */
  checkForUpdates: { args: []; result: UpdateState }
  setUpdatePreferences: {
    args: [
      preferences: { autoCheck?: boolean; backgroundDownload?: boolean; channel?: UpdateChannel }
    ]
    result: void
  }
  /** Not this version: only a newer one is offered after. */
  skipUpdate: { args: [version: string]; result: void }
  /** Downloads the found update's disk image and checks its SHA-256. */
  downloadUpdate: { args: []; result: void }
  cancelUpdateDownload: { args: []; result: void }
  /** Opens the checked disk image and quits Mergelane. */
  installUpdate: { args: []; result: void }
  /** The found release's page on GitHub, in the browser. */
  openReleasePage: { args: []; result: void }
  /** Looks for the browsers on this Mac, and where the extension for each is saved (M3.4a). */
  browsers: { args: []; result: BrowsersReport }
  /** Saves the extension a browser loads in the chosen folder (ADR-0047). */
  saveExtension: { args: [id: BrowserId]; result: ExtensionSaved }
  /** Saves it, then shows its folder in the Finder. */
  revealExtension: { args: [id: BrowserId]; result: ExtensionSaved }
  /** Asks where to save the extension; the folder chosen, or null if the user cancelled. */
  chooseExtensionLocation: { args: []; result: string | null }
  /** Opens a browser on this Mac, as double-clicking it would. */
  openBrowser: { args: [id: BrowserId]; result: void }
  /** Whether Mergelane opens at login, and what macOS says about it (ADR-0037). */
  loginItem: { args: []; result: LoginItemState }
  setOpenAtLogin: { args: [on: boolean]; result: LoginItemState }
  /** Oldest first: every link not yet started or dismissed. */
  pendingLinks: { args: []; result: PendingLink[] }
  /** Resumes the failed download a link was matched to, from that link (see relinkDownload). */
  resumeFromLink: { args: [linkId: string, downloadId: string]; result: void }
  /** Forgets the sign-in of a link that won't be started. */
  dismissLink: { args: [id: string]; result: void }
  /** The news server NZB downloads come from; null until one is set up. */
  usenetServer: { args: []; result: UsenetServer | null }
  saveUsenetServer: { args: [server: UsenetServerInput]; result: UsenetServer }
  /** Connects and signs in, over the computer's default route; throws what went wrong. */
  testUsenetServer: { args: [server: UsenetServerInput]; result: void }
  /** The networks that dropped or came back, and the day's fastest merged speed, kept across
   * restarts (M3.7). */
  networkActivity: { args: []; result: NetworkActivity }
  /** Asks where to save a diagnostics bundle and saves it there; null when the dialog is
   * cancelled. Only the file's name comes back. */
  saveDiagnostics: { args: []; result: { fileName: string } | null }
  /** Shows the last bundle saved in the Finder. */
  revealDiagnostics: { args: []; result: void }
}
