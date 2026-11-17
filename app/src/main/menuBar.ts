import { readFileSync } from 'node:fs'
import { nativeImage, Tray } from 'electron'
import trayIcon from '../../resources/trayTemplate.png?asset'
import trayIcon2x from '../../resources/trayTemplate@2x.png?asset'
import { speedBesideIcon, type MenuBarSpeedText, type SystemTraffic } from '../shared/menuBarPanel'
import { formatSpeed, formatSpeedPair } from '../shared/speedText'
import type {
  AppSettings,
  NetworkInterfaceInfo,
  NetworkPreferences,
  SpeedUnit
} from '../shared/types'
import {
  createNotificationAreaIcon,
  windowsShell,
  type NotificationAreaActions
} from './notificationArea'
import { destroyMenuBarPanel, toggleMenuBarPanel } from './menuBarPanel'
import { testKnobs, testRecord } from './testKnobs'

// Mergelane in the macOS menu bar (docs/DECISIONS.md ADR-0037): the template icon, and while bytes
// move, the merged download and upload beside it in one unit ("↓27.9 ↑2.8 MB/s", ADR-0067), in the units
// the window uses. A click opens the menu under it (menuBarPanel.ts). Settings › General turns it off.
// The speed shows beside the icon automatically only while two or more networks are connected, or always,
// or never, as Settings or the menu chooses (ADR-0069); the icon and its menu stay either way.
// While System merge is on, the speeds are everything the Mac receives and sends over its networks, as the
// helper counts them; otherwise they are Mergelane's own downloads and torrent uploads (ADR-0066).
// On Windows it is the notification-area icon (notificationArea.ts, ADR-0061), with the speed in its
// tooltip, since Windows shows no text beside it; Settings' switch there also keeps Mergelane running
// when its window is closed (index.ts). Linux keeps the tray index.ts shows only to keep downloads
// running.

const TICK_MS = 1000

interface MenuBarItem {
  setTitle(title: string): void
  destroy(): void
}

type MenuBarActions = NotificationAreaActions & {
  /** Bytes a second Mergelane's torrents send, together. */
  totalUploadSpeed: () => number
  /** Each network's whole traffic while System merge is on; null otherwise (ADR-0066). */
  systemTraffic: () => Promise<SystemTraffic | null>
  /** The computer's networks now. */
  networks: () => NetworkInterfaceInfo[]
}

let actions: MenuBarActions | null = null
let item: MenuBarItem | null = null
let ticker: NodeJS.Timeout | null = null
let unit: SpeedUnit = 'bytes'
/** What the item says now; null when that isn't known, so the next tick says it whatever it is. */
let title: string | null = ''
let speedText: MenuBarSpeedText = 'auto'
let preferences: NetworkPreferences = {}
/** A tick waiting for the helper: the next one is skipped rather than queued behind it. */
let ticking = false

/** The icon in both sizes, marked as a template so macOS colours it for the menu bar. */
function icon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(trayIcon)
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
  image.setTemplateImage(true)
  return image
}

/** The real menu bar item; in a test run, one that only notes its title, and that a test clicks through
 * globalThis.__mergelaneMenuBar. */
function createItem(): MenuBarItem {
  if (windowsShell() && actions) return createNotificationAreaIcon(actions)
  if (testKnobs.userDataDir) {
    testRecord('menuBar', { shown: true, title: '' }, true)
    Object.assign(globalThis, {
      __mergelaneMenuBar: { click: () => toggleMenuBarPanel({ x: 0, y: 0, width: 0, height: 0 }) }
    })
    return {
      setTitle: (text) => testRecord('menuBar', { shown: true, title: text }, true),
      destroy: () => {
        testRecord('menuBar', { shown: false, title: '' }, true)
        delete (globalThis as Record<string, unknown>).__mergelaneMenuBar
        destroyMenuBarPanel()
      }
    }
  }
  const tray = new Tray(icon())
  tray.setToolTip('Mergelane')
  // The menu is Mergelane's own (menuBarPanel.ts), so no context menu: a click or a right-click opens it.
  tray.on('click', (_event, bounds) => toggleMenuBarPanel(bounds))
  tray.on('right-click', (_event, bounds) => toggleMenuBarPanel(bounds))
  return {
    setTitle: (text) => tray.setTitle(text, { fontType: 'monospacedDigit' }),
    destroy: () => {
      destroyMenuBarPanel()
      tray.destroy()
    }
  }
}

/** Whether the menu bar item (macOS) or notification-area icon (Windows) is showing. */
export function statusItemShown(): boolean {
  return item !== null
}

/** What the item says now. On the Mac, the download and upload: the whole Mac's while System merge is on.
 * Windows' tooltip keeps the window's merged download speed, which its flyout shows too (ADR-0066). */
async function titleNow(current: MenuBarActions): Promise<string> {
  if (windowsShell()) {
    const speed = current.totalSpeed()
    return speed > 0 ? formatSpeed(speed, unit) : ''
  }
  const ids = current.networks().map((network) => network.id)
  if (!speedBesideIcon(speedText, ids, preferences)) return ''
  const system = await current.systemTraffic().catch(() => null)
  const down = system
    ? system.links.reduce((sum, link) => sum + link.down, 0)
    : current.totalSpeed()
  const up = system
    ? system.links.reduce((sum, link) => sum + link.up, 0)
    : current.totalUploadSpeed()
  return down > 0 || up > 0 ? formatSpeedPair(down, up, unit) : ''
}

async function tick(): Promise<void> {
  if (!item || !actions || ticking) return
  ticking = true
  try {
    const next = await titleNow(actions)
    // Settings may have taken the item away while the helper answered.
    if (!item || next === title) return
    title = next
    item.setTitle(next)
  } finally {
    ticking = false
  }
}

/** Shows or hides the item, and takes up the speed unit, as Settings has them. */
export function applyMenuBarSettings(settings: AppSettings): void {
  if ((process.platform !== 'darwin' && process.platform !== 'win32') || !actions) return
  unit = settings.speedUnit ?? 'bytes'
  speedText = settings.menuBarSpeedText ?? 'auto'
  preferences = settings.networkPreferences ?? {}
  const show = settings.menuBarSpeed !== false
  if (show && !item) {
    item = createItem()
    title = ''
    ticker = setInterval(() => void tick(), TICK_MS)
    void tick()
  } else if (!show && item) {
    if (ticker) clearInterval(ticker)
    ticker = null
    item.destroy()
    item = null
  } else {
    // The unit, or whether the speed shows, may have changed: say it again, even when it's now nothing.
    title = null
    void tick()
  }
}

export function startMenuBar(menuBarActions: MenuBarActions, settings: AppSettings): void {
  actions = menuBarActions
  applyMenuBarSettings(settings)
}
