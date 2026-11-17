import { roleOf } from './networkRoles'
import { formatBytes } from './speedText'
import type { ThemeId } from './themes'
import type { Rect } from './trayFlyout'
import type { NetworkInterfaceKind, NetworkPreferences, SpeedUnit } from './types'

// Mergelane's menu under its macOS menu bar icon (the design's "The menu bar menu"; docs/DECISIONS.md ADR-0067):
// the merged download and upload with the share each network carries, then every network with its own speeds and
// what it brought in today, then the commands. It is its own small window (main/menuBarPanel.ts) drawing the app's
// page (renderer components/MenuBarPanel.tsx). The pure parts live here, so they are tested on any computer.

/** The menu's width: the design's 360px. */
export const MENU_BAR_PANEL_WIDTH = 360

/** Below the menu bar, as macOS leaves a little room under a menu bar item's menu. */
export const MENU_BAR_PANEL_GAP = 4

/** Kept clear of the screen's edges. */
export const MENU_BAR_PANEL_MARGIN = 8

/** Each network's traffic while System merge is on, from the helper's counters (ADR-0066): everything the
 * network adapter receives and sends, whichever app asked. */
export interface SystemTraffic {
  links: { name: string; down: number; up: number }[]
}

/** What the menu asks the main process for, once a second while it is open: the helper's traffic while
 * System merge is on (null otherwise), and the settings it draws with, which may have changed in the window. */
export interface MenuBarPanelData {
  system: SystemTraffic | null
  speedUnit: SpeedUnit
  appearanceTheme: ThemeId
  networkPreferences: NetworkPreferences
  /** Whether the speed shows beside the icon now (speedBesideIcon). */
  speedBesideIcon: boolean
}

export type MenuBarCommand =
  'open' | 'pauseAll' | 'newDownload' | 'speedBesideIcon' | 'settings' | 'quit'

/** Whether the menu bar shows the speed beside the icon (ADR-0069): 'auto' (the default) only while two or more
 * networks are connected, so it takes no room when there's nothing to merge; 'on' always; 'off' never. */
export type MenuBarSpeedText = 'auto' | 'on' | 'off'

export const MENU_BAR_SPEED_TEXTS: readonly MenuBarSpeedText[] = ['auto', 'on', 'off']

/** Networks that count for 'auto': the computer's, less those set to Don't use (ADR-0045). */
export function speedBesideIcon(
  mode: MenuBarSpeedText | undefined,
  networkIds: readonly string[],
  preferences: NetworkPreferences
): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return networkIds.filter((id) => roleOf(preferences[id]) !== 'never').length >= 2
}

export interface MenuBarCommandItem {
  id: MenuBarCommand
  label: string
  /** The key that chooses it with ⌘ while the menu is open. */
  key?: string
  /** A switch that is on or off, as macOS's own menu bar menus show one. */
  toggle?: boolean
}

/** The commands, in the design's two groups: open, pause and new download; then the speed beside the icon
 * (ADR-0069), Settings and Quit. */
export const MENU_BAR_COMMANDS: MenuBarCommandItem[][] = [
  [
    { id: 'open', label: 'Open Mergelane', key: 'o' },
    { id: 'pauseAll', label: 'Pause all downloads' },
    { id: 'newDownload', label: 'New download…', key: 'n' }
  ],
  [
    { id: 'speedBesideIcon', label: 'Speed beside the icon', toggle: true },
    { id: 'settings', label: 'Settings…', key: ',' },
    { id: 'quit', label: 'Quit Mergelane', key: 'q' }
  ]
]

/** One network in the menu. */
export interface MenuBarNetwork {
  id: string
  kind: NetworkInterfaceKind
  name: string
  color: string
  onColor: string
  /** Bytes a second it receives and sends now. */
  down: number
  up: number
  /** What Mergelane's downloads brought in over it today (the Dashboard's Today). */
  today: number
  /** Gone from the Mac, though a download still lists it. */
  out: boolean
  /** Its role is Don't use (Networks, ADR-0045). */
  off: boolean
}

/** One network as the window's sidebar has it (renderer hooks/useNetworkLanes.ts). */
export interface MenuBarLane {
  id: string
  kind: NetworkInterfaceKind
  name: string
  color: string
  onColor: string
  /** Bytes a second Mergelane's downloads get over it. */
  speed: number
  out: boolean
}

/** Every network with its speeds. While System merge is on (`system`), each one's whole traffic, as the helper
 * counts it; otherwise what Mergelane's downloads receive and its torrents send over it (`uploads`). The same rule
 * as the menu bar item's title (ADR-0066), so the two agree. */
