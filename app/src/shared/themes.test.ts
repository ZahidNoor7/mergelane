import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ID,
  isThemeId,
  themeById,
  THEMES,
  validThemeSource,
  windowBackground
} from './themes'

describe('themes', () => {
  it('has the seven themes of ADR-0034, Porcelain first and the default', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([
      'porcelain',
      'sandstone',
      'graphite',
      'sage',
      'dusk',
      'liquid',
      'contrast'
    ])
    expect(DEFAULT_THEME_ID).toBe('porcelain')
  })

  it('knows its ids and nothing else', () => {
    expect(isThemeId('dusk')).toBe(true)
    expect(isThemeId('solarized')).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
  })

  it('falls back to the default for an unknown theme', () => {
    expect(themeById('sage').id).toBe('sage')
    expect(themeById('removed-later').id).toBe('porcelain')
  })

  it('paints the window with the theme’s ground in each mode', () => {
    expect(windowBackground('graphite', false)).toBe('#FAFAFA')
    expect(windowBackground('graphite', true)).toBe('#18181B')
    expect(windowBackground(undefined, true)).toBe('#151D22')
  })

  it('accepts Auto, light and dark only', () => {
    expect(validThemeSource('system')).toBe('system')
    expect(validThemeSource('light')).toBe('light')
    expect(validThemeSource('dark')).toBe('dark')
    expect(validThemeSource('sepia')).toBeUndefined()
    expect(validThemeSource(1)).toBeUndefined()
  })
})
