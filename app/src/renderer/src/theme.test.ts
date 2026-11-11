import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { themeNetworkColours } from '@shared/themes'
import { useNetworkVisuals } from './hooks/useNetworkVisuals'
import { useAppStore } from './store/useAppStore'
import type { NetworkInterfaceKind } from '@shared/types'
import {
  assignNetworkColors,
  isValidNetworkColorId,
  KIND_PALETTE,
  NETWORK_COLOR_SWATCHES,
  resolveNetworkVisual
} from './theme'

const networks = (entries: [string, NetworkInterfaceKind][]): Map<string, NetworkInterfaceKind> =>
  new Map(entries)

describe('isValidNetworkColorId', () => {
  it('accepts the current swatches and nothing else', () => {
    for (const swatch of NETWORK_COLOR_SWATCHES) expect(isValidNetworkColorId(swatch.id)).toBe(true)
    expect(isValidNetworkColorId('mauve')).toBe(false)
    expect(isValidNetworkColorId(undefined)).toBe(false)
  })
})

describe('assignNetworkColors', () => {
  it('gives each kind its own hue when nothing is pinned', () => {
    const colors = assignNetworkColors(
      networks([
        ['en0', 'wifi'],
        ['en5', 'ethernet'],
        ['en7', 'usb']
      ]),
      {}
    )
    expect(Object.fromEntries(colors)).toEqual({ en0: 'teal', en5: 'steel', en7: 'amber' })
  })

  it('lets a pinned colour win, even over another network kind’s hue', () => {
    const colors = assignNetworkColors(
      networks([
        ['en0', 'wifi'],
        ['en7', 'usb']
      ]),
      { en7: { colorId: 'teal' } }
    )
    expect(colors.get('en7')).toBe('teal')
    // Wi-Fi's own hue is taken, so it gets the first free swatch.
    expect(colors.get('en0')).toBe('amber')
  })

  it('ignores a stale pinned id', () => {
    const colors = assignNetworkColors(networks([['en0', 'wifi']]), {
      en0: { colorId: 'mauve' }
    })
    expect(colors.get('en0')).toBe('teal')
  })

  it('never gives two phones the same colour, and colours kinds without a hue', () => {
    const colors = assignNetworkColors(
      networks([
        ['en7', 'usb'],
        ['en8', 'usb'],
        ['bridge0', 'bridge']
      ]),
      {}
    )
    expect(new Set(colors.values()).size).toBe(3)
    expect(colors.get('en7')).toBe('amber')
  })

  it('falls back once every swatch is in use', () => {
    const count = NETWORK_COLOR_SWATCHES.length
    const id = (i: number): string => `en${String(i).padStart(2, '0')}`
    const many = networks(
      Array.from({ length: count + 2 }, (_, i): [string, NetworkInterfaceKind] => [
        id(i),
        i === count ? 'other' : 'usb'
      ])
    )
    const colors = assignNetworkColors(many, {})
    expect(colors.size).toBe(many.size)
    // Past the last free swatch: a network with no hue of its own takes the first swatch, and a
    // USB network takes its kind's hue again.
    expect(colors.get(id(count))).toBe(NETWORK_COLOR_SWATCHES[0].id)
    expect(colors.get(id(count + 1))).toBe('amber')
  })
})

describe('resolveNetworkVisual', () => {
  it('uses the kind palette for the kind’s own hue, and the custom name when set', () => {
    const visual = resolveNetworkVisual('wifi', 'en0', { customName: '  Home  ' }, 'teal')
    expect(visual).toEqual({ ...KIND_PALETTE.wifi, name: 'Home', colorId: 'teal' })
  })

  it('tints the swatch for any other colour, and keeps the OS name when none is set', () => {
    const visual = resolveNetworkVisual('usb', 'iPhone', { customName: ' ' }, 'violet')
    expect(visual.name).toBe('iPhone')
    expect(visual.solid).toBe('var(--swatch-violet)')
    expect(visual.onSolid).toBe('var(--swatch-violet-onsolid)')
    expect(visual.bg).toBe('color-mix(in oklch, var(--swatch-violet) 16%, var(--bg-secondary))')
    expect(visual.label).toBe('USB')
  })
})

describe('an extra network’s colour never looks like a theme’s network colour', () => {
  const twoEthernets = networks([
    ['en5', 'ethernet'],
    ['en6', 'ethernet']
  ])

  it('skips a swatch that looks like one (Porcelain’s Ethernet is a teal, like the Teal swatch)', () => {
    const colors = assignNetworkColors(
      twoEthernets,
      {},
      {
        dark: false,
        colours: themeNetworkColours('porcelain', false)
      }
    )
    expect(colors.get('en5')).toBe('steel')
    // Teal is the first free swatch but sits 0.03 from Porcelain's Ethernet; Amber is far.
    expect(colors.get('en6')).toBe('amber')
  })

  it('compares in the mode shown', () => {
    const colors = assignNetworkColors(
      twoEthernets,
      {},
      {
        dark: true,
        colours: themeNetworkColours('sage', true)
      }
    )
    // Sage's dark colours are far from Teal.
    expect(colors.get('en6')).toBe('teal')
  })

  it('takes the first free swatch when every one looks like something', () => {
    const colors = assignNetworkColors(
      twoEthernets,
      {},
      {
        dark: false,
        colours: ['#1F8A70', '#D97706', '#B5525A', '#6C5AC4', '#5B8A1E', '#0E7D93', '#C4572A']
      }
    )
    expect(colors.get('en6')).toBe('teal')
  })
})

describe('useNetworkVisuals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('assigns colours against the current theme and mode', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
    useAppStore.setState({
      appearanceTheme: 'porcelain',
      interfaces: [
        { id: 'en5', kind: 'ethernet' },
        { id: 'en6', kind: 'ethernet' }
      ] as unknown as ReturnType<typeof useAppStore.getState>['interfaces'],
      // Networks a running or finished download used count too, even once disconnected.
      downloads: {
        d1: { networks: [{ id: 'en7', kind: 'usb' }] }
      } as unknown as ReturnType<typeof useAppStore.getState>['downloads'],
      history: [
        {
          networks: [
            { id: 'en8', kind: 'usb' },
            { id: 'en5', kind: 'ethernet' }
          ]
        }
      ] as unknown as ReturnType<typeof useAppStore.getState>['history'],
      networkPreferences: {}
    })
    const { result } = renderHook(() => useNetworkVisuals())
    expect(result.current('en5', 'ethernet', 'Ethernet').solid).toBe('var(--color-ethernet)')
    expect(result.current('en6', 'ethernet', 'Ethernet 2').colorId).toBe('rose')
    // The phones: the first takes USB's own colour; the second skips Violet, Lime and Cyan, which
    // look like Porcelain's Wi-Fi, USB and Ethernet, for Coral.
    expect(result.current('en7', 'usb', 'iPhone').solid).toBe('var(--color-usb)')
    expect(result.current('en8', 'usb', 'iPad').colorId).toBe('coral')
    // A network nobody has seen yet still gets a colour.
    expect(result.current('en9', 'other', 'Bridge').colorId).toBe('teal')
  })
})
