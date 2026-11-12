import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, Menu, nativeTheme, screen, Tray, type Rectangle } from 'electron'
// The unpacked copy (electron-builder.yml asarUnpack): a real file for Windows' own icon loader.
import trayIcon from '../../resources/tray.ico?asset&asarUnpack'
import { IpcChannels } from '../shared/ipc-channels'
import { themeById } from '../shared/themes'
import {
  FLYOUT_WIDTH,
  flyoutBounds,
  trayMenu,
  trayToolTip,
  type TrayMenuEntry,
  type TrayMenuId,
  type TrayStatus
} from '../shared/trayFlyout'
import type { SystemMergeSnapshot } from '../shared/types'
import { testKnobs, testRecord } from './testKnobs'

// Mergelane in Windows' notification area (the design's Windows 11 study; docs/DECISIONS.md ADR-0061), after
// Microsoft's notification-area guidance:
// - the icon is the blue mark alone, in the 16, 20 and 24px sizes (and larger) the notification area uses,
//   as an ICO, which Electron recommends for tray icons on Windows (resources/tray.ico);
// - pointing at it names it, with the merged speed while bytes move (menuBar.ts keeps that current);
// - a click opens a small flyout beside it: the merged speed, each network, Open Mergelane and Pause all. It is
//   a frameless window of the app's own page (renderer components/TrayFlyout.tsx), which Windows 11 rounds,
//   and it goes away when anything else is clicked;
// - a right-click opens the menu (shared/trayFlyout.ts trayMenu), a double-click opens the window.
// Electron's menus can't show the default command in bold, as Microsoft's guidance asks: Open comes first.
//
// A test run on the Mac (testKnobs.rendererPlatform 'win32') gets all of it but the icon itself: a stand-in
// notes the tooltip and lets the test click, right-click and choose, through globalThis.__mergelaneTray.

export interface NotificationAreaActions {
  /** Bytes a second, every running download together. */
  totalSpeed: () => number
  open: () => void
  quit: () => void
  /** How many downloads are downloading or waiting their turn. */
  activeCount: () => number
  pauseAll: () => Promise<void>
  /** The window, on Settings or on Networks (where System merge says why it is off). */
  showPlace: (place: 'settings' | 'networks') => void
  systemMerge: () => Promise<SystemMergeSnapshot>
  setSystemMerge: (on: boolean) => Promise<SystemMergeSnapshot>
}

/** Whether Mergelane lives in the notification area as on Windows: on Windows, or in a test run that draws
 * the Windows look on the Mac. */
export function windowsShell(): boolean {
  return process.platform === 'win32' || testKnobs.rendererPlatform === 'win32'
}

let actions: NotificationAreaActions | null = null
let status: TrayStatus | null = null
let flyout: BrowserWindow | null = null
let flyoutOpen = false
let flyoutHeight = 240
let iconBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
/** When the flyout last went away because something else took the focus: the click on the icon that did
 * that mustn't open it again at once. */
let blurredAt = 0
const REOPEN_AFTER_BLUR_MS = 300

/** The flyout's ground before its page paints: the theme's popover (card) colour for the mode. */
function flyoutGround(): string {
  const theme = themeById(status?.theme)
  return nativeTheme.shouldUseDarkColors ? theme.dark.card : theme.light.card
}

