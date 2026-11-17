import { describe, expect, it } from 'vitest'
import {
  MENU_BAR_COMMANDS,
  menuBarNetworks,
  menuBarPanelBounds,
  menuBarTotals,
  networkDetail,
  networkUploads,
  speedBesideIcon,
  networksHeading,
  shareSegments,
  todayLine,
  type MenuBarLane,
  type MenuBarNetwork
} from './menuBarPanel'

// The menu under the macOS menu bar icon (ADR-0067), after the design's "The menu bar menu".

const MB = 1024 * 1024
const GB = 1024 * MB

const lane = (id: string, fields: Partial<MenuBarLane> = {}): MenuBarLane => ({
  id,
  kind: 'wifi',
  name: id,
  color: '#111111',
  onColor: '#FFFFFF',
  speed: 0,
  out: false,
  ...fields
})

const network = (id: string, fields: Partial<MenuBarNetwork> = {}): MenuBarNetwork => ({
  id,
  kind: 'wifi',
  name: id,
  color: '#111111',
  onColor: '#FFFFFF',
  down: 0,
  up: 0,
  today: 0,
  out: false,
  off: false,
  ...fields
})

describe('menuBarNetworks', () => {
  const lanes = [
    lane('en0', { name: 'Wi-Fi', speed: 2 * MB }),
    lane('en7', { kind: 'usb', name: 'iPhone USB', speed: MB }),
    lane('en9', { kind: 'ethernet', name: 'Dock', speed: 0, out: true })
  ]
  const today = new Map([
    ['en0', 11 * GB],
    ['en9', GB]
  ])

  it('with System merge off: what Mergelane’s downloads get and its torrents send', () => {
    const networks = menuBarNetworks({
      lanes,
      system: null,
      uploads: new Map([['en0', 100]]),
      today,
      off: new Set(['en7'])
    })
    expect(networks).toEqual([
      network('en0', { name: 'Wi-Fi', down: 2 * MB, up: 100, today: 11 * GB }),
      network('en7', { kind: 'usb', name: 'iPhone USB', down: MB, off: true }),
      network('en9', { kind: 'ethernet', name: 'Dock', today: GB, out: true })
    ])
  })

  it('with System merge on: each network’s whole traffic, as the helper counts it', () => {
    const networks = menuBarNetworks({
      lanes,
      system: {
        links: [
          { name: 'en0', down: 5 * MB, up: MB },
          // One the helper knows that the window doesn't list adds no row.
          { name: 'utun9', down: MB, up: MB },
          // A network that's out carries nothing, whatever a stale count says.
          { name: 'en9', down: MB, up: MB }
        ]
      },
      uploads: new Map([['en0', 100]]),
      today,
      off: new Set()
    })
    expect(networks.map((n) => [n.id, n.down, n.up])).toEqual([
      ['en0', 5 * MB, MB],
      // The helper says nothing of it: nothing moves on it.
      ['en7', 0, 0],
      ['en9', 0, 0]
    ])
  })
})

describe('networkUploads', () => {
  it('adds up each network’s upload over every download', () => {
    const uploads = networkUploads([
      { networks: [{ id: 'en0', uploadSpeedBytesPerSec: 100 }, { id: 'en7' }] },
      {
        networks: [
          { id: 'en0', uploadSpeedBytesPerSec: 50 },
          { id: 'en5', uploadSpeedBytesPerSec: 0 }
        ]
      }
    ])
    expect([...uploads]).toEqual([['en0', 150]])
  })
})

describe('the summary', () => {
  const networks = [
    network('en0', { down: 11.7 * MB, up: 993 * 1024, today: 11 * GB }),
    network('en7', { down: 3 * MB, up: 99 * 1024, today: 4 * GB }),
    network('en5', { down: 13.2 * MB, up: 1.7 * MB, today: 13 * GB })
  ]

  it('totals every network', () => {
    const totals = menuBarTotals(networks)
    expect(totals.down).toBeCloseTo(27.9 * MB)
    expect(totals.up).toBeCloseTo(993 * 1024 + 99 * 1024 + 1.7 * MB)
  })

  it('counts the networks receiving now, of all of them', () => {
    expect(networksHeading(networks)).toBe('Merged across 3 of 3 networks')
    expect(
      networksHeading([
        ...networks.slice(0, 1),
        network('en7', { down: MB, off: true }),
        network('en9', { down: MB, out: true }),
        network('en5')
      ])
    ).toBe('Merged across 1 of 4 networks')
    expect(networksHeading([network('en0')])).toBe('Merged across 0 of 1 network')
  })

  it('gives each network its share and today’s bytes, or says it’s out or off', () => {
    const total = menuBarTotals(networks).down
    expect(networkDetail(networks[0], total)).toBe('42% · 11.0 GB today')
    expect(networkDetail(networks[1], total)).toBe('11% · 4.0 GB today')
    expect(networkDetail(network('en9', { today: GB }), 0)).toBe('0% · 1.0 GB today')
    expect(networkDetail(network('en9', { out: true, off: true }), total)).toBe('Out')
    expect(networkDetail(network('en9', { off: true }), total)).toBe('Off')
  })

  it('draws each receiving network’s share in its colour, and nothing while nothing moves', () => {
    const segments = shareSegments([...networks, network('idle')], 27.9 * MB)
    expect(segments.map((segment) => segment.id)).toEqual(['en0', 'en7', 'en5'])
    expect(segments[0].share).toBeCloseTo(11.7 / 27.9)
    expect(segments[0].color).toBe('#111111')
    expect(shareSegments(networks, 0)).toEqual([])
  })

  it('says what came in today, over every network', () => {
    expect(todayLine(networks)).toBe('28.0 GB downloaded today')
    expect(todayLine([])).toBe('0 B downloaded today')
  })
})

