import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceKind } from '@shared/types'
import {
  assignNetworkColors,
  isValidNetworkColorId,
  KIND_PALETTE,
  NETWORK_COLOR_SWATCHES,
  resolveNetworkVisual,
  TITLE_BAR_HEIGHT
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

it('sizes the title bar for macOS', () => {
  expect(TITLE_BAR_HEIGHT).toBe(32)
})
