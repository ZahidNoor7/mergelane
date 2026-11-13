import { beforeEach, describe, expect, it, vi } from 'vitest'

// settings.ts reads the extension API through api.ts, which picks `chrome` when there is no
// `browser`: a stand-in storage area is enough here.
const store: Record<string, unknown> = {}
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (defaults: Record<string, unknown>) => {
        const found: Record<string, unknown> = {}
        for (const key of Object.keys(defaults))
          found[key] = key in store ? store[key] : defaults[key]
        return found
      }),
      set: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      })
    }
  }
})

const { excluded, loadAppRules, loadSettings, ownChange, saveAppRules, saveSettings, siteOf } =
  await import('./settings')

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
})

describe('ownChange', () => {
  it("is true for Mergelane's settings", () => {
    expect(ownChange({ capture: {} })).toBe(true)
    expect(ownChange({ sites: {}, rulesetConfig: {} })).toBe(true)
    expect(ownChange({ appRules: {} })).toBe(true)
  })
  it("is false for uBO Lite's state alone", () => {
    expect(ownChange({ rulesetConfig: {}, filteringModeDetails: {} })).toBe(false)
    expect(ownChange({})).toBe(false)
  })
})

describe('settings', () => {
  it('has defaults and keeps what is saved', async () => {
    expect(await loadSettings()).toEqual({
      capture: true,
      sites: [],
      skipSmall: false,
      minMegabytes: 1
    })
    await saveSettings({ capture: false, sites: ['example.com'] })
    expect(await loadSettings()).toMatchObject({ capture: false, sites: ['example.com'] })
  })
  it("keeps Mergelane's rules, defaulting to on", async () => {
    expect(await loadAppRules()).toEqual({ capture: true, videoButton: true })
    await saveAppRules({ capture: false, videoButton: true })
    expect(await loadAppRules()).toEqual({ capture: false, videoButton: true })
  })
})

describe('siteOf', () => {
  it('reads a site from what is typed', () => {
    expect(siteOf('https://Drive.Google.com/x')).toBe('drive.google.com')
    expect(siteOf('*.example.com')).toBe('example.com')
    expect(siteOf('localhost')).toBe('localhost')
  })
  it('refuses what is not a site', () => {
    expect(siteOf('nodot')).toBeNull()
    expect(siteOf('http://[bad')).toBeNull()
  })
})

describe('excluded', () => {
  it('matches a site and its subdomains', () => {
    expect(excluded(['example.com'], ['https://cdn.example.com/f.zip'])).toBe(true)
    expect(excluded(['example.com'], [undefined, 'https://example.com/'])).toBe(true)
    expect(excluded(['example.com'], ['https://notexample.com/'])).toBe(false)
    expect(excluded(['example.com'], ['not a url', undefined])).toBe(false)
  })
})
