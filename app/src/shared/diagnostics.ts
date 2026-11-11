import { sanitizeCaptureRules } from './captureRules'
import type { NetworkActivity } from './networkActivity'
import type {
  AppSettings,
  DownloadUpdate,
  FinishedDownload,
  NetworkInterfaceInfo,
  SystemMergeSnapshot,
  UsenetServer
} from './types'

// The diagnostics bundle (M3.7, docs/DECISIONS.md ADR-0042): made only when the user asks, saved where
// they choose, and never sent anywhere by Mergelane. Everything in it is picked field by field from
// an allowlist, so a setting or download field added later stays out until someone decides it may
// go in; then every string left is passed through redactIdentity as a second net. Pure, so the
// redaction is unit-tested (diagnostics.test.ts) and checked again end to end
// (e2e/diagnostics.spec.ts).

/** Who the bundle must not name. */
export interface RedactionContext {
  /** The user's home folder, e.g. /Users/alex. */
  home: string
  /** Their account name, when the system says. */
  userName?: string
}

/** A link reduced to its scheme and host: a path or query can carry a signed token, a share id or
 * a file name, and a user name or password can sit before the host. */
export function redactUrl(raw: string): string {
  if (/^magnet:/i.test(raw)) return 'magnet:…'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '[link]'
  }
  if (!url.hostname) return `${url.protocol}…`
  const bare = url.pathname === '/' && !url.search && !url.hash
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/${bare ? '' : '…'}`
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()[\]{}]+/gi
const MAGNET_PATTERN = /\bmagnet:\?[^\s"'<>]+/gi
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi
/** One piece of a path: up to a space or punctuation, so a sentence around it stays. */
const PATH_PART = `[^\\s"'<>:;,()]+`
const HOME_PATH_PATTERN = new RegExp(`~(?:/${PATH_PART})+`, 'g')
const USERS_PATTERN = new RegExp(`/Users/(?!Shared\\b)${PATH_PART}`, 'g')
const VOLUMES_PATTERN = new RegExp(`/Volumes/${PATH_PART}`, 'g')
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6_PATTERN = /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi

/** Links, magnets, email addresses, paths in the home folder or on other disks, and the account
 * name, taken out of any text. A path keeps only where it starts (~/…), since its folders and file
 * can say what the user keeps there. */
export function redactIdentity(text: string, context: RedactionContext): string {
  let out = text.replace(URL_PATTERN, redactUrl).replace(MAGNET_PATTERN, 'magnet:…')
  out = out.replace(EMAIL_PATTERN, '<email>')
  if (context.home.length > 1) {
    out = out.replace(new RegExp(`${escapeRegExp(context.home)}(?=/|\\b|$)`, 'g'), '~')
  }
  out = out
    .replace(HOME_PATH_PATTERN, '~/…')
    .replace(USERS_PATTERN, '/Users/<user>/…')
    .replace(VOLUMES_PATTERN, '/Volumes/…')
  const name = context.userName
  if (name && name.length >= 3) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-])`, 'gi'), '<user>')
  }
  return out
}

/** Where an address points: enough to tell a LAN from a phone's hotspot from the open internet,
 * without the address itself. */
export type AddressScope = 'loopback' | 'link-local' | 'private' | 'shared' | 'public'

export function addressScope(address: string, family: 4 | 6): AddressScope {
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 127) return 'loopback'
    if (a === 169 && b === 254) return 'link-local'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
    if (a === 100 && b >= 64 && b <= 127) return 'shared'
    return 'public'
  }
  const lower = address.toLowerCase()
  if (lower === '::1') return 'loopback'
  if (/^fe[89ab]/.test(lower)) return 'link-local'
  if (/^f[cd]/.test(lower)) return 'private'
  return 'public'
}

/** Free text from a server, the system or the helper (an error, a log line): redactIdentity, and
 * every public IP address masked, since one can be the user's own. */
export function redactText(text: string, context: RedactionContext): string {
  return redactIdentity(text, context)
    .replace(IPV4_PATTERN, (ip) =>
      ip.split('.').every((part) => Number(part) <= 255) && addressScope(ip, 4) === 'public'
        ? '<ip>'
        : ip
    )
    .replace(IPV6_PATTERN, (ip) =>
      (ip.includes('::') || ip.split(':').length >= 6) && addressScope(ip, 6) === 'public'
        ? '<ip>'
        : ip
    )
}

/** A file's type by its extension alone (`zip`), since its name can say what it is. */
export function fileType(name: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString()

/** What a download is doing, without its link, file name, folder or sign-in. */
export function summarizeDownload(
  download: DownloadUpdate['state'] | FinishedDownload,
  context: RedactionContext
): Record<string, unknown> {
  const fields = download as unknown as Record<string, unknown>
  const count = (key: string): number | undefined =>
    Array.isArray(fields[key]) ? (fields[key] as unknown[]).length : undefined
  // Its own file and folder first, whole, since a name can hold spaces a pattern would stop at.
  const own = [download.destinationPath, download.fileName].filter((name) => name.length > 2)
  const words = (text: string): string =>
    redactText(
      own.reduce((out, name) => out.split(name).join('<file>'), text),
      context
    )
  const number = (key: string): number | undefined =>
    typeof fields[key] === 'number' ? (fields[key] as number) : undefined
  return {
    id: download.id,
    kind: download.kind,
    status: download.status,
    site: redactUrl(download.url),
    fileType: fileType(download.fileName),
    totalBytes: download.totalBytes,
    bytesDownloaded: download.bytesDownloaded,
    speedBytesPerSec: download.speedBytesPerSec,
    peakSpeedBytesPerSec: download.peakSpeedBytesPerSec,
    startedAt: iso(download.startedAt),
    completedAt: iso(download.completedAt),
    error: download.error === undefined ? undefined : words(download.error),
    resumable: download.resumable,
    scheduled: download.scheduled,
    missing: 'missing' in download ? download.missing : undefined,
    fromBrowser: 'fromBrowser' in download ? download.fromBrowser !== undefined : undefined,
    parts: number('totalBlocks') ?? number('totalPieces'),
    connections: count('streams') ?? count('peers'),
    peakConnections: number('peakStreams') ?? number('peakPeers'),
    networks: download.networks.map((network) => ({
      id: network.id,
      kind: network.kind,
      enabled: network.enabled,
      status: network.status,
      bytesDownloaded: network.bytesDownloaded,
      retries: network.retries,
      error: network.error === undefined ? undefined : words(network.error)
    }))
  }
}

/** The networks, by kind and name as macOS reports them, each address reduced to its family and
 * scope; no addresses and no hardware (MAC) addresses. */
export function summarizeInterfaces(networks: NetworkInterfaceInfo[]): Record<string, unknown>[] {
  return networks.map((network) => ({
    id: network.id,
    kind: network.kind,
    name: network.displayName,
    addresses: network.addresses.map((address) => ({
      family: address.family,
      scope: addressScope(address.address, address.family)
    }))
  }))
}

/** Where downloads are saved, without naming the folder. */
function destinationOf(dir: string | undefined, context: RedactionContext): string {
  if (dir === undefined) return 'Downloads (default)'
  if (context.home.length > 1 && (dir === context.home || dir.startsWith(`${context.home}/`))) {
    return 'a folder in the home folder'
  }
  if (dir.startsWith('/Volumes/')) return 'a folder on another disk'
  return 'a folder elsewhere'
}

/** The settings that help explain a problem; names, folders, proxies' hosts and sign-ins left out. */
export function summarizeSettings(
  settings: AppSettings,
  context: RedactionContext
): Record<string, unknown> {
  return {
    themeSource: settings.themeSource,
    appearanceTheme: settings.appearanceTheme,
    glassLook: settings.glassLook,
    solidGlass: settings.solidGlass,
    speedUnit: settings.speedUnit,
    downloadsAtOnce: settings.downloadsAtOnce,
    speedLimit: settings.speedLimit,
    slowMode: settings.slowMode,
    slowModeSpeed: settings.slowModeSpeed,
    menuBarSpeed: settings.menuBarSpeed,
    notifyWhenDone: settings.notifyWhenDone,
    updateAutoCheck: settings.updateAutoCheck,
    updateChannel: settings.updateChannel,
    updateBackgroundDownload: settings.updateBackgroundDownload,
    updateLastChecked: iso(settings.updateLastChecked),
    updateSkipped: settings.updateSkipped,
    destination: destinationOf(settings.destinationDir, context),
    downloadSchedule: settings.downloadSchedule && {
      enabled: settings.downloadSchedule.enabled,
      startMinute: settings.downloadSchedule.startMinute,
      endMinute: settings.downloadSchedule.endMinute,
      days: settings.downloadSchedule.days,
      endDate: settings.downloadSchedule.endDate
    },
    captureRules: settings.captureRules && sanitizeCaptureRules(settings.captureRules),
    routing: settings.routing && {
      down: settings.routing.down,
      fallback: settings.routing.fallback
    },
    browserExtensionUsed: settings.browserExtensionUsed,
    browsers: Object.fromEntries(
      Object.entries(settings.browserContacts ?? {}).map(([id, contact]) => [
        id,
        { lastContact: iso(contact?.at), extension: contact?.extension }
      ])
    ),
    networks: Object.fromEntries(
      Object.entries(settings.networkPreferences ?? {}).map(([id, preference]) => [
        id,
        {
          renamed: preference.customName !== undefined,
          colorId: preference.colorId,
          off: preference.off,
          speedLimit: preference.speedLimit,
          dataLimit: preference.dataLimit,
          dataLimitPeriod: preference.dataLimitPeriod,
          proxy: preference.proxy && {
            enabled: preference.proxy.enabled,
            type: preference.proxy.type,
            signIn: preference.proxy.username !== undefined
          }
        }
      ])
    )
  }
}

/** System-wide merging as the helper reports it; its free-text words redacted. */
export function summarizeHelper(
  helper: SystemMergeSnapshot,
  context: RedactionContext
): Record<string, unknown> {
  return {
    installed: helper.installed,
    reachable: helper.reachable,
    state: helper.state,
    reason: helper.reason === undefined ? undefined : redactText(helper.reason, context),
    error: helper.error === undefined ? undefined : redactText(helper.error, context),
    appVersion: helper.appVersion,
    helperVersion: helper.helperVersion,
    helperOutdated: helper.helperOutdated,
    autoResume: helper.autoResume,
    links: helper.links,
    events: helper.events,
    outages: helper.outages
  }
}

/** The helper's log: its last lines, redacted. */
export const HELPER_LOG_LINES = 200

export function redactLog(text: string, context: RedactionContext): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
    .slice(-HELPER_LOG_LINES)
    .map((line) => redactText(line, context))
    .join('\n')
}

/** What the main process gathers for a bundle. */
export interface DiagnosticsInput {
  generatedAt: number
  app: {
    version: string
    packaged: boolean
    electron: string
    chrome: string
    node: string
    /** Running under Rosetta: the Intel build on an Apple silicon Mac. */
    translated: boolean
  }
  system: {
    platform: string
    /** The app's architecture (process.arch). */
    arch: string
    /** The hardware's (os.machine()). */
    machine: string
    /** macOS's version (process.getSystemVersion()). */
    macOS: string
    /** The kernel's (os.release()). */
    darwin: string
    cpu: string
    cpuCount: number
    memoryBytes: number
  }
  /** Null when asking the helper failed. */
  helper: SystemMergeSnapshot | null
  networks: NetworkInterfaceInfo[]
  activity: NetworkActivity
  settings: AppSettings
  usenet: UsenetServer | null
  downloads: DownloadUpdate['state'][]
  /** Newest first. */
  history: FinishedDownload[]
}

/** The most finished downloads a bundle lists. */
export const HISTORY_IN_BUNDLE = 50

/** Every string in `value`, at any depth, through redactIdentity: the second net. */
export function redactStrings<T>(value: T, context: RedactionContext): T {
  if (typeof value === 'string') return redactIdentity(value, context) as T
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, context)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, context)])
    ) as T
  }
  return value
}

/** diagnostics.json: everything in the bundle but the helper's log. */
export function buildDiagnostics(
  input: DiagnosticsInput,
  context: RedactionContext
): Record<string, unknown> {
  const usenet = input.usenet
  return redactStrings(
    {
      bundle: { format: 1, generatedAt: iso(input.generatedAt) },
      app: input.app,
      system: input.system,
      helper: input.helper
        ? summarizeHelper(input.helper, context)
        : { error: 'The helper could not be asked.' },
      networks: summarizeInterfaces(input.networks),
      networkActivity: input.activity,
      settings: summarizeSettings(input.settings, context),
      usenet: usenet
        ? {
            configured: true,
            enabled: usenet.enabled,
            tls: usenet.tls,
            port: usenet.port,
            connections: usenet.connections,
            hasPassword: usenet.hasPassword,
            passwordInMemory: usenet.passwordInMemory
          }
        : { configured: false },
      downloads: input.downloads.map((download) => summarizeDownload(download, context)),
      history: {
        total: input.history.length,
        newest: input.history
          .slice(0, HISTORY_IN_BUNDLE)
          .map((download) => summarizeDownload(download, context))
      }
    },
    context
  )
}

/** README.txt: what the bundle holds and what was left out, for the user and for whoever reads it. */
export function diagnosticsReadme(generatedAt: number, hasHelperLog: boolean): string {
  return [
    'Mergelane diagnostics',
    `Made ${new Date(generatedAt).toISOString()} on request. Mergelane never sends this anywhere:`,
    'attach it to a GitHub issue yourself if you want help.',
    '',
    'What is in it',
    '- diagnostics.json: the versions of Mergelane, its helper, Electron and macOS; the Mac’s',
    '  architecture, processor and memory; each network’s kind and name, and its addresses only as',
    '  "private" or "public"; system-wide merging’s state; the networks that dropped or came back',
    '  in the last week; the settings that change how downloads run; and each download’s',
    '  progress, speed, networks and errors (unfinished ones, and the last 50 finished).',
    hasHelperLog
      ? `- helper-log.txt: the last lines of the helper's log, /Library/Logs/Mergelane/daemon.log.`
      : '- No helper log: the helper is not installed, or its log could not be read.',
    '',
    'What was left out or replaced',
    '- Links keep only their site (https://example.com/…): no path, query, sign-in or token.',
    '- File names keep only their type (zip); folders are not named.',
    '- Cookies, sign-in headers, browser profiles, passwords, user names and proxy hosts are not',
    '  included, nor are the contents of any file.',
    '- Your home folder reads ~, your account name <user>, email addresses <email>, and public IP',
    '  addresses <ip>. Network hardware (MAC) addresses and IP addresses are not included.',
    '- Network names you gave are left out (only whether one was renamed).',
    ''
  ].join('\n')
}

/** The bundle's file name for a moment, on this Mac's calendar: Mergelane-Diagnostics-2026-11-11-1430.zip. */
export function diagnosticsFileName(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `Mergelane-Diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`
}
