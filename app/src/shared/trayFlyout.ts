import type { ThemeId } from './themes'
import type { NetworkInterfaceKind, SpeedUnit } from './types'

// Mergelane's notification-area icon on Windows (the design's Windows 11 study; docs/DECISIONS.md ADR-0061),
// after Microsoft's notification-area guidance (learn.microsoft.com, "Notification Area"): pointing at the icon
// names it with the merged speed, a click opens a small flyout beside it, a right-click opens the menu. The pure
// parts live here, so they are tested on any computer; main/notificationArea.ts draws them.

/** One network in the flyout, as the window's sidebar shows it: its tile, name and speed, or that it's out. */
export interface TrayNetwork {
  id: string
  kind: NetworkInterfaceKind
  name: string
  color: string
  onColor: string
  speed: number
  out: boolean
}

/** What the flyout shows. The window publishes it (renderer hooks/useTrayStatus.ts), so the flyout and the
 * sidebar always agree on names, colours and speeds. */
export interface TrayStatus {
  /** Bytes a second, every network together: the sidebar's "Merged". */
  total: number
  /** Whether anything is downloading or waiting its turn, which Pause all would pause. */
  active: boolean
  unit: SpeedUnit
  theme: ThemeId
  networks: TrayNetwork[]
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The space between the flyout and the taskbar or the screen's edge, as Windows 11's own flyouts keep. */
export const FLYOUT_GAP = 12

/** The flyout's width: the study's 300px card. */
export const FLYOUT_WIDTH = 300

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

/** Where the flyout goes: centred on the icon, just clear of the taskbar on whichever edge it is, and inside
 * the screen's work area ("Display windows launched from notification area icons near the notification
 * area"). An icon Windows gives no place for (it's in the overflow, or bounds are empty) puts the flyout in
 * the work area's corner nearest the clock. */
export function flyoutBounds(
  icon: Rect,
  workArea: Rect,
  size: { width: number; height: number },
  gap = FLYOUT_GAP
): Rect {
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  const centreX = icon.x + icon.width / 2
  const centreY = icon.y + icon.height / 2
  const alongX = clamp(
    Math.round(centreX - size.width / 2),
    workArea.x + gap,
    right - size.width - gap
  )
  const alongY = clamp(
    Math.round(centreY - size.height / 2),
    workArea.y + gap,
    bottom - size.height - gap
  )
  const placed = (x: number, y: number): Rect => ({ x, y, width: size.width, height: size.height })
  const known = icon.width > 0 && icon.height > 0
  if (known && centreY < workArea.y) return placed(alongX, workArea.y + gap)
  if (known && centreX >= right) return placed(right - size.width - gap, alongY)
  if (known && centreX < workArea.x) return placed(workArea.x + gap, alongY)
  // The taskbar at the bottom, as it is by default; or nowhere known.
  const x = known && centreY >= bottom ? alongX : right - size.width - gap
  return placed(x, bottom - size.height - gap)
}

/** The icon's tooltip: its name, with the merged speed while bytes move ("Mergelane: 4.2 MB/s merged"). */
export function trayToolTip(speedText: string): string {
  return speedText ? `Mergelane: ${speedText} merged` : 'Mergelane'
}

export type TrayMenuId = 'open' | 'pauseAll' | 'merge' | 'settings' | 'exit'

export type TrayMenuEntry =
  | { id: TrayMenuId; label: string; type?: 'checkbox'; checked?: boolean; default?: boolean }
  | { separator: true }

/** The right-click menu, in Microsoft's order: Open first (the default command), then switches, then Settings
 * and Exit. An item that doesn't apply is left out rather than greyed ("Remove rather than disable any context
 * menu items that don't apply"): Pause all when nothing is downloading, Merge for every app when the helper
 * isn't installed and answering (`merge` null). */
export function trayMenu({
  active,
  merge
}: {
  active: boolean
  merge: boolean | null
}): TrayMenuEntry[] {
  const sections: TrayMenuEntry[][] = [
    [{ id: 'open', label: 'Open Mergelane', default: true }],
    [
      ...(active ? [{ id: 'pauseAll' as const, label: 'Pause all downloads' }] : []),
      ...(merge === null
        ? []
        : [
            {
              id: 'merge' as const,
              label: 'Merge for every app',
              type: 'checkbox' as const,
              checked: merge
            }
          ])
    ],
    [
      { id: 'settings', label: 'Settings' },
      { id: 'exit', label: 'Exit' }
    ]
  ]
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) =>
      index === 0 ? section : [{ separator: true as const }, ...section]
    )
}
