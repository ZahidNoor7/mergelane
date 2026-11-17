import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, nativeTheme, screen, type Rectangle } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import {
  MENU_BAR_PANEL_WIDTH,
  menuBarPanelBounds,
  type MenuBarCommand,
  type MenuBarPanelData
} from '../shared/menuBarPanel'
import { DEFAULT_THEME_ID, themeById, type ThemeId } from '../shared/themes'
import { keepPageCurrent } from './otherPages'
import { testKnobs, testRecord } from './testKnobs'

// The menu under Mergelane's macOS menu bar icon (the design's "The menu bar menu"; docs/DECISIONS.md ADR-0067).
// A click on the icon opens it just under the menu bar; another click, a click anywhere else, Esc or a command
// closes it. It is a small frameless window of the app's own page (renderer components/MenuBarPanel.tsx), kept
// hidden between uses so it opens at once, and made only on the first click.
//
// It opens over a full-screen app too (ADR-0068). A full-screen app has its own Space, and an ordinary window
// belongs to one Space, so it couldn't appear there; and showing an ordinary window activates Mergelane, which can
// switch the Mac to the Space with Mergelane's window. Electron 44.4.4 (docs, BaseWindowOptions `type`; source,
// shell/browser/native_window_mac.mm):
// - `type: 'panel'` "enables the window to float on top of full-screened apps" and "will appear on all spaces",
//   and Show() and Focus() don't activate the app for a panel;
// - setVisibleOnAllWorkspaces sets NSWindowCollectionBehaviorCanJoinAllSpaces and, with visibleOnFullScreen,
//   NSWindowCollectionBehaviorFullScreenAuxiliary; skipTransformProcessType keeps it from hiding the Dock icon;
// - setAlwaysOnTop(true, 'pop-up-menu') is NSPopUpMenuWindowLevel, a menu's own level, above the Dock. It reads its own data (the
// downloads, the networks and, once a second, the helper's traffic), because on the Mac the main window may be
// closed while Mergelane runs in the menu bar.

export interface MenuBarPanelActions {
  open: () => void
  pauseAll: () => Promise<void>
  newDownload: () => void
  /** Shows the speed beside the icon if it's hidden now, or hides it (ADR-0069). */
  toggleSpeedBesideIcon: () => Promise<void>
  settings: () => void
  quit: () => void
  /** The helper's traffic while System merge is on, and the settings the menu draws with. */
  data: () => Promise<MenuBarPanelData>
}

let actions: MenuBarPanelActions | null = null
let panel: BrowserWindow | null = null
let panelOpen = false
let panelHeight = 420
let iconBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let theme: ThemeId = DEFAULT_THEME_ID
/** When the menu last went away because something else took the focus: the click on the icon that did
 * that mustn't open it again at once. */
let blurredAt = 0
const REOPEN_AFTER_BLUR_MS = 300

export function startMenuBarPanel(panelActions: MenuBarPanelActions): void {
  actions = panelActions
}

/** The theme's popover colour for the mode: the ground before the page paints. */
function ground(): string {
  const look = themeById(theme)
  return nativeTheme.shouldUseDarkColors ? look.dark.card : look.light.card
}

function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel
  const window = new BrowserWindow({
    width: MENU_BAR_PANEL_WIDTH,
    height: panelHeight,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    // A menu: it floats over full-screen apps, joins every Space, and never activates Mergelane.
    type: 'panel',
    title: 'Mergelane',
    backgroundColor: ground(),
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  window.setAlwaysOnTop(true, 'pop-up-menu')
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  window.on('blur', () => {
    if (!panelOpen) return
    blurredAt = Date.now()
    hidePanel()
  })
  // Its own list of downloads and networks stays current while it's hidden, so it opens up to date.
  const stopUpdates = keepPageCurrent(window.webContents)
  window.on('closed', () => {
    stopUpdates()
    panel = null
    panelOpen = false
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#menubar`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'menubar' })
  }
  panel = window
  return window
}

function place(window: BrowserWindow): void {
  const known = iconBounds.width > 0 && iconBounds.height > 0
  const display = known ? screen.getDisplayMatching(iconBounds) : screen.getPrimaryDisplay()
  window.setBounds(
    menuBarPanelBounds(iconBounds, display.workArea, {
      width: MENU_BAR_PANEL_WIDTH,
      height: panelHeight
    })
  )
}

function showPanel(bounds: Rectangle): void {
  iconBounds = bounds
  const window = ensurePanel()
  place(window)
  panelOpen = true
  testRecord('menuBarPanel', { open: true }, true)
  // The page asks for fresh numbers and settings at once, rather than at its next second.
  if (!window.webContents.isLoading()) window.webContents.send(IpcChannels.menuBarPanelShown)
  // A test run keeps its windows hidden (testKnobs.hideWindow), so the Mac's focus stays where it is.
  if (testKnobs.hideWindow) return
  const show = (): void => {
    if (!panelOpen || window.isDestroyed()) return
    place(window)
    // A panel takes the keyboard when shown, without activating Mergelane (and so without leaving the Space
    // of a full-screen app).
    window.show()
  }
  // Made just now: shown once its page has painted (and told its height), not as an empty card.
  if (window.webContents.isLoading()) window.once('ready-to-show', show)
  else show()
}

function hidePanel(): void {
  if (!panelOpen) return
  panelOpen = false
  testRecord('menuBarPanel', { open: false }, true)
  if (panel && !panel.isDestroyed()) {
    panel.hide()
    panel.webContents.send(IpcChannels.menuBarPanelHidden)
  }
}

/** A click on the icon: the menu opens under it, or closes if it was open. */
export function toggleMenuBarPanel(bounds: Rectangle): void {
  if (panelOpen) return hidePanel()
  if (Date.now() - blurredAt < REOPEN_AFTER_BLUR_MS) return
  showPanel(bounds)
}

/** The menu's window goes with the icon: a hidden window left behind would keep Mergelane running with
 * nothing on screen. */
export function destroyMenuBarPanel(): void {
  hidePanel()
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
}

/** Esc in the menu. */
export function closeMenuBarPanel(): void {
  hidePanel()
}

/** The menu's page is this tall: its window fits it, in the same place under the icon. */
export function resizeMenuBarPanel(height: number): void {
  if (!Number.isFinite(height)) return
  panelHeight = Math.min(Math.max(Math.ceil(height), 80), 720)
  if (panel && !panel.isDestroyed()) place(panel)
}

/** What the menu shows besides the page's own data. The theme is kept for the window's ground. */
export async function menuBarPanelData(): Promise<MenuBarPanelData> {
  if (!actions) throw new Error('The menu bar is not running.')
  const data = await actions.data()
  theme = data.appearanceTheme
  return data
}

/** One of the menu's commands. The menu closes first, as a menu does. */
export async function chooseFromMenuBar(command: MenuBarCommand): Promise<void> {
  hidePanel()
  if (!actions) return
  switch (command) {
    case 'open':
      return actions.open()
    case 'pauseAll':
      return actions.pauseAll()
    case 'newDownload':
      return actions.newDownload()
    case 'speedBesideIcon':
      return actions.toggleSpeedBesideIcon()
    case 'settings':
      return actions.settings()
    case 'quit':
      return actions.quit()
  }
}
