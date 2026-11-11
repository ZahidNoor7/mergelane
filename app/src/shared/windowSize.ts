// The main window's size: the final design's window (design-system/mergelane/redesign/prototype.html,
// AppWindow: 1280 x 800), where the download details sit beside the list, fitted to a smaller screen.
// Pure, so it is tested on its own; main/index.ts gives it the screen's work area.

export interface Size {
  width: number
  height: number
}

/** The design's window. */
export const DESIGN_WINDOW: Size = { width: 1280, height: 800 }

/** The smallest window: the compact bar's layout (renderer components/WindowChrome.tsx) at 720
 * points wide, with room under a download's chunk map for a network row. */
export const MIN_WINDOW: Size = { width: 720, height: 620 }

/** The size to open at: the design's, or the work area where that is smaller, never below the
 * smallest window. */
export function openingSize(workArea: Size): Size {
  const fit = (want: number, room: number, least: number): number =>
    Math.max(least, Math.min(want, Math.floor(room)))
  return {
    width: fit(DESIGN_WINDOW.width, workArea.width, MIN_WINDOW.width),
    height: fit(DESIGN_WINDOW.height, workArea.height, MIN_WINDOW.height)
  }
}
