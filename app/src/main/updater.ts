import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, Menu, net, shell, type BrowserWindow } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import {
  GITHUB_API_VERSION,
  newestUpdate,
  parseVersion,
  RELEASES_URL,
  type UpdateChannel
} from '../shared/releases'
import type { AppSettings, UpdateState } from '../shared/types'
import { saveDiagnostics } from './diagnostics'
import { saveSettings } from './settings'
import { testKnobs } from './testKnobs'
import { downloadDiskImage, publishedChecksum, UpdateFailure } from './updateDownload'

// Mergelane's own updates (docs/DECISIONS.md ADR-0036): GitHub's public Releases API is asked for the
// newest release on the chosen channel, on request and once a day. A found update's disk image is
// downloaded (on request, or by itself when the user chose that), checked against the SHA-256 its
// release publishes, and opened for the user, who drags the new Mergelane over the old one: the app
// never replaces itself.

const DAY_MS = 24 * 60 * 60_000
/** How often the daily check looks at whether a day has passed. */
const TICK_MS = 60 * 60_000
const RELEASE_PAGE = /^https:\/\/github\.com\/ZahidNoor7\/mergelane\/releases\//

let state: UpdateState = {
  status: 'idle',
  version: '0.0.0',
  channel: 'stable',
  autoCheck: true,
  backgroundDownload: false,
  progress: null,
  lastChecked: null,
  latest: null,
  skipped: null,
  error: null
}
let getWindow: () => BrowserWindow | null = () => null
/** The download under way, to cancel it. */
let downloading: AbortController | null = null
/** The checked disk image, once status is 'ready'. */
let readyPath: string | null = null

/** Where update disk images are kept; emptied at every launch. */
const updatesDir = (): string => join(app.getPath('userData'), 'updates')

const busy = (): boolean =>
  state.status === 'downloading' || state.status === 'verifying' || state.status === 'ready'

const headers = (): Record<string, string> => ({ 'User-Agent': `Mergelane/${state.version}` })

export function updateState(): UpdateState {
  return state
}

function set(patch: Partial<UpdateState>): void {
  const before = state
  state = { ...state, ...patch }
  getWindow()?.webContents.send(IpcChannels.updateStateChanged, state)
  if (state.status !== before.status) setAppMenu()
}

function save(patch: AppSettings): void {
  saveSettings(patch).catch((error) =>
    console.error('[mergelane] failed to save the update settings', error)
  )
}

/** GitHub's answer as words for the person reading Settings › Updates. */
class CheckFailure extends Error {}

/** Asks GitHub now. A check already running is joined rather than repeated, and an update being
 * downloaded or ready isn't checked over. */
let running: Promise<UpdateState> | null = null
export function checkForUpdates(): Promise<UpdateState> {
  if (busy()) return Promise.resolve(state)
  running ??= check().finally(() => {
    running = null
  })
  return running
}

async function check(): Promise<UpdateState> {
  set({ status: 'checking', error: null })
  try {
    const response = await net.fetch(testKnobs.releasesUrl ?? RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...headers()
      }
    })
    // GitHub's rate limits answer 403 or 429 (docs: Rate limits for the REST API).
    if (response.status === 403 || response.status === 429) {
      throw new CheckFailure('GitHub asked Mergelane to wait. Try again in an hour.')
    }
    if (!response.ok) {
      throw new CheckFailure(`GitHub answered ${response.status}. Try again later.`)
    }
    const latest = newestUpdate(await response.json(), {
      current: state.version,
      channel: state.channel,
      skipped: state.skipped,
      target: { platform: process.platform, arch: process.arch }
    })
    const lastChecked = Date.now()
    save({ updateLastChecked: lastChecked })
    set({ status: latest ? 'available' : 'current', latest, lastChecked })
    if (latest && state.autoCheck && state.backgroundDownload) void downloadUpdate()
  } catch (error) {
    console.error('[mergelane] update check failed', error)
    set({
      status: 'error',
      error:
        error instanceof CheckFailure
          ? error.message
          : 'Couldn’t reach GitHub. Check your connection and try again.'
    })
  }
  return state
}

/** Automatic checks on or off, background downloads on or off, and the channel. A new channel
 * forgets what the old one found, and stops its download. */
export function setUpdatePreferences(preferences: {
  autoCheck?: boolean
  backgroundDownload?: boolean
  channel?: UpdateChannel
}): void {
  const { autoCheck, backgroundDownload, channel } = preferences
  if (typeof autoCheck === 'boolean' && autoCheck !== state.autoCheck) {
    set({ autoCheck })
    save({ updateAutoCheck: autoCheck ? undefined : false })
  }
  if (typeof backgroundDownload === 'boolean' && backgroundDownload !== state.backgroundDownload) {
    set({ backgroundDownload })
    save({ updateBackgroundDownload: backgroundDownload ? true : undefined })
  }
  if ((channel === 'stable' || channel === 'beta') && channel !== state.channel) {
    forgetDownload()
    set({
      channel,
      latest: null,
      status: state.status === 'checking' ? 'checking' : 'idle',
      error: null
    })
    save({ updateChannel: channel === 'stable' ? undefined : channel })
  }
}

/** Not this version: the next check offers only a newer one. */
export function skipUpdate(version: string): void {
  if (state.latest?.version !== version) return
  forgetDownload()
  set({ skipped: version, latest: null, status: 'idle', progress: null, error: null })
  save({ updateSkipped: version })
}

/** Downloads the found update's disk image and checks its SHA-256: 'downloading', 'verifying',
 * then 'ready', or 'error' with the reason (the update stays offered, to try again). */
