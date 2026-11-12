import { nativeTheme, type BrowserWindow } from 'electron'
import { windowBackground, windowInk, windowsGround } from '../shared/themes'
import { windowsBackdrop, windowsBuild } from '../shared/windowMaterial'

// The colour theme the window's background follows (ADR-0034). Set at start-up from the saved
// settings, and again when the renderer saves a new theme, so a live resize (which shows the raw
// window background for a moment) and the first frame never flash another theme's colour.
//
// On macOS the Liquid Glass theme draws the window in the system's own material instead (M3.1 pull
// request 7): Electron's vibrancy, 'under-window', with a clear background, so the desktop shows through,
// blurred by the system. Reduce Transparency (the system's, or Settings') makes it solid again.
//
// On Windows every theme sits on Mica, from Windows 11 22H2, and Liquid Glass isn't offered (the design's
// Windows 11 study, ADR-0060; shared/windowMaterial.ts): the title bar and the navigation pane show the
// material, the content its own layer. Without Mica, the window's ground is themes.ts windowsGround.
let themeId: unknown
let solidGlass = false

export function setWindowTheme(id: unknown): void {
  themeId = id
}

export function setSolidGlass(solid: boolean): void {
  solidGlass = solid
}

/** The current theme's ground, in the mode the system (or the saved choice) has the window in now: on
 * Windows the window's own ground, behind the title bar and the navigation pane. */
export function currentWindowBackground(): string {
  const dark = nativeTheme.shouldUseDarkColors
  return process.platform === 'win32'
    ? windowsGround(themeId, dark)
    : windowBackground(themeId, dark)
}

/** The Windows backdrop, or null where Windows can't draw one. */
function backdrop(): 'mica' | 'none' | null {
  if (process.platform !== 'win32') return null
  return windowsBackdrop({
    build: windowsBuild(process.getSystemVersion()),
    reducedTransparency: nativeTheme.prefersReducedTransparency
  })
}

/** Whether Windows draws Mica behind the window. */
export function micaWindow(): boolean {
  return backdrop() === 'mica'
}

/** Whether the window shows the Liquid Glass material: the theme on a Mac, transparency not reduced. */
export function glassWindow(): boolean {
  return (
    process.platform === 'darwin' &&
    themeId === 'liquid' &&
    !solidGlass &&
    !nativeTheme.prefersReducedTransparency
  )
}

/** A clear ground, behind the material. */
export const CLEAR = '#00000000'

/** Windows' title-bar height, the design's 32px (renderer components/WindowChrome.tsx WinTitleBar). */
export const TITLE_BAR_HEIGHT = 32

/** Windows' window buttons, drawn at the title bar's right (main/index.ts titleBarOverlay): clear over
 * Mica, or on the window's ground, with symbols in the theme's ink. */
export function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: micaWindow() ? CLEAR : currentWindowBackground(),
    symbolColor: windowInk(themeId, dark),
    height: TITLE_BAR_HEIGHT
  }
}

/** Puts the window in the material or its theme's ground, as glassWindow() says, fading the
 * material in or out (BrowserWindow.setVibrancy's animationDuration, Electron 44). */
export function applyWindowMaterial(window: BrowserWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (process.platform === 'win32') {
    const material = backdrop()
    if (material) window.setBackgroundMaterial(material)
    window.setBackgroundColor(material === 'mica' ? CLEAR : currentWindowBackground())
    window.setTitleBarOverlay(titleBarOverlay())
    return
  }
  if (glassWindow()) {
    window.setVibrancy('under-window', { animationDuration: 200 })
    window.setBackgroundColor(CLEAR)
  } else {
    if (process.platform === 'darwin') window.setVibrancy(null, { animationDuration: 200 })
    window.setBackgroundColor(currentWindowBackground())
  }
}
