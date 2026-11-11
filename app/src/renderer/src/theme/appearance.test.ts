import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEMES } from '@shared/themes'
import { fadeTheme, installThemes, seedDeclarations, themeCss } from './appearance'

describe('seedDeclarations', () => {
  it('writes the seeds, the sidebar ink and the glyph colour on each network', () => {
    const porcelain = THEMES[0].light
    const css = seedDeclarations(porcelain, false)
    expect(css).toContain('--bg:#FBFCFD;')
    expect(css).toContain('--color-accent:#2853C7;')
    // No sidebar ink of its own: the content ink.
    expect(css).toContain('--sidebar-ink:#101B22;')
    expect(css).toContain('--color-usb-onsolid:#FFFFFF;')
    expect(css).toContain('--sidebar-thumb-mix:0%;')
    expect(css).not.toContain('--accent-ink')
    expect(css).not.toContain('undefined')
  })

  it('gives a dark sidebar dark-mode switch thumbs, in light mode and always in dark', () => {
    const graphite = THEMES.find((theme) => theme.id === 'graphite')!
    expect(seedDeclarations(graphite.light, false)).toContain('--sidebar-ink:#EDEDEF;')
    expect(seedDeclarations(graphite.light, false)).toContain('--sidebar-thumb-mix:62%;')
    expect(seedDeclarations(THEMES[0].dark, true)).toContain('--sidebar-thumb-mix:62%;')
  })

  it('writes the strength overrides when a theme has them', () => {
    const contrast = THEMES.find((theme) => theme.id === 'contrast')!
    expect(seedDeclarations(contrast.light, false)).toContain('--line:48%;--line-subtle:30%;')
  })
})

describe('themeCss', () => {
  it('has a light rule and a dark rule per theme', () => {
    const css = themeCss()
    for (const theme of THEMES) {
      expect(css).toContain(`:root[data-palette="${theme.id}"]{`)
      expect(css).toContain(
        `@media (prefers-color-scheme: dark){:root[data-palette="${theme.id}"]{`
      )
    }
    // One per theme, and one for the pickable network colours.
    expect(css.match(/@media/g)).toHaveLength(THEMES.length + 1)
    expect(css).toContain(':root{--swatch-teal:#1F8A70;--swatch-teal-onsolid:#FFFFFF;')
    expect(css).toContain('--swatch-coral:#D99168;--swatch-coral-onsolid:#241209;')
  })
})

describe('installThemes', () => {
  afterEach(() => {
    document.getElementById('mergelane-themes')?.remove()
    delete document.documentElement.dataset.palette
  })

  it('adds the stylesheet once and picks the palette', () => {
    installThemes(document, 'sage')
    installThemes(document, 'dusk')
    expect(document.querySelectorAll('#mergelane-themes')).toHaveLength(1)
    expect(document.getElementById('mergelane-themes')!.textContent).toBe(themeCss())
    expect(document.documentElement.dataset.palette).toBe('dusk')
  })
})

describe('fadeTheme', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('eases colours for a moment, and a second change restarts the moment', () => {
    vi.useFakeTimers()
    const root = document.documentElement
    fadeTheme(document)
    expect(root.classList.contains('mergelane-theme-fade')).toBe(true)
    vi.advanceTimersByTime(200)
    fadeTheme(document)
    vi.advanceTimersByTime(200)
    expect(root.classList.contains('mergelane-theme-fade')).toBe(true)
    vi.advanceTimersByTime(60)
    expect(root.classList.contains('mergelane-theme-fade')).toBe(false)
  })
})