function ensureFlyout(): BrowserWindow {
  if (flyout && !flyout.isDestroyed()) return flyout
  const window = new BrowserWindow({
    width: FLYOUT_WIDTH,
    height: flyoutHeight,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Mergelane',
    backgroundColor: flyoutGround(),
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  window.on('blur', () => {
    if (!flyoutOpen) return
    blurredAt = Date.now()
    hideFlyout()
  })
  window.on('closed', () => {
    flyout = null
    flyoutOpen = false
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tray`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' })
  }
  flyout = window
  return window
}

function place(window: BrowserWindow): void {
  const known = iconBounds.width > 0 && iconBounds.height > 0
  const display = known ? screen.getDisplayMatching(iconBounds) : screen.getPrimaryDisplay()
  window.setBounds(
    flyoutBounds(iconBounds, display.workArea, { width: FLYOUT_WIDTH, height: flyoutHeight })
  )
}

function showFlyout(bounds: Rectangle): void {
  iconBounds = bounds
  const window = ensureFlyout()
  place(window)
  flyoutOpen = true
  testRecord('trayFlyout', { open: true }, true)
  // A test run keeps its windows hidden (testKnobs.hideWindow), so the Mac's focus stays where it is.
  if (testKnobs.hideWindow) return
  const show = (): void => {
    if (!flyoutOpen || window.isDestroyed()) return
    place(window)
    window.show()
    window.focus()
  }
  // Made just now: shown once its page has painted (and told its height), not as an empty card.
  if (window.webContents.isLoading()) window.once('ready-to-show', show)
  else show()
}

/** The flyout's window goes with the icon: a hidden window left behind would keep Mergelane running with
 * nothing on screen once the main window closes. */
function destroyFlyout(): void {
  hideFlyout()
  if (flyout && !flyout.isDestroyed()) flyout.destroy()
  flyout = null
}

function hideFlyout(): void {
  if (!flyoutOpen) return
  flyoutOpen = false
  testRecord('trayFlyout', { open: false }, true)
  if (flyout && !flyout.isDestroyed()) flyout.hide()
}

/** A click on the icon: the flyout opens beside it, or closes if it was open. */
function toggleFlyout(bounds: Rectangle): void {
  if (flyoutOpen) return hideFlyout()
  if (Date.now() - blurredAt < REOPEN_AFTER_BLUR_MS) return
  showFlyout(bounds)
}

/** Whether the helper is installed and answering, and if so whether merging is on; null when the menu
 * shouldn't offer it. */
async function mergeState(): Promise<boolean | null> {
  if (!actions) return null
  try {
    const snapshot = await actions.systemMerge()
    if (!snapshot.installed || !snapshot.reachable || snapshot.helperOutdated) return null
    return snapshot.state === 'on' || snapshot.state === 'starting'
  } catch {
    return null
  }
}

async function menuEntries(): Promise<TrayMenuEntry[]> {
  return trayMenu({ active: (actions?.activeCount() ?? 0) > 0, merge: await mergeState() })
}

async function choose(id: TrayMenuId, checked?: boolean): Promise<void> {
  if (!actions) return
  hideFlyout()
  switch (id) {
    case 'open':
      return actions.open()
    case 'pauseAll':
      return actions.pauseAll()
    case 'merge': {
      // The item shows the state before the click: ask for the other one.
      const on = !checked
      try {
        const after = await actions.setSystemMerge(on)
        // Refused (another VPN is on, say): the window's Networks place says why.
        if (on && after.state !== 'on' && after.state !== 'starting') actions.showPlace('networks')
      } catch {
        actions.showPlace('networks')
      }
      return
    }
    case 'settings':
      return actions.showPlace('settings')
    case 'exit':
      return actions.quit()
  }
}

function menuTemplate(entries: TrayMenuEntry[]): Electron.MenuItemConstructorOptions[] {
  return entries.map((entry) =>
    'separator' in entry
      ? { type: 'separator' }
      : {
          label: entry.label,
          type: entry.type ?? 'normal',
          checked: entry.checked,
          click: () => void choose(entry.id, entry.checked)
        }
  )
}

interface NotificationAreaIcon {
  setTitle(title: string): void
  destroy(): void
}

/** The stand-in a test run gets: it notes the tooltip, and the test clicks it through
 * globalThis.__mergelaneTray. */
function standIn(): NotificationAreaIcon {
  const record = (toolTip: string): void =>
    testRecord('notificationArea', { shown: true, toolTip }, true)
  record(trayToolTip(''))
  Object.assign(globalThis, {
    __mergelaneTray: {
      click: () => toggleFlyout({ x: 0, y: 0, width: 0, height: 0 }),
      doubleClick: () => {
        hideFlyout()
        actions?.open()
      },
      menu: () => menuEntries(),
      choose: async (id: TrayMenuId) => {
        const entry = (await menuEntries()).find((item) => 'id' in item && item.id === id)
        if (entry && 'id' in entry) await choose(entry.id, entry.checked)
      }
    }
  })
  return {
    setTitle: (title) => record(trayToolTip(title)),
    destroy: () => {
      testRecord('notificationArea', { shown: false, toolTip: '' }, true)
      delete (globalThis as Record<string, unknown>).__mergelaneTray
      destroyFlyout()
    }
  }
}

/** Mergelane's notification-area icon (menuBar.ts shows it while Settings keeps it). */
export function createNotificationAreaIcon(
  notificationAreaActions: NotificationAreaActions
): NotificationAreaIcon {
  actions = notificationAreaActions
  if (testKnobs.userDataDir) return standIn()
  const tray = new Tray(trayIcon)
  tray.setToolTip(trayToolTip(''))
  tray.on('click', (_event, bounds) => toggleFlyout(bounds))
  tray.on('double-click', () => {
    hideFlyout()
    actions?.open()
  })
  tray.on('right-click', () => {
    hideFlyout()
    void menuEntries().then((entries) => {
      if (!tray.isDestroyed()) tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate(entries)))
    })
  })
  return {
    setTitle: (title) => tray.setToolTip(trayToolTip(title)),
    destroy: () => {
      destroyFlyout()
      tray.destroy()
    }
  }
}

/** The window's new status for the flyout (ipc publishTrayStatus). */
export function publishTrayStatus(next: TrayStatus): void {
  status = next
  if (flyout && !flyout.isDestroyed()) flyout.webContents.send(IpcChannels.trayStatusChanged, next)
}

/** What the flyout shows now (ipc trayStatus). */
export function trayStatus(): TrayStatus | null {
  return status
}

/** The flyout's page is this tall: its window fits it, in the same place beside the icon. */
export function resizeTrayFlyout(height: number): void {
  if (!Number.isFinite(height)) return
  flyoutHeight = Math.min(Math.max(Math.ceil(height), 80), 640)
  if (flyout && !flyout.isDestroyed()) place(flyout)
}

/** Esc in the flyout, or one of its buttons. */
export function closeTrayFlyout(): void {
  hideFlyout()
}

/** The flyout's Open Mergelane. */
export function openFromTray(): void {
  hideFlyout()
  actions?.open()
}
