import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  DOWNLOADS_AT_ONCE,
  type AppSettings,
  type NetworkPreference,
  type NetworkPreferences,
  type ProxyConfig,
  type ProxyType,
  type ThemeSource
} from '../shared/types'
import { readJson, updateJson } from './jsonFile'
import { BROWSERS } from '../shared/browsers'
import { sanitizeCaptureRules } from '../shared/captureRules'
import { parseVersion } from '../shared/releases'
import { sanitizeRole } from '../shared/networkRoles'
import { sanitizeRouting } from '../shared/routing'
import { isThemeId, validThemeSource } from '../shared/themes'
import { DEFAULT_DOWNLOAD_SCHEDULE, validSchedule } from '../shared/downloadSchedule'

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_PROXY_TYPES: readonly ProxyType[] = ['http', 'https', 'socks4', 'socks5']

function sanitizeProxyConfig(value: unknown): ProxyConfig | undefined {
  if (!isRecord(value)) return undefined
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : false
  const type =
    typeof value.type === 'string' && (VALID_PROXY_TYPES as readonly string[]).includes(value.type)
      ? (value.type as ProxyType)
      : 'http'
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  const port =
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
      ? value.port
      : 8080
  const username =
    typeof value.username === 'string' && value.username.length > 0 ? value.username : undefined
  const password =
    typeof value.password === 'string' && value.password.length > 0 ? value.password : undefined

  return {
    enabled,
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  }
}

/** A rate or an amount of bytes: a positive whole number, or nothing. */
function byteCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

/** Keeps only fields of the right type (what every reader downstream assumes, e.g.
 * NetworkEditPopover's `customName?.trim()`), entry by entry, rather than discarding every
 * network over one bad entry. An entry left with no field is dropped, so resetting a network
 * removes it from the file. */
function sanitizeNetworkPreferences(parsed: unknown): NetworkPreferences {
  if (!isRecord(parsed)) return {}

  const result: NetworkPreferences = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue
    const preference: NetworkPreference = {}
    if (typeof value.customName === 'string') preference.customName = value.customName
    if (typeof value.colorId === 'string') preference.colorId = value.colorId
    const proxy = sanitizeProxyConfig(value.proxy)
    if (proxy) preference.proxy = proxy
    if (value.off === true) preference.off = true
    preference.role = sanitizeRole(value.role)
    preference.speedLimit = byteCount(value.speedLimit)
    preference.uploadLimit = byteCount(value.uploadLimit)
    preference.dataLimit = byteCount(value.dataLimit)
    if (
      value.dataLimitPeriod === 'day' ||
      value.dataLimitPeriod === 'week' ||
      value.dataLimitPeriod === 'month'
    ) {
      preference.dataLimitPeriod = value.dataLimitPeriod
    }
    for (const key of Object.keys(preference) as (keyof NetworkPreference)[]) {
      if (preference[key] === undefined) delete preference[key]
    }
    if (Object.keys(preference).length > 0) result[id] = preference
  }
  return result
}

/** Trusts nothing past "this is valid JSON" — the file may be hand-edited or from an older
 * version, and a patch comes from the renderer. Every field is checked on its own, so one bad
 * value only loses that value. An `undefined` field in a patch clears it. */
