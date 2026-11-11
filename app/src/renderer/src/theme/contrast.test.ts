import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { NETWORK_SWATCHES, THEMES, type ThemeSeeds } from '@shared/themes'
import { contrast, mix, parseHex } from '@shared/colour'

// Every theme, in light and dark, checked the way assets/main.css derives its colours (the same
// color-mix formulas), against WCAG 2: text 4.5:1, controls and graphics 3:1 (1.4.3, 1.4.11).

const DANGER = { light: '#BB2F28', dark: '#FF8B82' }
const WARNING = { light: '#8F5300', dark: '#F0B35E' }
// The pickable network colours (shared/themes.ts): [light, light glyph, dark, dark glyph].
const SWATCHES = Object.fromEntries(
  NETWORK_SWATCHES.map((swatch) => [
    swatch.id,
    [swatch.light, swatch.lightOn, swatch.dark, swatch.darkOn] as [string, string, string, string]
  ])
)

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

describe('every theme meets WCAG contrast in light and dark', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme.id} (${mode})`, () => {
        const failing = pairs(theme[mode], mode)
          .filter((pair) => pair.ratio < pair.minimum)
          .map((pair) => `${pair.name}: ${pair.ratio.toFixed(2)} < ${pair.minimum}`)
        expect(failing).toEqual([])
      })
    }
  }
})

// Seeds the owner changed after the design was declared final, each with the design's value, so a
// later change to the design file still fails the comparison below.
const OWNER_CHANGES = [
  {
    // 2026-11-11: the faintest sidebar text reached only 4.26:1 on Dusk's light sidebar card. The
    // owner chose a slightly darker card; it now reaches 4.56:1.
    theme: 'dusk',
    mode: 'light',
    key: 'sidebarCard',
    designed: '#3A3456',
    now: '#353050'
  }
] as const

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
    for (const change of OWNER_CHANGES) {
      const seed = designed.find((theme) => theme.id === change.theme)![change.mode]
      expect(seed[change.key]).toBe(change.designed)
      seed[change.key] = change.now
    }
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
