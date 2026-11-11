import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { THEMES, type ThemeSeeds } from '@shared/themes'
import { contrast, mix, parseHex } from '../test/colour'

// Every theme, in light and dark, checked the way assets/main.css derives its colours (the same
// color-mix formulas), against WCAG 2: text 4.5:1, controls and graphics 3:1 (1.4.3, 1.4.11).

const DANGER = { light: '#BB2F28', dark: '#FF8B82' }
const WARNING = { light: '#8F5300', dark: '#F0B35E' }
// main.css's swatches: [light, light glyph, dark, dark glyph].
const SWATCHES: Record<string, [string, string, string, string]> = {
  teal: ['#1F8A70', '#FFFFFF', '#4EA89A', '#10201D'],
  amber: ['#D97706', '#FFFFFF', '#D8A44C', '#221806'],
  steel: ['#4F64A5', '#FFFFFF', '#7E93BD', '#141A26'],
  rose: ['#B5525A', '#FFFFFF', '#C97B7B', '#210F0F'],
  violet: ['#6C5AC4', '#FFFFFF', '#9C8FD6', '#17131F'],
  lime: ['#5B8A1E', '#FFFFFF', '#A3C66A', '#161F0D'],
  cyan: ['#0E7D93', '#FFFFFF', '#6DB8C9', '#0D1A1E'],
  coral: ['#C4572A', '#FFFFFF', '#D99168', '#241209']
}

const pct = (value: string | undefined, fallback: number): number =>
  value ? parseFloat(value) : fallback

interface Pair {
  name: string
  ratio: number
  minimum: number
}

/** Every pair the theme must pass, named "<what> on <ground>". */
function pairs(seeds: ThemeSeeds, mode: 'light' | 'dark'): Pair[] {
  const out: Pair[] = []
  const add = (name: string, a: string | number[], b: string | number[], minimum: number): void => {
    const x = typeof a === 'string' ? parseHex(a) : (a as [number, number, number])
    const y = typeof b === 'string' ? parseHex(b) : (b as [number, number, number])
    out.push({ name, ratio: contrast(x, y), minimum })
  }
  // The content area, then the sidebar, whose tokens are derived on its own ground (.ml-surface).
  const regions = [
    { label: '', ground: seeds.bg, card: seeds.card, ink: seeds.text },
    {
      label: 'sidebar ',
      ground: seeds.sidebar,
      card: seeds.sidebarCard,
      ink: seeds.sidebarInk ?? seeds.text
    }
  ]
  for (const region of regions) {
    const ink = parseHex(region.ink)
    const ground = parseHex(region.ground)
    const derived = {
      text: ink,
      'text-secondary': mix(ink, pct(seeds.ink2, 76), ground),
      'text-tertiary': mix(ink, pct(seeds.ink3, 63), ground)
    }
    for (const surface of [region.ground, region.card]) {
      const where = `${region.label}${surface === region.ground ? 'ground' : 'card'}`
      for (const [name, colour] of Object.entries(derived))
        add(`${name} on ${where}`, colour, surface, 4.5)
      add(`control on ${where}`, mix(ink, 52, ground), surface, 3)
    }
  }
  for (const surface of [seeds.bg, seeds.card]) {
    const where = surface === seeds.bg ? 'ground' : 'card'
    const ink = parseHex(seeds.text)
    for (const kind of ['wifi', 'usb', 'ethernet'] as const) {
      add(`${kind} on ${where}`, seeds[kind], surface, 3)
      add(`${kind} text on ${where}`, mix(parseHex(seeds[kind]), 60, ink), surface, 4.5)
    }
    add(`accent on ${where}`, seeds.accent, surface, 3)
    add(`accent ink on ${where}`, seeds.accentInk ?? seeds.accent, surface, 3)
    add(`danger on ${where}`, DANGER[mode], surface, 4.5)
    add(`warning on ${where}`, WARNING[mode], surface, 4.5)
    for (const [id, [light, lightGlyph, dark, darkGlyph]] of Object.entries(SWATCHES)) {
      add(`swatch ${id} on ${where}`, mode === 'light' ? light : dark, surface, 3)
      add(
        `swatch ${id} glyph`,
        mode === 'light' ? lightGlyph : darkGlyph,
        mode === 'light' ? light : dark,
        3
      )
    }
  }
  add('text on accent', seeds.accentOn, seeds.accent, 4.5)
  for (const kind of ['wifi', 'usb', 'ethernet'] as const) {
    add(`glyph on ${kind}`, seeds.netOn, seeds[kind], 3)
  }
  return out
}

// Shortfalls in the owner's final design, kept as designed and reported to the owner (ADR-0034).
// The sidebar arrives in M3.1 pull request 5a; this must be settled before then. A listed shortfall
// that starts passing fails the test, so the list cannot go stale.
const KNOWN_SHORTFALLS = new Set(['dusk/light: text-tertiary on sidebar card'])

describe('every theme meets WCAG contrast in light and dark', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme.id} (${mode})`, () => {
        const failing = pairs(theme[mode], mode)
          .filter((pair) => pair.ratio < pair.minimum)
          .map((pair) => `${theme.id}/${mode}: ${pair.name}`)
        const known = [...KNOWN_SHORTFALLS].filter((key) => key.startsWith(`${theme.id}/${mode}:`))
        expect(failing.sort()).toEqual(known.sort())
      })
    }
  }

  it('measures the known Dusk shortfall at 4.26:1', () => {
    const dusk = THEMES.find((theme) => theme.id === 'dusk')!.light
    const pair = pairs(dusk, 'light').find(
      (entry) => entry.name === 'text-tertiary on sidebar card'
    )!
    expect(pair.ratio).toBeCloseTo(4.26, 2)
  })
})

describe('the themes are the owner’s final design', () => {
  it('match ML_THEMES in design-system/mergelane/redesign/prototype.html seed for seed', () => {
    const html = readFileSync(
      resolve(__dirname, '../../../../../design-system/mergelane/redesign/prototype.html'),
      'utf8'
    )
    const start = html.indexOf('window.ML_THEMES = [')
    const end = html.indexOf('];', start)
    const designed = runInNewContext(
      `(${html.slice(start + 'window.ML_THEMES = '.length, end + 1)})`,
      Object.create(null)
    ) as {
      id: string
      name: string
      desc: string
      light: Record<string, unknown>
      dark: Record<string, unknown>
    }[]
    // The glass-only keys arrive with Liquid Glass's material (M3.1 pull request 7).
    const GLASS_ONLY = new Set(['wallpaper', 'glassSidebar'])
    const seeds = (mode: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(mode).filter(([key]) => !GLASS_ONLY.has(key)))
    expect(
      THEMES.map((theme) => ({
        id: theme.id,
        name: theme.name,
        desc: theme.description,
        light: theme.light,
        dark: theme.dark
      }))
    ).toEqual(
      designed.map((theme) => ({
        id: theme.id,
        name: theme.name,
        desc: theme.desc,
        light: seeds(theme.light),
        dark: seeds(theme.dark)
      }))
    )
  })
})
