import { NETWORK_SWATCHES, THEMES, type ThemeId, type ThemeSeeds } from '@shared/themes'

// Writes every theme's seed colours as CSS custom properties, as the owner's design does at start-up
// (design-system/mergelane/redesign/prototype.html). Each theme is
//   :root[data-palette="<id>"] { light seeds }
//   @media (prefers-color-scheme: dark) { :root[data-palette="<id>"] { dark seeds } }
// and assets/main.css derives every other colour from these. Light or dark itself comes from
// nativeTheme.themeSource in the main process, which drives prefers-color-scheme, so the page only
// picks the palette.

const NAMES: [keyof ThemeSeeds, string][] = [
  ['desk', '--desk'],
  ['window', '--window'],
  ['sidebar', '--sidebar'],
  ['sidebarInk', '--sidebar-ink'],
  ['sidebarCard', '--sidebar-card'],
  ['bg', '--bg'],
  ['card', '--card'],
  ['text', '--text'],
  ['accent', '--color-accent'],
  ['accentOn', '--color-accent-onsolid'],
  ['accentInk', '--accent-ink'],
  ['wifi', '--color-wifi'],
  ['usb', '--color-usb'],
  ['ethernet', '--color-ethernet'],
  ['line', '--line'],
  ['lineSubtle', '--line-subtle'],
  ['lineStrong', '--line-strong'],
  ['ink2', '--ink-2'],
  ['ink3', '--ink-3']
]

/** One mode's declarations. In dark mode every sidebar is dark, as in the design. */
export function seedDeclarations(seeds: ThemeSeeds, dark: boolean): string {
  const values: Partial<Record<keyof ThemeSeeds, string | boolean>> = {
    ...seeds,
    sidebarInk: seeds.sidebarInk ?? seeds.text
  }
  const out = NAMES.flatMap(([key, name]) =>
    values[key] === undefined ? [] : [`${name}:${String(values[key])};`]
  )
  for (const kind of ['wifi', 'usb', 'ethernet'])
    out.push(`--color-${kind}-onsolid:${seeds.netOn};`)
  out.push(`--sidebar-thumb-mix:${dark || seeds.sidebarDark ? '62%' : '0%'};`)
  return out.join('')
}

/** The colours a user can pick for a network, the same in every theme, light and dark. */
function swatchCss(): string {
  const declare = (dark: boolean): string =>
    NETWORK_SWATCHES.map(
      (swatch) =>
        `--swatch-${swatch.id}:${dark ? swatch.dark : swatch.light};` +
        `--swatch-${swatch.id}-onsolid:${dark ? swatch.darkOn : swatch.lightOn};`
    ).join('')
  return `:root{${declare(false)}}@media (prefers-color-scheme: dark){:root{${declare(true)}}}`
}

/** Every theme, light and dark, as one stylesheet, after the pickable network colours. */
export function themeCss(): string {
  return [
    swatchCss(),
    ...THEMES.map((theme) => {
      const selector = `:root[data-palette="${theme.id}"]`
      return (
        `${selector}{${seedDeclarations(theme.light, false)}}` +
        `@media (prefers-color-scheme: dark){${selector}{${seedDeclarations(theme.dark, true)}}}`
      )
    })
  ].join('\n')
}

const STYLE_ID = 'mergelane-themes'

/** Adds the themes' stylesheet (once) and picks a palette. Called before the first render. */
export function installThemes(doc: Document, palette: ThemeId): void {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = themeCss()
    doc.head.append(style)
  }
  doc.documentElement.dataset.palette = palette
}

const FADE_CLASS = 'mergelane-theme-fade'
const FADE_MS = 260
let fadeTimer: ReturnType<typeof setTimeout> | undefined

/** Colours ease for 220 ms instead of jumping (assets/main.css). There is no movement, so this runs
 * under Reduce Motion too, as the design keeps it: an abrupt switch of every surface is the harsher
 * change. */
export function fadeTheme(doc: Document): void {
  const root = doc.documentElement
  root.classList.add(FADE_CLASS)
  clearTimeout(fadeTimer)
  fadeTimer = setTimeout(() => root.classList.remove(FADE_CLASS), FADE_MS)
}