describe('the commands', () => {
  it('are the design’s, in its two groups, with their ⌘ keys', () => {
    expect(
      MENU_BAR_COMMANDS.map((group) => group.map((item) => `${item.label} ${item.key ?? ''}`))
    ).toEqual([
      ['Open Mergelane o', 'Pause all downloads ', 'New download… n'],
      ['Speed beside the icon ', 'Settings… ,', 'Quit Mergelane q']
    ])
  })
})

describe('menuBarPanelBounds', () => {
  // A 1512 × 982 screen with a 33 px menu bar.
  const workArea = { x: 0, y: 33, width: 1512, height: 949 }
  const size = { width: 360, height: 420 }

  it('goes just under the menu bar, its right edge at the icon’s', () => {
    const icon = { x: 1200, y: 0, width: 110, height: 33 }
    expect(menuBarPanelBounds(icon, workArea, size)).toEqual({
      x: 950,
      y: 37,
      width: 360,
      height: 420
    })
  })

  it('stays on the screen', () => {
    // An icon near the left edge: the menu starts at the margin.
    expect(menuBarPanelBounds({ x: 10, y: 0, width: 40, height: 33 }, workArea, size).x).toBe(8)
    // On a second screen to the right, the same rule.
    const second = { x: 1512, y: 25, width: 1920, height: 1055 }
    expect(
      menuBarPanelBounds({ x: 3300, y: 0, width: 80, height: 25 }, second, size)
    ).toMatchObject({ x: 3020, y: 29 })
  })

  it('over a full-screen app, under the icon: the menu bar slides in over the app, and the work area is the whole screen', () => {
    const fullScreen = { x: 0, y: 0, width: 1512, height: 982 }
    expect(menuBarPanelBounds({ x: 1200, y: 0, width: 110, height: 33 }, fullScreen, size)).toEqual(
      { x: 950, y: 37, width: 360, height: 420 }
    )
    // On a second display above the first, the same.
    const above = { x: 0, y: -1080, width: 1920, height: 1080 }
    expect(
      menuBarPanelBounds({ x: 1800, y: -1080, width: 60, height: 24 }, above, size)
    ).toMatchObject({ x: 1500, y: -1052 })
  })

  it('without the icon’s place, the top right', () => {
    expect(menuBarPanelBounds({ x: 0, y: 0, width: 0, height: 0 }, workArea, size)).toEqual({
      x: 1144,
      y: 37,
      width: 360,
      height: 420
    })
  })

  it('never taller than the room under the menu bar', () => {
    const low = { x: 0, y: 33, width: 1512, height: 300 }
    expect(menuBarPanelBounds({ x: 0, y: 0, width: 0, height: 0 }, low, size).height).toBe(288)
    const tiny = { x: 0, y: 33, width: 1512, height: 50 }
    expect(menuBarPanelBounds({ x: 0, y: 0, width: 0, height: 0 }, tiny, size).height).toBe(80)
  })
})

describe('speedBesideIcon', () => {
  it('automatic: only while two or more networks are connected, not counting Don’t use', () => {
    expect(speedBesideIcon(undefined, ['en0'], {})).toBe(false)
    expect(speedBesideIcon('auto', ['en0', 'en7'], {})).toBe(true)
    expect(speedBesideIcon('auto', ['en0', 'en7'], { en7: { role: 'never' } })).toBe(false)
    // Standby still counts: it is a network Mergelane can use.
    expect(speedBesideIcon('auto', ['en0', 'en7'], { en7: { role: 'standby' } })).toBe(true)
    expect(speedBesideIcon('auto', [], {})).toBe(false)
  })

  it('always or never, whatever the networks', () => {
    expect(speedBesideIcon('on', [], {})).toBe(true)
    expect(speedBesideIcon('off', ['en0', 'en7', 'en5'], {})).toBe(false)
  })
})
