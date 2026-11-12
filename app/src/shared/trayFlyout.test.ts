import { describe, expect, it } from 'vitest'
import { FLYOUT_GAP, flyoutBounds, trayMenu, trayToolTip, type Rect } from './trayFlyout'

// A 1920 × 1080 screen with Windows' 48px taskbar on one edge or another.
const SIZE = { width: 300, height: 260 }
const screen = (taskbar: 'bottom' | 'top' | 'left' | 'right'): Rect =>
  ({
    bottom: { x: 0, y: 0, width: 1920, height: 1032 },
    top: { x: 0, y: 48, width: 1920, height: 1032 },
    left: { x: 48, y: 0, width: 1872, height: 1080 },
    right: { x: 0, y: 0, width: 1872, height: 1080 }
  })[taskbar]
const icon = (x: number, y: number): Rect => ({ x, y, width: 24, height: 24 })

describe('flyoutBounds', () => {
  it('sits above a bottom taskbar, centred on the icon', () => {
    expect(flyoutBounds(icon(1500, 1044), screen('bottom'), SIZE)).toEqual({
      x: 1500 + 12 - 150,
      y: 1032 - 260 - FLYOUT_GAP,
      ...SIZE
    })
  })

  it('stays inside the work area when the icon is near its edge', () => {
    // The icon by the clock: the flyout can't be centred on it without leaving the screen.
    expect(flyoutBounds(icon(1880, 1044), screen('bottom'), SIZE).x).toBe(1920 - 300 - FLYOUT_GAP)
    // A narrow screen: the left edge wins over the right.
    const narrow = { x: 0, y: 0, width: 200, height: 1032 }
    expect(flyoutBounds(icon(100, 1044), narrow, SIZE).x).toBe(FLYOUT_GAP)
  })

  it('hangs below a top taskbar', () => {
    expect(flyoutBounds(icon(1500, 12), screen('top'), SIZE)).toMatchObject({
      x: 1362,
      y: 48 + FLYOUT_GAP
    })
  })

  it('sits beside a taskbar on the right or the left, centred on the icon’s height', () => {
    expect(flyoutBounds(icon(1884, 900), screen('right'), SIZE)).toMatchObject({
      x: 1872 - 300 - FLYOUT_GAP,
      y: 912 - 130
    })
    expect(flyoutBounds(icon(12, 900), screen('left'), SIZE)).toMatchObject({
      x: 48 + FLYOUT_GAP,
      y: 782
    })
    // Low on the screen: kept above its bottom edge.
    expect(flyoutBounds(icon(1884, 1060), screen('right'), SIZE).y).toBe(1080 - 260 - FLYOUT_GAP)
  })

  it('goes to the corner by the clock when Windows gives the icon no place', () => {
    const corner = { x: 1920 - 300 - FLYOUT_GAP, y: 1032 - 260 - FLYOUT_GAP, ...SIZE }
    expect(flyoutBounds({ x: 0, y: 0, width: 0, height: 0 }, screen('bottom'), SIZE)).toEqual(
      corner
    )
    // An icon inside the work area (the overflow's own flyout).
    expect(flyoutBounds(icon(900, 500), screen('bottom'), SIZE)).toEqual(corner)
  })
})

describe('trayToolTip', () => {
  it('names the icon, with the merged speed while bytes move', () => {
    expect(trayToolTip('')).toBe('Mergelane')
    expect(trayToolTip('4.2 MB/s')).toBe('Mergelane: 4.2 MB/s merged')
  })
})

describe('trayMenu', () => {
  const labels = (entries: ReturnType<typeof trayMenu>): string[] =>
    entries.map((entry) => ('separator' in entry ? '—' : entry.label))

  it('is Open first, then the switches, then Settings and Exit', () => {
    const menu = trayMenu({ active: true, merge: true })
    expect(labels(menu)).toEqual([
      'Open Mergelane',
      '—',
      'Pause all downloads',
      'Merge for every app',
      '—',
      'Settings',
      'Exit'
    ])
    expect(menu[0]).toMatchObject({ id: 'open', default: true })
    expect(menu[3]).toMatchObject({ id: 'merge', type: 'checkbox', checked: true })
    expect(trayMenu({ active: true, merge: false })[3]).toMatchObject({ checked: false })
  })

  it('leaves out what doesn’t apply, and the separator with it', () => {
    expect(labels(trayMenu({ active: false, merge: null }))).toEqual([
      'Open Mergelane',
      '—',
      'Settings',
      'Exit'
    ])
    expect(labels(trayMenu({ active: false, merge: false }))).toEqual([
      'Open Mergelane',
      '—',
      'Merge for every app',
      '—',
      'Settings',
      'Exit'
    ])
    expect(labels(trayMenu({ active: true, merge: null }))).toEqual([
      'Open Mergelane',
      '—',
      'Pause all downloads',
      '—',
      'Settings',
      'Exit'
    ])
  })
})