function sanitizeSettings(parsed: unknown): AppSettings {
  if (!isRecord(parsed)) return {}

  const { themeSource, destinationDir, downloadsAtOnce } = parsed
  const settings: AppSettings = {}
  if (parsed.downloadSchedule !== undefined) {
    settings.downloadSchedule = validSchedule(parsed.downloadSchedule)
      ? parsed.downloadSchedule
      : { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true, days: [] }
  }
  const source = validThemeSource(themeSource)
  if (source) settings.themeSource = source
  if (isThemeId(parsed.appearanceTheme)) settings.appearanceTheme = parsed.appearanceTheme
  if (parsed.captureRules !== undefined) {
    settings.captureRules = sanitizeCaptureRules(parsed.captureRules)
  }
  if (isRecord(parsed.browserContacts)) {
    const contacts: NonNullable<AppSettings['browserContacts']> = {}
    for (const { id } of BROWSERS) {
      const contact = parsed.browserContacts[id]
      if (!isRecord(contact) || typeof contact.at !== 'number' || !(contact.at > 0)) continue
      contacts[id] = {
        at: contact.at,
        ...(typeof contact.extension === 'string'
          ? { extension: contact.extension.slice(0, 32) }
          : {})
      }
    }
    settings.browserContacts = contacts
  }
  const routing = sanitizeRouting(parsed.routing)
  if (routing) settings.routing = routing
  if (parsed.menuBarSpeed === false) settings.menuBarSpeed = false
  if (parsed.notifyWhenDone === false) settings.notifyWhenDone = false
  if (parsed.offerCopiedLinks === true) settings.offerCopiedLinks = true
  if (parsed.updateAutoCheck === false) settings.updateAutoCheck = false
  if (parsed.updateChannel === 'beta') settings.updateChannel = 'beta'
  if (parsed.updateBackgroundDownload === true) settings.updateBackgroundDownload = true
  if (typeof parsed.updateSkipped === 'string' && parseVersion(parsed.updateSkipped)) {
    settings.updateSkipped = parsed.updateSkipped
  }
  const lastChecked = parsed.updateLastChecked
  if (typeof lastChecked === 'number' && Number.isFinite(lastChecked) && lastChecked > 0) {
    settings.updateLastChecked = lastChecked
  }
  if (typeof destinationDir === 'string' && isAbsolute(destinationDir)) {
    settings.destinationDir = destinationDir
  }
  // Clamped rather than dropped: a count saved under an older, higher limit keeps the most allowed.
  if (Number.isInteger(downloadsAtOnce) && (downloadsAtOnce as number) >= DOWNLOADS_AT_ONCE.min) {
    settings.downloadsAtOnce = Math.min(downloadsAtOnce as number, DOWNLOADS_AT_ONCE.max)
  }
  if (parsed.networkPreferences !== undefined) {
    settings.networkPreferences = sanitizeNetworkPreferences(parsed.networkPreferences)
  }
  const speedLimit = byteCount(parsed.speedLimit)
  if (speedLimit !== undefined) settings.speedLimit = speedLimit
  const uploadLimit = byteCount(parsed.uploadLimit)
  if (uploadLimit !== undefined) settings.uploadLimit = uploadLimit
  const slowModeSpeed = byteCount(parsed.slowModeSpeed)
  if (slowModeSpeed !== undefined) settings.slowModeSpeed = slowModeSpeed
  if (parsed.slowMode === true) settings.slowMode = true
  if (parsed.glassLook === 'clear' || parsed.glassLook === 'tinted') {
    settings.glassLook = parsed.glassLook
  }
  if (parsed.solidGlass === true) settings.solidGlass = true
  if (parsed.speedUnit === 'bytes' || parsed.speedUnit === 'bits') {
    settings.speedUnit = parsed.speedUnit
  }
  if (parsed.browserExtensionUsed === true) settings.browserExtensionUsed = true
  return settings
}

export async function loadSettings(): Promise<AppSettings> {
  // Reading can fall back to defaults; only a save must not act on a failed read.
  try {
    return sanitizeSettings(await readJson(settingsPath()))
  } catch {
    return {}
  }
}

/** Merges `patch` over what's saved. */
export function saveSettings(patch: unknown): Promise<void> {
  if (
    isRecord(patch) &&
    patch.downloadSchedule !== undefined &&
    !validSchedule(patch.downloadSchedule)
  ) {
    return Promise.reject(new Error('Choose different start and stop times and at least one day.'))
  }
  return updateJson(settingsPath(), (current) =>
    sanitizeSettings({ ...sanitizeSettings(current), ...(isRecord(patch) ? patch : {}) })
  )
}

export async function loadThemeSource(): Promise<ThemeSource> {
  // First run: Auto, following the Mac (ADR-0034). A saved light or dark choice stays as it was.
  return (await loadSettings()).themeSource ?? 'system'
}

/** Network names/colors lived in their own network-preferences.json up to 1.0.0-rc.8. Folds
 * that file into app-settings.json once, then deletes it (a corrupt one is just deleted). */
export async function migrateLegacyNetworkPreferences(): Promise<void> {
  const legacyPath = join(app.getPath('userData'), 'network-preferences.json')
  const legacy = await readJson(legacyPath)
  if (legacy !== undefined) {
    await updateJson(settingsPath(), (current) => {
      const settings = sanitizeSettings(current)
      return settings.networkPreferences
        ? settings
        : { ...settings, networkPreferences: sanitizeNetworkPreferences(legacy) }
    })
  }
  await rm(legacyPath, { force: true })
}
