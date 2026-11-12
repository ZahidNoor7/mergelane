import { describe, expect, it } from 'vitest'
import {
  BACKDROP_FROM_BUILD,
  backdropSupported,
  windowsBackdrop,
  windowsBuild
} from './windowMaterial'
import { THEMES, windowInk } from './themes'

describe('windowsBuild', () => {
  it("reads the build from Electron's system version", () => {
    expect(windowsBuild('10.0.22631')).toBe(22631)
    expect(windowsBuild('10.0.19045')).toBe(19045)
    expect(windowsBuild('27.0')).toBe(0)
    expect(windowsBuild('')).toBe(0)
  })
})

describe('windowsBackdrop', () => {
  const glass = { liquid: true, solid: false, reducedTransparency: false }

  it('uses acrylic for Liquid Glass from Windows 11 22H2', () => {
    expect(BACKDROP_FROM_BUILD).toBe(22621)
    expect(backdropSupported(22621)).toBe(true)
    expect(windowsBackdrop({ build: 22631, ...glass })).toBe('acrylic')
  })

  it('sets none for every other theme, or when the glass is made solid', () => {
    expect(windowsBackdrop({ build: 26100, ...glass, liquid: false })).toBe('none')
    expect(windowsBackdrop({ build: 26100, ...glass, solid: true })).toBe('none')
    expect(windowsBackdrop({ build: 26100, ...glass, reducedTransparency: true })).toBe('none')
  })

  it('sets nothing on Windows 10 or Windows 11 before 22H2', () => {
    expect(backdropSupported(22000)).toBe(false)
    expect(windowsBackdrop({ build: 19045, ...glass })).toBeNull()
    expect(windowsBackdrop({ build: 22000, ...glass })).toBeNull()
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
