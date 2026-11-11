import { nativeTheme } from 'electron'
import { windowBackground } from '../shared/themes'

// The colour theme the window's background follows (ADR-0034). Set at start-up from the saved
// settings, and again when the renderer saves a new theme, so a live resize (which shows the raw
// window background for a moment) and the first frame never flash another theme's colour.
let themeId: unknown

export function setWindowTheme(id: unknown): void {
  themeId = id
}

/** The current theme's ground, in the mode macOS (or the saved choice) has the window in now. */
export function currentWindowBackground(): string {
  return windowBackground(themeId, nativeTheme.shouldUseDarkColors)
}
