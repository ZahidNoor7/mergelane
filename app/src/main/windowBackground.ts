import { nativeTheme, type BrowserWindow } from 'electron'
import { windowBackground } from '../shared/themes'

// The colour theme the window's background follows (ADR-0034). Set at start-up from the saved
// settings, and again when the renderer saves a new theme, so a live resize (which shows the raw
// window background for a moment) and the first frame never flash another theme's colour.
//
// The Liquid Glass theme draws the window in macOS's own material instead (M3.1 pull request 7):
// Electron's vibrancy, 'under-window', with a clear background, so the desktop shows through,
// blurred by the system. Reduce Transparency (the Mac's, or Settings') makes it solid again.
let themeId: unknown
let solidGlass = false

export function setWindowTheme(id: unknown): void {
  themeId = id
}

export function setSolidGlass(solid: boolean): void {
  solidGlass = solid
}

/** The current theme's ground, in the mode macOS (or the saved choice) has the window in now. */
export function currentWindowBackground(): string {
  return windowBackground(themeId, nativeTheme.shouldUseDarkColors)
}

/** Whether the window shows the glass material: the Liquid Glass theme, on a Mac, transparency
 * not reduced. */
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

/** Puts the window in the material or its theme's ground, as glassWindow() says, fading the
 * material in or out (BrowserWindow.setVibrancy's animationDuration, Electron 44). */
export function applyWindowMaterial(window: BrowserWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (glassWindow()) {
    window.setVibrancy('under-window', { animationDuration: 200 })
    window.setBackgroundColor(CLEAR)
  } else {
    if (process.platform === 'darwin') window.setVibrancy(null, { animationDuration: 200 })
    window.setBackgroundColor(currentWindowBackground())
  }
}
