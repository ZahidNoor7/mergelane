import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  shell,
  Tray
} from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { keepsRunningForBrowser, markAppReady, startBridge } from './browserBridge'
import { registerNativeHost } from './nativeHost'
import { acceptedLink, bringForward, linkFromArgs, offerLink } from './openLinks'
import { loadSettings, loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import {
  applyWindowMaterial,
  CLEAR,
  currentWindowBackground,
  glassWindow,
  setSolidGlass,
  setWindowTheme
} from './windowBackground'
import { startUpdater } from './updater'
import { testKnobs } from './testKnobs'
import { MIN_WINDOW, openingSize } from '../shared/windowSize'
import type { DownloadManager } from './download/downloadManager'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
app.setName('Mergelane')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

// One Mergelane at a time (per userData folder, so parallel e2e runs each have their own): a second
// launch — a magnet link clicked, a .torrent opened — hands its link to the first and exits.
if (!app.requestSingleInstanceLock()) app.exit(0)

let mainWindow: BrowserWindow | null = null
let downloadManager: DownloadManager | null = null
let quitAfterSuspending = false
let tray: Tray | null = null
let isQuitting = false
let hasShownTrayNotification = false

function ensureTray(): Tray {
  if (tray && !tray.isDestroyed()) return tray
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Mergelane')
  tray.on('click', () => bringForward(ensureWindow()))
  tray.on('double-click', () => bringForward(ensureWindow()))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mergelane', click: () => bringForward(ensureWindow()) },
      { type: 'separator' },
      {
        label: 'Quit Mergelane',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  return tray
}

/** Only once the app is ready. */
function ensureWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  return mainWindow as BrowserWindow
}

/** A link the OS handed over goes to the window's link field (see openLinks.ts). */
function offer(candidate: string): void {
  const link = acceptedLink(candidate)
  if (!link) return
  // Before the app is ready the link waits; the window takes it once it opens.
  offerLink({ url: link }, app.isReady() ? ensureWindow() : null)
}

// A mergelane:// link from the browser extension arrives here too, with no link in it.
app.on('second-instance', (_event, argv) => {
  const link = linkFromArgs(argv)
  if (link) return offer(link)
  bringForward(ensureWindow())
})
// macOS hands links over as events, and may do so before the app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault()
  offer(url)
})
app.on('open-file', (event, path) => {
  event.preventDefault()
  offer(path)
})
// Windows and Linux put the first launch's link on its command line.
const launchLink = linkFromArgs(process.argv)
if (launchLink) offer(launchLink)

/** The Windows/Linux window controls, in the title bar's colors (main.css's --bg-secondary and
 * --text) for the theme in use, at its height. */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#202325' : '#fafafa',
    symbolColor: dark ? '#eae7e2' : '#1d1d1f',
    height: 44
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // The final design's window, where a download's details sit beside the list, fitted to the
    // screen's work area (shared/windowSize.ts). The sidebar gives way to a compact bar below 760px
    // (renderer components/WindowChrome.tsx).
    ...openingSize(screen.getPrimaryDisplay().workAreaSize),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    autoHideMenuBar: true,
    title: 'Mergelane',
    // The theme's ground in the current mode, so a live window resize (which briefly exposes the
    // raw window background) and the first frame don't flash another colour.
    backgroundColor: glassWindow() ? CLEAR : currentWindowBackground(),
    ...(glassWindow() ? { vibrancy: 'under-window' as const } : {}),
    ...(process.platform !== 'darwin' ? { icon } : {}),
    // No title bar: the renderer's sidebar (or compact bar) holds macOS's window buttons at its top
    // left, on a strip the window is dragged by (components/WindowChrome.tsx). Windows and Linux
    // draw their controls over the top right instead.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? // Inside the sidebar's 40px top strip (its panel is inset 8px from the window's edge).
        { trafficLightPosition: { x: 22, y: 22 } }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) mainWindow?.show()
    markAppReady()
  })

  mainWindow.on('session-end', () => {
    isQuitting = true
  })
  mainWindow.on('query-session-end', () => {
    isQuitting = true
  })

  mainWindow.on('close', (event) => {
    if (isQuitting || process.platform === 'darwin') return

    const activeCount = downloadManager?.activeDownloadCount() ?? 0
    const runsForBrowser = keepsRunningForBrowser()

    if (activeCount > 0 || runsForBrowser) {
      event.preventDefault()
      mainWindow?.hide()
      ensureTray()
      if (!hasShownTrayNotification && activeCount > 0) {
        hasShownTrayNotification = true
        if (!testKnobs.userDataDir && Notification.isSupported()) {
          new Notification({
            title: 'Mergelane is still downloading',
            body: 'Downloads will continue in the background. Open Mergelane again, or use its tray icon, to quit.'
          }).show()
        }
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Electron shows no right-click menu of its own: give every text field Cut/Copy/Paste, and any
  // selected text Copy.
  mainWindow.webContents.on('context-menu', (_, { isEditable, selectionText, editFlags }) => {
    const template: Electron.MenuItemConstructorOptions[] = isEditable
      ? [
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: editFlags.canSelectAll }
        ]
      : selectionText.trim()
        ? [{ role: 'copy' }]
        : []
    if (template.length) Menu.buildFromTemplate(template).popup()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.zahidnoor7.mergelane')

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[mergelane] failed to migrate network-preferences.json', error)
  )

  // The macOS About window (Mergelane › About Mergelane); its copyright comes from electron-builder.yml.
  app.setAboutPanelOptions({
    credits:
      'Based on Plexo by Anmol Kapil and Net Merge by Rohit Mahto (both MIT). See THIRD-PARTY-NOTICES.md.'
  })

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()
  const saved = await loadSettings()
  setWindowTheme(saved.appearanceTheme)
  setSolidGlass(saved.solidGlass === true)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  downloadManager = registerIpcHandlers(() => mainWindow)
  void startBridge({
    manager: downloadManager,
    offer: (link) => offerLink(link, ensureWindow())
  }).catch((error) => console.error('[mergelane] browser bridge failed to start', error))
  // The browsers find mergelane-nmhost through a manifest in each profile folder; written on every
  // start, so it always points at this copy of the app.
  const nativeHost =
    testKnobs.nativeHostBinary ??
    (app.isPackaged ? join(process.resourcesPath, 'mergelane-nmhost') : undefined)
  if (nativeHost) {
    void registerNativeHost(nativeHost, testKnobs.nativeHostHome ?? app.getPath('home')).catch(
      (error) => console.error('[mergelane] browser host registration failed', error)
    )
  }
  // Unlike magnet:, mergelane:// is Mergelane's own, so registering it takes nothing from another app. A
  // development build has no fixed path to register.
  if (app.isPackaged) app.setAsDefaultProtocolClient('mergelane')

  nativeTheme.on('updated', () => {
    applyWindowMaterial(mainWindow)
    if (process.platform !== 'darwin') mainWindow?.setTitleBarOverlay(titleBarOverlay())
  })

  createWindow()
  if (testKnobs.hideWindow) app.dock?.hide()
  startUpdater(() => mainWindow, (await loadSettings()).autoUpdate !== false)

  app.on('activate', function () {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', (event) => {
  isQuitting = true
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void downloadManager.suspendAll().finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  const activeCount = downloadManager?.activeDownloadCount() ?? 0
  if (!keepsRunningForBrowser() && activeCount === 0) return app.quit()
  ensureTray()
})