export async function downloadUpdate(): Promise<void> {
  const { latest, status } = state
  if (!latest?.dmg || !latest.checksumsUrl || (status !== 'available' && status !== 'error')) return
  const { dmg, checksumsUrl } = latest
  const controller = new AbortController()
  downloading = controller
  set({ status: 'downloading', progress: { received: 0, total: dmg.size }, error: null })
  try {
    const expected = await publishedChecksum(checksumsUrl, dmg.name, {
      headers: headers(),
      signal: controller.signal
    })
    // Progress in steps of half a percent: enough for the bar, without flooding the window.
    let shown = 0
    readyPath = await downloadDiskImage({
      url: dmg.url,
      name: dmg.name,
      size: dmg.size,
      expected,
      dir: updatesDir(),
      headers: headers(),
      signal: controller.signal,
      onProgress: (received) => {
        if (received - shown < dmg.size / 200 && received < dmg.size) return
        shown = received
        set({ progress: { received, total: dmg.size } })
      },
      onVerifying: () => set({ status: 'verifying' })
    })
    set({ status: 'ready', progress: null })
  } catch (error) {
    if (controller.signal.aborted) return
    console.error('[mergelane] update download failed', error)
    set({
      status: 'error',
      progress: null,
      error:
        error instanceof UpdateFailure
          ? error.message
          : 'Couldn’t download the update. Check your connection and try again.'
    })
  } finally {
    if (downloading === controller) downloading = null
  }
}

/** Stops the download; the update is offered again. */
export function cancelUpdateDownload(): void {
  if (!downloading) return
  forgetDownload()
  set({ status: 'available', progress: null, error: null })
}

/** Stops a download under way and forgets a ready disk image. */
function forgetDownload(): void {
  downloading?.abort()
  downloading = null
  readyPath = null
}

/** Opens the checked disk image in the Finder and quits, so the user can drag the new Mergelane
 * over this one; on Windows, starts the checked installer and quits, and the installer replaces
 * this version and opens the new one. Running downloads pause on the way out, as at any quit. */
export async function installUpdate(): Promise<void> {
  if (state.status !== 'ready' || !readyPath) return
  // A test run must never open a disk image on the Mac or quit: it notes what it would open.
  if (testKnobs.updateOpenLog) {
    await appendFile(testKnobs.updateOpenLog, `${readyPath}\n`)
    return
  }
  const problem = await shell.openPath(readyPath)
  if (problem) {
    const what =
      process.platform === 'win32'
        ? 'Windows couldn’t start the installer'
        : 'macOS couldn’t open the disk image'
    set({ status: 'error', error: `${what}: ${problem}` })
    return
  }
  app.quit()
}

/** The release's page on GitHub, in the browser, for a release without a disk image to download. */
export async function openReleasePage(): Promise<void> {
  const page = state.latest?.pageUrl
  if (page && RELEASE_PAGE.test(page)) await shell.openExternal(page)
}

/** Settings › Updates, from the app menu's "Check for Updates…", with a check started. */
function checkFromMenu(): void {
  const window = getWindow()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.webContents.send(IpcChannels.showUpdates)
  }
  void checkForUpdates()
}

/** The app menu's "Save Diagnostics…": the window's Settings › General saves one and says where.
 * With no window open, the save dialog stands alone and the bundle is shown in the Finder. */
function diagnosticsFromMenu(): void {
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    // A test run keeps its window off the screen.
    if (!testKnobs.hideWindow) window.show()
    window.webContents.send(IpcChannels.saveDiagnosticsRequested)
    return
  }
  saveDiagnostics(null).then(
    (saved) => saved && shell.showItemInFolder(saved),
    (error) => console.error('[mergelane] failed to save diagnostics', error)
  )
}

/** Electron's default macOS menu, with "Check for Updates…" and "Save Diagnostics…" under the
 * app's name. */
function setAppMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          {
            label: state.status === 'checking' ? 'Checking for Updates…' : 'Check for Updates…',
            enabled: state.status !== 'checking',
            click: checkFromMenu
          },
          { id: 'save-diagnostics', label: 'Save Diagnostics…', click: diagnosticsFromMenu },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )
}

/** A check when automatic checks are on and the last one is a day old (or there wasn't one). */
function checkIfDue(): void {
  const { autoCheck, lastChecked, status } = state
  if (!autoCheck || status === 'available' || busy()) return
  if (lastChecked === null || Date.now() - lastChecked >= DAY_MS) void checkForUpdates()
}

/** Reads the saved choices, sets up the menu, and starts the daily check. A test run checks only
 * when asked to, and only its own server, never GitHub. */
export function startUpdater(window: () => BrowserWindow | null, saved: AppSettings): void {
  getWindow = window
  const version = testKnobs.updateAppVersion ?? app.getVersion()
  state = {
    ...state,
    version: parseVersion(version) ? version : '0.0.0',
    channel: saved.updateChannel ?? 'stable',
    autoCheck: saved.updateAutoCheck !== false,
    backgroundDownload: saved.updateBackgroundDownload === true,
    lastChecked: saved.updateLastChecked ?? null,
    skipped: saved.updateSkipped ?? null
  }
  setAppMenu()
  // A disk image from an earlier launch is either installed or out of date.
  rm(updatesDir(), { recursive: true, force: true }).catch(() => {})
  if (testKnobs.hideWindow && !testKnobs.releasesUrl) return
  // A little after launch, so the check doesn't compete with the window opening.
  setTimeout(checkIfDue, testKnobs.updateFirstCheckMs)
  setInterval(checkIfDue, TICK_MS)
}
