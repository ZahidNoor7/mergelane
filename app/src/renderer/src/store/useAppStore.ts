import { applyDownloadUpdate } from '@shared/downloadUpdate'
import { describeError } from '@shared/errors'
import type {
  AppSettings,
  DownloadSchedule,
  DownloadRouting,
  DownloadState,
  DownloadUpdate,
  FinishedDownload,
  GlassLook,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  PendingLink,
  SpeedUnit,
  ThemeSource,
  UpdateState
} from '@shared/types'
import { create } from 'zustand'
import { NO_FILTERS, type DownloadFilters } from '@shared/downloadFilters'
import type { CaptureRules } from '@shared/captureRules'
import type { ThemeId } from '@shared/themes'
import { fadeTheme } from '../theme/appearance'
import type { DailyFastest, NetworkActivity, NetworkEvent } from '@shared/networkActivity'

/** A diagnostics bundle being saved, saved (its file's name), or not (why). */
export type DiagnosticsState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; fileName: string }
  | { status: 'error'; error: string }

export type DownloadFilter = 'all' | 'progress' | 'finished' | 'failed'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The window's places (the sidebar's): the downloads, the dashboard, the networks or settings. */
export type Screen = 'downloads' | 'dashboard' | 'networks' | 'settings'

/** Settings' sections. */
export type SettingsSection = 'general' | 'appearance' | 'downloads' | 'extensions' | 'updates'

interface AppStore {
  interfaces: NetworkInterfaceInfo[]
  interfacesStatus: LoadStatus
  interfacesError: string | null
  /** Networks that dropped, came back or turned up in the last week, oldest first: the main
   * process keeps them across restarts (main/networkActivity.ts, ADR-0042). */
  networkEvents: NetworkEvent[]
  /** The fastest merged speed of the day it names, kept the same way. */
  fastestMerged: DailyFastest | undefined
  receiveNetworkActivity: (activity: NetworkActivity) => void
  /** Settings › General › Diagnostics: the last save, or one under way. */
  diagnostics: DiagnosticsState
  /** Asks where to save a diagnostics bundle (main shows the dialog) and saves it there. */
  saveDiagnostics: () => Promise<void>
  /** User customizations (name/color) per network interface id — persisted in the main process. */
  networkPreferences: NetworkPreferences

  /** Persisted in the main process alongside nativeTheme.themeSource. 'system' is Auto. */
  themeSource: ThemeSource
  /** The colour theme (shared/themes.ts), set on <html data-palette>. Persisted. */
  appearanceTheme: ThemeId

  homeDir: string
  downloadsDir: string

  /** Every download that isn't finished, by id — running, queued, paused or failed. */
  downloads: Record<string, DownloadState>
  /** Finished downloads, newest first (see main/download/history.ts). */
  history: FinishedDownload[]
  /** The place the window shows. */
  screen: Screen
  /** The section Settings shows. */
  settingsSection: SettingsSection
  /** Mergelane's own update, as main/updater.ts reports it; null until it first answers. */
  update: UpdateState | null
  setUpdate: (update: UpdateState) => void
  /** Goes to Settings, at a section when one is given. */
  openSettings: (section?: SettingsSection) => void
  /** The download whose details show: beside the list in a wide window, or in its place in a
   * narrow one while `detailOpen`. */
  selectedId: string | null
  /** A narrow window shows the selected download's details instead of the list. */
  detailOpen: boolean
  /** The list's status tab. */
  downloadFilter: DownloadFilter
  setDownloadFilter: (filter: DownloadFilter) => void
  /** The list's filters by date added and file type, kept while the window is open. */
  downloadFilters: DownloadFilters
  setDownloadFilters: (patch: Partial<DownloadFilters>) => void
  clearDownloadFilters: () => void
  downloadSchedule: DownloadSchedule | undefined
  /** The New download dialog, over whatever the window shows. */
  newDownloadOpen: boolean
  /** Persisted — how many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce: number
  /** Persisted — the speed limits (see AppSettings). */
  speedLimit: number | undefined
  /** Torrent uploads, every network together; set in Speed & data limits (ADR-0041). */
  uploadLimit: number | undefined
  slowMode: boolean
  slowModeSpeed: number
  /** Persisted — MB/s or Mbps, for every speed shown. */
  speedUnit: SpeedUnit

  /** Lifted out of the Idle screen so it survives a swap to/from the No-connections screen. */
  draftUrl: string
  /** Handed-over links stacked in New download, oldest first. */
  links: PendingLink[]
  /** Null while New download shows a link typed or pasted there instead. Links are named by
   * id, never by position: the list changes while a start is under way. */
  shownId: string | null
  /** Bumped to remount New download's form for another link. */
  formKey: number
  /** The link last started: still on the clipboard afterwards, so not offered again. */
  startedUrl: string
  /** Persisted — the last folder picked, falling back to downloadsDir. */
  destinationDir: string