export function menuBarNetworks({
  lanes,
  system,
  uploads,
  today,
  off
}: {
  lanes: readonly MenuBarLane[]
  system: SystemTraffic | null
  uploads: ReadonlyMap<string, number>
  today: ReadonlyMap<string, number>
  off: ReadonlySet<string>
}): MenuBarNetwork[] {
  const traffic = new Map(system?.links.map((link) => [link.name, link]))
  return lanes.map((lane) => {
    const measured = system ? traffic.get(lane.id) : undefined
    return {
      id: lane.id,
      kind: lane.kind,
      name: lane.name,
      color: lane.color,
      onColor: lane.onColor,
      down: lane.out ? 0 : system ? (measured?.down ?? 0) : lane.speed,
      up: lane.out ? 0 : system ? (measured?.up ?? 0) : (uploads.get(lane.id) ?? 0),
      today: today.get(lane.id) ?? 0,
      out: lane.out,
      off: off.has(lane.id)
    }
  })
}

/** Bytes a second Mergelane's torrents send over each network, by network id. */
export function networkUploads(
  downloads: readonly { networks: readonly { id: string; uploadSpeedBytesPerSec?: number }[] }[]
): Map<string, number> {
  const uploads = new Map<string, number>()
  for (const download of downloads) {
    for (const network of download.networks) {
      const speed = network.uploadSpeedBytesPerSec ?? 0
      if (speed > 0) uploads.set(network.id, (uploads.get(network.id) ?? 0) + speed)
    }
  }
  return uploads
}

/** The merged download and upload: every network together. */
export function menuBarTotals(networks: readonly MenuBarNetwork[]): { down: number; up: number } {
  return networks.reduce(
    (sum, network) => ({ down: sum.down + network.down, up: sum.up + network.up }),
    { down: 0, up: 0 }
  )
}

/** "Merged across 2 of 3 networks": how many are receiving now, of all of them. */
export function networksHeading(networks: readonly MenuBarNetwork[]): string {
  const carrying = networks.filter((network) => !network.out && !network.off && network.down > 0)
  const noun = networks.length === 1 ? 'network' : 'networks'
  return `Merged across ${carrying.length} of ${networks.length} ${noun}`
}

/** Under a network's name: its share of the download and what it brought in today, or that it's out or off. */
export function networkDetail(network: MenuBarNetwork, totalDown: number): string {
  if (network.out) return 'Out'
  if (network.off) return 'Off'
  const share = totalDown > 0 ? Math.round((network.down / totalDown) * 100) : 0
  return `${share}% · ${formatBytes(network.today)} today`
}

/** Each network's share of the download, for the bar under the totals; none while nothing is received. */
export function shareSegments(
  networks: readonly MenuBarNetwork[],
  totalDown: number
): { id: string; share: number; color: string }[] {
  if (totalDown <= 0) return []
  return networks
    .filter((network) => network.down > 0)
    .map((network) => ({ id: network.id, share: network.down / totalDown, color: network.color }))
}

/** The line under the networks. */
export function todayLine(networks: readonly MenuBarNetwork[]): string {
  const total = networks.reduce((sum, network) => sum + network.today, 0)
  return `${formatBytes(total)} downloaded today`
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

/** Where the menu goes: just under the icon, its right edge at the icon's right edge (the design's), inside the
 * screen. Under the icon rather than under the work area's top: over a full-screen app the menu bar slides in over
 * the app, and the work area then starts at the top of the screen (ADR-0068). An icon macOS gives no place for
 * (bounds empty) puts it at the work area's top right. Never taller than the room below; the page scrolls inside
 * it then. */
export function menuBarPanelBounds(
  icon: Rect,
  workArea: Rect,
  size: { width: number; height: number },
  { gap = MENU_BAR_PANEL_GAP, margin = MENU_BAR_PANEL_MARGIN } = {}
): Rect {
  const right = workArea.x + workArea.width
  const known = icon.width > 0 && icon.height > 0
  const edge = known ? icon.x + icon.width : right - margin
  const x = clamp(Math.round(edge - size.width), workArea.x + margin, right - size.width - margin)
  const y = Math.round(Math.max(workArea.y, known ? icon.y + icon.height : workArea.y) + gap)
  const room = workArea.y + workArea.height - y - margin
  return { x, y, width: size.width, height: Math.max(80, Math.min(size.height, room)) }
}
