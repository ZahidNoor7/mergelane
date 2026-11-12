import { nativeTheme, type BrowserWindow } from 'electron'
import { windowBackground, windowInk } from '../shared/themes'
import { windowsBackdrop, windowsBuild } from '../shared/windowMaterial'

// The colour theme the window's background follows (ADR-0034). Set at start-up from the saved
// settings, and again when the renderer saves a new theme, so a live resize (which shows the raw
// window background for a moment) and the first frame never flash another theme's colour.
//
// The Liquid Glass theme draws the window in the system's own material instead (M3.1 pull request 7):
// on macOS, Electron's vibrancy, 'under-window', with a clear background, so the desktop shows
// through, blurred by the system; on Windows 11 22H2 and later, the acrylic backdrop
// (shared/windowMaterial.ts). Reduce Transparency (the system's, or Settings') makes it solid again.
let themeId: unknown
let solidGlass = false

export function setWindowTheme(id: unknown): void {
  themeId = id
}

export function setSolidGlass(solid: boolean): void {
  solidGlass = solid
}

/** The current theme's ground, in the mode the system (or the saved choice) has the window in now. */
export function currentWindowBackground(): string {
  return windowBackground(themeId, nativeTheme.shouldUseDarkColors)
}

/** The Windows backdrop for the current theme, or null where Windows can't draw one. */
function backdrop(): 'acrylic' | 'none' | null {
  if (process.platform !== 'win32') return null
  return windowsBackdrop({
    build: windowsBuild(process.getSystemVersion()),
    liquid: themeId === 'liquid',
    solid: solidGlass,
    reducedTransparency: nativeTheme.prefersReducedTransparency
  })
}

/** Whether the window shows the glass material: the Liquid Glass theme, on a Mac or on Windows 11
 * 22H2 and later, transparency not reduced. */
export function glassWindow(): boolean {
  if (process.platform === 'win32') return backdrop() === 'acrylic'
  return (
    process.platform === 'darwin' &&
    themeId === 'liquid' &&
    !solidGlass &&
    !nativeTheme.prefersReducedTransparency
  )
}

/** A clear ground, behind the material. */
export const CLEAR = '#00000000'

/** Windows' window buttons, drawn over the top right (main/index.ts titleBarOverlay): on the theme's
 * ground, or clear over the glass, with symbols in the theme's ink, at the screen headers' height. */
export function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: glassWindow() ? CLEAR : currentWindowBackground(),
    symbolColor: windowInk(themeId, dark),
    height: 44
  }
}

/** Puts the window in the material or its theme's ground, as glassWindow() says, fading the
 * material in or out (BrowserWindow.setVibrancy's animationDuration, Electron 44). */
export function applyWindowMaterial(window: BrowserWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (process.platform === 'win32') {
    const material = backdrop()
    if (material) window.setBackgroundMaterial(material)
    window.setBackgroundColor(material === 'acrylic' ? CLEAR : currentWindowBackground())
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
