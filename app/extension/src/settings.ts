import { api } from './api'
export interface Settings {
  capture: boolean
  sites: string[]
  skipSmall: boolean
  minMegabytes: number
}

const DEFAULTS: Settings = {
  capture: true,
  sites: [],
  skipSmall: false,
  minMegabytes: 1
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) } as Settings
}

/** Whether a storage change touched Mergelane's own settings. uBO Lite (ADR-0063) keeps its state in
 * the same storage area, and its writes don't change anything Mergelane shows. */
export function ownChange(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some((key) => key in DEFAULTS || key === 'appRules')
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return api.storage.local.set(patch)
}

/** What Mergelane's Settings › Browser extensions says, as its last answer to a ping carried it
 * (bridge api 3). Mergelane applies the rest of its rules to each download itself. */
export interface AppRules {
  capture: boolean
  videoButton: boolean
}

const APP_RULES: AppRules = { capture: true, videoButton: true }

export async function loadAppRules(): Promise<AppRules> {
  const { appRules } = await api.storage.local.get({ appRules: APP_RULES })
  return { ...APP_RULES, ...(appRules as Partial<AppRules>) }
}

export function saveAppRules(rules: AppRules): Promise<void> {
  return api.storage.local.set({
    appRules: { capture: rules.capture !== false, videoButton: rules.videoButton !== false }
  })
}

/** The site rule typed or pasted ("https://Drive.Google.com/x", "*.example.com"), or null. */
export function siteOf(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^\*\./, '')
  try {
    const host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname
    return host.includes('.') || host === 'localhost' ? host : null
  } catch {
    return null
  }
}

export function excluded(sites: readonly string[], urls: readonly (string | undefined)[]): boolean {
  return urls.some((url) => {
    if (!url) return false
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    return sites.some((site) => host === site || host.endsWith(`.${site}`))
  })
}
