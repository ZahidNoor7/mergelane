import { readFileSync } from 'node:fs'
import { Menu, nativeImage, Tray } from 'electron'
import trayIcon from '../../resources/trayTemplate.png?asset'
import trayIcon2x from '../../resources/trayTemplate@2x.png?asset'
import { formatSpeed } from '../shared/speedText'
import type { AppSettings, SpeedUnit } from '../shared/types'
import { testKnobs, testRecord } from './testKnobs'

// Mergelane in the macOS menu bar (docs/DECISIONS.md ADR-0037): the template icon, and while bytes
// move, the merged speed beside it, in the units the window uses. Settings › General turns it off.
// Windows and Linux keep their own tray (index.ts), which only appears to keep downloads running.

const TICK_MS = 1000

interface MenuBarItem {
  setTitle(title: string): void
  destroy(): void
}

interface MenuBarActions {
  /** Bytes a second, every running download together. */
  totalSpeed: () => number
  open: () => void
  quit: () => void
}

let actions: MenuBarActions | null = null
let item: MenuBarItem | null = null
let ticker: NodeJS.Timeout | null = null
let unit: SpeedUnit = 'bytes'
let title = ''

/** The icon in both sizes, marked as a template so macOS colours it for the menu bar. */
function icon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(trayIcon)
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
  image.setTemplateImage(true)
  return image
}

/** The real menu bar item; in a test run, one that only notes its title. */
function createItem(): MenuBarItem {
  if (testKnobs.userDataDir) {
    testRecord('menuBar', { shown: true, title: '' }, true)
    return {
      setTitle: (text) => testRecord('menuBar', { shown: true, title: text }, true),
      destroy: () => testRecord('menuBar', { shown: false, title: '' }, true)
    }
  }
  const tray = new Tray(icon())
  tray.setToolTip('Mergelane')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mergelane', click: () => actions?.open() },
      { type: 'separator' },
      { label: 'Quit Mergelane', click: () => actions?.quit() }
    ])
  )
  return {
    setTitle: (text) => tray.setTitle(text, { fontType: 'monospacedDigit' }),
    destroy: () => tray.destroy()
  }
}

function tick(): void {
  if (!item || !actions) return
  const speed = actions.totalSpeed()
  const next = speed > 0 ? formatSpeed(speed, unit) : ''
  if (next === title) return
  title = next
  item.setTitle(title)
}

/** Shows or hides the item, and takes up the speed unit, as Settings has them. */
export function applyMenuBarSettings(settings: AppSettings): void {
  if (process.platform !== 'darwin' || !actions) return
  unit = settings.speedUnit ?? 'bytes'
  const show = settings.menuBarSpeed !== false
  if (show && !item) {
    item = createItem()
    title = ''
    ticker = setInterval(tick, TICK_MS)
    tick()
  } else if (!show && item) {
    if (ticker) clearInterval(ticker)
    ticker = null
    item.destroy()
    item = null
  } else {
    // The unit may have changed: say the speed again in it.
    title = ''
    tick()
  }
}

export function startMenuBar(menuBarActions: MenuBarActions, settings: AppSettings): void {
  actions = menuBarActions
  applyMenuBarSettings(settings)
}
