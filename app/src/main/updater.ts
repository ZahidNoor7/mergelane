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
import { saveSettings } from './settings'
import { testKnobs } from './testKnobs'

// Mergelane's own updates (docs/DECISIONS.md ADR-0036): GitHub's public Releases API is asked for the
// newest release on the chosen channel, on request and once a day. Nothing is downloaded yet: that
// comes with M3.2b (download, check the SHA-256, open the disk image).

const DAY_MS = 24 * 60 * 60_000
/** How often the daily check looks at whether a day has passed. */
const TICK_MS = 60 * 60_000
const RELEASE_PAGE = /^https:\/\/github\.com\/ZahidNoor7\/mergelane\/releases\//

let state: UpdateState = {
  status: 'idle',
  version: '0.0.0',
  channel: 'stable',
  autoCheck: true,
  lastChecked: null,
  latest: null,
  skipped: null,
  error: null
}
let getWindow: () => BrowserWindow | null = () => null

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

/** Asks GitHub now. A check already running is joined rather than repeated. */
let running: Promise<UpdateState> | null = null
export function checkForUpdates(): Promise<UpdateState> {
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
        'User-Agent': `Mergelane/${state.version}`
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
      skipped: state.skipped
    })
    const lastChecked = Date.now()
    save({ updateLastChecked: lastChecked })
    set({ status: latest ? 'available' : 'current', latest, lastChecked })
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

/** Automatic checks on or off, and the channel. A new channel forgets what the old one found. */
export function setUpdatePreferences(preferences: {
  autoCheck?: boolean
  channel?: UpdateChannel
}): void {
  const { autoCheck, channel } = preferences
  if (typeof autoCheck === 'boolean' && autoCheck !== state.autoCheck) {
    set({ autoCheck })
    save({ updateAutoCheck: autoCheck ? undefined : false })
  }
  if ((channel === 'stable' || channel === 'beta') && channel !== state.channel) {
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
  set({ skipped: version, latest: null, status: 'idle' })
  save({ updateSkipped: version })
}

/** The release's page on GitHub, in the browser: where the disk image is until M3.2b. */
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

/** Electron's default macOS menu, with "Check for Updates…" under the app's name. */
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
  if (!autoCheck || status === 'available') return
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
    lastChecked: saved.updateLastChecked ?? null,
    skipped: saved.updateSkipped ?? null
  }
  setAppMenu()
  if (testKnobs.hideWindow && !testKnobs.releasesUrl) return
  // A little after launch, so the check doesn't compete with the window opening.
  setTimeout(checkIfDue, testKnobs.updateFirstCheckMs)
  setInterval(checkIfDue, TICK_MS)
}