  /** Asks the main process for the network list now; it also pushes every change. */
  loadInterfaces: () => Promise<void>
  receiveInterfaces: (interfaces: NetworkInterfaceInfo[]) => void
  setNetworkPreference: (id: string, patch: NetworkPreference) => void
  setThemeSource: (source: ThemeSource) => void
  setAppearanceTheme: (theme: ThemeId) => void
  /** A snapshot or an update of a download, from the main process. */
  receiveDownloadUpdate: (update: DownloadUpdate) => void
  /** Finished downloads as main lists them; any that finished leave `downloads`. */
  receiveHistory: (history: FinishedDownload[]) => void
  /** Drops a download from the window's view once the main process has removed it. */
  forgetDownload: (id: string) => void
  /** Goes to a place; in a narrow window, back to the list rather than a download's details. */
  setScreen: (screen: Screen) => void
  /** Shows a download's details, on the Downloads place. */
  openDownload: (id: string) => void
  /** Back to the list, in a narrow window. The download stays selected for a wide one. */
  closeDownload: () => void
  /** Opens New download, with `link` in its link field when one is given. */
  openNewDownload: (link?: string) => void
  closeNewDownload: () => void
  receiveLinks: () => Promise<void>
  showLink: (id: string) => void
  /** If it was the one shown, the newest left is shown, or New download closes. */
  finishLink: (id: string, started: boolean) => void
  /** Leaves what New download shows alone, the typed link included. */
  dropLink: (id: string, started: boolean) => void
  setDownloadsAtOnce: (count: number) => void
  /** Each one applies at once, to every download (see main/network/limits.ts). */
  setSpeedLimit: (bytesPerSec: number | undefined) => void
  setSlowMode: (on: boolean) => void
  setSlowModeSpeed: (bytesPerSec: number) => void
  setSpeedUnit: (unit: SpeedUnit) => void
  /** The Liquid Glass theme's look, and whether it's drawn solid (Settings › Appearance). */
  glassLook: GlassLook
  setGlassLook: (look: GlassLook) => void
  solidGlass: boolean
  setSolidGlass: (solid: boolean) => void
  /** Settings › General › On this Mac (ADR-0037). */
  menuBarSpeed: boolean
  setMenuBarSpeed: (on: boolean) => void
  notifyWhenDone: boolean
  setNotifyWhenDone: (on: boolean) => void
  /** Settings › Browser extensions › What the extension does (ADR-0039). */
  captureRules: CaptureRules
  setCaptureRules: (patch: Partial<CaptureRules>) => void
  /** Networks › Which network carries what (ADR-0040). */
  routing: DownloadRouting
  setRouting: (patch: Partial<DownloadRouting>) => void
  /** Persisted — Settings › Downloads › Offer links I copy (ADR-0043). Off unless turned on. */
  offerCopiedLinks: boolean
  setOfferCopiedLinks: (on: boolean) => void
  /** A link the user copied, offered for download; null when there's none. Kept in memory only. */
  copiedLink: string | null
  /** From main, as the user switched to Mergelane. Passed over when it's already being added or
   * was downloaded. */
  offerCopiedLink: (link: string) => void
  dismissCopiedLink: () => void
  /** Opens New download with the offered link in it. */
  downloadCopiedLink: () => void
  setDraftUrl: (url: string) => void
  setDestinationDir: (dir: string) => void
}

// Settings saved by the main process, read once before the first paint (see InitialState).
const initial = window.mergelane.initialState

/** Every setting changes optimistically: the store is updated first so the UI feels instant,
 * then this saves it. The store stays the source of truth either way — a failed save just means
 * the change isn't remembered next launch. */
function persist(patch: AppSettings): void {
  window.mergelane.updateSettings(patch).catch(() => {})
}

/** Links let go here: a listing main sent before it heard so would bring them back. */
const letGo = new Set<string>()

