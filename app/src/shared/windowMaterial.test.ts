import { describe, expect, it } from 'vitest'
import {
  BACKDROP_FROM_BUILD,
  backdropSupported,
  windowsBackdrop,
  windowsBuild
} from './windowMaterial'
import { THEMES, themeOnPlatform, windowInk, windowsGround } from './themes'
import { formatHex, mix, oklabDistance, parseHex } from './colour'

describe('windowsBuild', () => {
  it("reads the build from Electron's system version", () => {
    expect(windowsBuild('10.0.22631')).toBe(22631)
    expect(windowsBuild('10.0.19045')).toBe(19045)
    expect(windowsBuild('27.0')).toBe(0)
    expect(windowsBuild('')).toBe(0)
  })
})

describe('windowsBackdrop', () => {
  it('puts every theme on Mica from Windows 11 22H2', () => {
    expect(BACKDROP_FROM_BUILD).toBe(22621)
    expect(backdropSupported(22621)).toBe(true)
    expect(windowsBackdrop({ build: 22631, reducedTransparency: false })).toBe('mica')
  })

  it('sets none when transparency effects are off', () => {
    expect(windowsBackdrop({ build: 26100, reducedTransparency: true })).toBe('none')
  })

  it('sets nothing on Windows 10 or Windows 11 before 22H2', () => {
    expect(backdropSupported(22000)).toBe(false)
    expect(windowsBackdrop({ build: 19045, reducedTransparency: false })).toBeNull()
    expect(windowsBackdrop({ build: 22000, reducedTransparency: false })).toBeNull()
  })
})

describe('themeOnPlatform', () => {
  it('offers Liquid Glass on the Mac only: Windows shows Porcelain instead', () => {
    expect(themeOnPlatform('liquid', 'win32')).toBe('porcelain')
    expect(themeOnPlatform('liquid', 'darwin')).toBe('liquid')
    for (const theme of THEMES.filter((each) => each.id !== 'liquid')) {
      expect(themeOnPlatform(theme.id, 'win32')).toBe(theme.id)
    }
  })
})

describe('windowsGround', () => {
  it('is the window colour with 7% of the accent, mixed in Oklab as the design draws it', () => {
    for (const theme of THEMES) {
      for (const dark of [false, true]) {
        const seeds = dark ? theme.dark : theme.light
        expect(windowsGround(theme.id, dark)).toBe(
          formatHex(mix(parseHex(seeds.window), 93, parseHex(seeds.accent)))
        )
        // A hint, not a colour: it stays close to the window colour.
        expect(oklabDistance(windowsGround(theme.id, dark), seeds.window)).toBeLessThan(0.05)
      }
    }
    expect(windowsGround('porcelain', false)).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('windowInk', () => {
  it("is each theme's text colour for the mode", () => {
    for (const theme of THEMES) {
      expect(windowInk(theme.id, false)).toBe(theme.light.text)
      expect(windowInk(theme.id, true)).toBe(theme.dark.text)
    }
  })
})

describe('formatHex', () => {
  it('writes a colour back as #RRGGBB, clamped and rounded', () => {
    expect(formatHex(parseHex('#2853c7'))).toBe('#2853C7')
    expect(formatHex([1.2, -0.1, 0.5])).toBe('#FF0080')
  })
})