export const useAppStore = create<AppStore>((set, get) => ({
  interfaces: [],
  interfacesStatus: 'idle',
  interfacesError: null,
  networkEvents: [],
  fastestMerged: undefined,
  receiveNetworkActivity: (activity) =>
    set({ networkEvents: activity.events, fastestMerged: activity.fastest }),
  diagnostics: { status: 'idle' },
  saveDiagnostics: async () => {
    if (get().diagnostics.status === 'saving') return
    const before = get().diagnostics
    set({ diagnostics: { status: 'saving' } })
    try {
      const saved = await window.mergelane.saveDiagnostics()
      // Cancelled: what was said before stays.
      set({ diagnostics: saved ? { status: 'saved', fileName: saved.fileName } : before })
    } catch (error) {
      set({ diagnostics: { status: 'error', error: describeError(error) } })
    }
  },
  networkPreferences: initial.networkPreferences,
  themeSource: initial.themeSource,
  appearanceTheme: initial.appearanceTheme,

  homeDir: initial.homeDir,
  downloadsDir: initial.downloadsDir,

  downloads: {},
  history: [],
  screen: 'downloads',
  settingsSection: 'general',
  update: null,
  setUpdate: (update) => set({ update }),
  openSettings: (section) =>
    set((store) => ({
      screen: 'settings',
      settingsSection: section ?? store.settingsSection,
      detailOpen: false
    })),
  selectedId: null,
  detailOpen: false,
  downloadFilter: 'all',
  setDownloadFilter: (downloadFilter) => set({ downloadFilter }),
  downloadFilters: NO_FILTERS,
  setDownloadFilters: (patch) =>
    set((store) => ({ downloadFilters: { ...store.downloadFilters, ...patch } })),
  clearDownloadFilters: () => set({ downloadFilters: NO_FILTERS }),
  downloadSchedule: initial.downloadSchedule,
  newDownloadOpen: false,
  downloadsAtOnce: initial.downloadsAtOnce,
  speedLimit: initial.speedLimit,
  uploadLimit: initial.uploadLimit,
  slowMode: initial.slowMode,
  slowModeSpeed: initial.slowModeSpeed,
  speedUnit: initial.speedUnit,

  draftUrl: '',
  links: [],
  shownId: null,
  formKey: 0,
  startedUrl: '',
  destinationDir: initial.destinationDir ?? initial.downloadsDir,

  loadInterfaces: async () => {
    // A re-scan keeps showing the last result rather than flashing back to 'loading'.
    if (get().interfacesStatus !== 'ready') set({ interfacesStatus: 'loading' })
    set({ interfacesError: null })
    try {
      get().receiveInterfaces(await window.mergelane.listInterfaces())
    } catch (error) {
      set({
        interfacesStatus: 'error',
        interfacesError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  receiveInterfaces: (interfaces) => {
    // The main process logs what came and went (receiveNetworkActivity).
    set({ interfaces, interfacesStatus: 'ready', interfacesError: null })
  },

  // An explicit `undefined` in `patch` clears that field; main drops an entry left with neither.
  setNetworkPreference: (id, patch) => {
    const networkPreferences = {
      ...get().networkPreferences,
      [id]: { ...get().networkPreferences[id], ...patch }
    }
    set({ networkPreferences })
    persist({ networkPreferences })
  },

  setThemeSource: (themeSource) => {
    fadeTheme(document)
    set({ themeSource })
    persist({ themeSource })
  },

  setAppearanceTheme: (appearanceTheme) => {
    fadeTheme(document)
    document.documentElement.dataset.palette = appearanceTheme
    set({ appearanceTheme })
    persist({ appearanceTheme })
  },

  receiveDownloadUpdate: (update) => {
    const { downloads, history } = get()
    // Finished already: an update that arrives late mustn't bring it back.
    if (history.some((entry) => entry.id === update.state.id)) return
    const previous = downloads[update.state.id] ?? null
    const download = applyDownloadUpdate(previous, update)
    if (!download || download === previous) return
    set({ downloads: { ...downloads, [download.id]: download } })
  },

  receiveHistory: (history) => {
    const downloads = { ...get().downloads }
    for (const entry of history) delete downloads[entry.id]
    set({ history, downloads })
  },

  forgetDownload: (id) => {
    const { [id]: removed, ...downloads } = get().downloads
    void removed
    set({
      downloads,
      history: get().history.filter((entry) => entry.id !== id),
      // Its details go with it.
      ...(get().selectedId === id ? { selectedId: null, detailOpen: false } : {})
    })
  },

  setScreen: (screen) => set({ screen, detailOpen: false }),
  openDownload: (id) => set({ screen: 'downloads', selectedId: id, detailOpen: true }),
  closeDownload: () => set({ detailOpen: false }),

  openNewDownload: (link) =>
    set(link === undefined ? { newDownloadOpen: true } : { newDownloadOpen: true, draftUrl: link }),

  closeNewDownload: () => {
    const { links, shownId } = get()
    if (shownId) return get().finishLink(shownId, false)
    if (links.length > 0) return get().showLink(links[links.length - 1].id)
    set({ newDownloadOpen: false })
  },

  receiveLinks: async () => {
    // main lists every link still waiting, so a window that was closed or reloaded gets them back.
    const pending = await window.mergelane.pendingLinks().catch(() => [])
    const known = new Set(get().links.map((link) => link.id))
    const arrived = pending.filter((link) => !known.has(link.id) && !letGo.has(link.id))
    if (arrived.length === 0) return
    set({ links: [...get().links, ...arrived], newDownloadOpen: true })
    get().showLink(arrived[arrived.length - 1].id)
  },

  showLink: (id) => {
    const link = get().links.find((candidate) => candidate.id === id)
    if (link) set({ shownId: id, draftUrl: link.url, formKey: get().formKey + 1 })
  },

  finishLink: (id, started) => {
    const wasShown = get().shownId === id
    get().dropLink(id, started)
    if (!wasShown) return
    const left = get().links
    set({ draftUrl: '' })
    if (left.length > 0) get().showLink(left[left.length - 1].id)
    else set({ newDownloadOpen: false })
  },

  dropLink: (id, started) => {
    const { links, shownId } = get()
    if (!links.some((link) => link.id === id)) return
    letGo.add(id)
    // Started, main has already forgotten its sign-in.
    if (!started) void window.mergelane.dismissLink(id).catch(() => {})
    set({
      links: links.filter((link) => link.id !== id),
      ...(shownId === id && { shownId: null })
    })
  },

  setDownloadsAtOnce: (downloadsAtOnce) => {
    set({ downloadsAtOnce })
    persist({ downloadsAtOnce })
  },

  setSpeedLimit: (speedLimit) => {
    set({ speedLimit })
    persist({ speedLimit })
  },

  setSlowMode: (slowMode) => {
    set({ slowMode })
    persist({ slowMode })
  },

  setSlowModeSpeed: (slowModeSpeed) => {
    set({ slowModeSpeed })
    persist({ slowModeSpeed })
  },

  setSpeedUnit: (speedUnit) => {
    set({ speedUnit })
    persist({ speedUnit })
  },

  glassLook: initial.glassLook,
  setGlassLook: (glassLook) => {
    set({ glassLook })
    persist({ glassLook })
  },
  solidGlass: initial.solidGlass,
  setSolidGlass: (solidGlass) => {
    set({ solidGlass })
    // Only ever saved as true: off clears it.
    persist({ solidGlass: solidGlass || undefined })
  },
  menuBarSpeed: initial.menuBarSpeed,
  setMenuBarSpeed: (menuBarSpeed) => {
    set({ menuBarSpeed })
    // Only ever saved as false: on clears it.
    persist({ menuBarSpeed: menuBarSpeed ? undefined : false })
  },
  notifyWhenDone: initial.notifyWhenDone,
  captureRules: initial.captureRules,
  routing: initial.routing,
  setRouting: (patch) => {
    const routing = { ...get().routing, ...patch }
    set({ routing })
    persist({ routing })
  },
  setCaptureRules: (patch) => {
    const captureRules = { ...get().captureRules, ...patch }
    set({ captureRules })
    persist({ captureRules })
  },
  setNotifyWhenDone: (notifyWhenDone) => {
    set({ notifyWhenDone })
    persist({ notifyWhenDone: notifyWhenDone ? undefined : false })
  },

  offerCopiedLinks: initial.offerCopiedLinks,
  setOfferCopiedLinks: (offerCopiedLinks) => {
    // Turned off, an offer already showing goes too.
    set(offerCopiedLinks ? { offerCopiedLinks } : { offerCopiedLinks, copiedLink: null })
    // Only ever saved as true: off clears it.
    persist({ offerCopiedLinks: offerCopiedLinks || undefined })
  },
  copiedLink: null,
  offerCopiedLink: (link) => {
    const { offerCopiedLinks, newDownloadOpen, draftUrl, startedUrl, downloads, history } = get()
    if (!offerCopiedLinks) return
    // Already in New download, or just started from it.
    if ((newDownloadOpen && draftUrl === link) || link === startedUrl) return
    // Downloaded before, or downloading.
    const known = (entry: { url: string }): boolean => entry.url === link
    if (Object.values(downloads).some(known) || history.some(known)) return
    set({ copiedLink: link })
  },
  dismissCopiedLink: () => set({ copiedLink: null }),
  downloadCopiedLink: () => {
    const link = get().copiedLink
    if (link === null) return
    set({ copiedLink: null })
    get().openNewDownload(link)
  },

  setDraftUrl: (draftUrl) => set({ draftUrl }),
  setDestinationDir: (destinationDir) => {
    set({ destinationDir })
    persist({ destinationDir })
  }
}))
