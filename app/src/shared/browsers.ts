// The browsers Settings › Browser extensions knows about (M3.4, docs/DECISIONS.md ADR-0038), with how
// the Mergelane extension gets into each. Pure, so it is tested on its own; main/browsers.ts looks
// for them on the Mac.
//
// Only browsers whose native messaging folder is documented by their maker are supported: Chrome and
// Chromium (developer.chrome.com, "Native messaging"), Microsoft Edge (learn.microsoft.com, "Native
// messaging") and Firefox (developer.mozilla.org, "Native manifests"), all read 2026-11-11. Brave and
// Vivaldi document no location, so they are listed as not supported yet rather than guessed at.
// Safari needs its own Safari Web Extension, a later milestone.

export type BrowserId = 'chrome' | 'edge' | 'chromium' | 'firefox' | 'brave' | 'vivaldi' | 'safari'

/** Which build of the extension a browser loads (extension/build.mjs writes one per kind). */
export type ExtensionKind = 'chrome' | 'firefox'

/** A browser on Windows (W2): where it installs itself, and where it looks for native messaging hosts. */
export interface WindowsBrowser {
  /** Its executable, inside one of WINDOWS_ROOTS. */
  exe: string
  /** The HKCU key it reads native messaging hosts from, as its maker documents it: Chrome
   * (developer.chrome.com, "Native messaging"), Edge (learn.microsoft.com, "Native messaging") and Firefox
   * (developer.mozilla.org, "Native manifests"). Null when the maker documents none. */
  hostKey: string | null
}

/** The folders browsers install into on Windows, by environment variable: for every user, for every user's
 * 32-bit programs, and for one user. */
export const WINDOWS_ROOTS = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const

export interface BrowserSpec {
  id: BrowserId
  name: string
  short: string
  /** The app's bundle name in /Applications or ~/Applications. */
  app: string
  /** On Windows; absent for a browser that has no Windows version. */
  windows?: WindowsBrowser
  /** The extension build it loads; null when Mergelane has none for it yet. */
  kind: ExtensionKind | null
  /** Where its extensions are managed, typed into its address bar. */
  extensionsPage: string | null
  /** Why it isn't supported yet, when it isn't. */
  notYet?: string
}

export const BROWSERS: readonly BrowserSpec[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    short: 'Chrome',
    app: 'Google Chrome.app',
    windows: {
      exe: 'Google\\Chrome\\Application\\chrome.exe',
      hostKey: 'Software\\Google\\Chrome\\NativeMessagingHosts'
    },
    kind: 'chrome',
    extensionsPage: 'chrome://extensions'
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    short: 'Edge',
    app: 'Microsoft Edge.app',
    windows: {
      exe: 'Microsoft\\Edge\\Application\\msedge.exe',
      hostKey: 'Software\\Microsoft\\Edge\\NativeMessagingHosts'
    },
    kind: 'chrome',
    extensionsPage: 'edge://extensions'
  },
  {
    id: 'chromium',
    name: 'Chromium',
    short: 'Chromium',
    app: 'Chromium.app',
    windows: { exe: 'Chromium\\Application\\chrome.exe', hostKey: null },
    kind: 'chrome',
    extensionsPage: 'chrome://extensions'
  },
  {
    id: 'firefox',
    name: 'Firefox',
    short: 'Firefox',
    app: 'Firefox.app',
    windows: {
      exe: 'Mozilla Firefox\\firefox.exe',
      hostKey: 'Software\\Mozilla\\NativeMessagingHosts'
    },
    kind: 'firefox',
    extensionsPage: 'about:debugging#/runtime/this-firefox'
  },
  {
    id: 'brave',
    name: 'Brave',
    short: 'Brave',
    app: 'Brave Browser.app',
    windows: { exe: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', hostKey: null },
    kind: null,
    extensionsPage: null,
    notYet: 'Not supported yet: Brave doesn’t document where it looks for Mergelane’s helper.'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    short: 'Vivaldi',
    app: 'Vivaldi.app',
    windows: { exe: 'Vivaldi\\Application\\vivaldi.exe', hostKey: null },
    kind: null,
    extensionsPage: null,
    notYet: 'Not supported yet: Vivaldi doesn’t document where it looks for Mergelane’s helper.'
  },
  {
    id: 'safari',
    name: 'Safari',
    short: 'Safari',
    app: 'Safari.app',
    kind: null,
    extensionsPage: null,
    notYet: 'Coming in a later version: Safari needs its own kind of extension.'
  }
]

/** The folder Mergelane saves each extension build in, inside the chosen location (ADR-0047):
 * Chrome, Edge and Chromium share one. */
export const EXTENSION_FOLDER_NAME: Record<ExtensionKind, string> = {
  chrome: 'Mergelane Extension',
  firefox: 'Mergelane Extension for Firefox'
}

/** A browser's extension reaching Mergelane: when, and the extension's version if it said. */
export interface BrowserContact {
  at: number
  extension?: string
}

/** The browser whose executable started Mergelane's helper (its path), if it's one we know: on macOS
 * the executable sits inside the browser's app bundle, on Windows it is the browser's own exe. */
export function browserOfExecutable(path: string): BrowserId | null {
  const lower = path.toLowerCase()
  return (
    BROWSERS.find(
      (each) =>
        path.includes(`/${each.app}/`) ||
        (each.windows && lower.endsWith(`\\${each.windows.exe.toLowerCase()}`))
    )?.id ?? null
  )
}

/** Where a browser's executable may be on Windows, given the environment, most usual first. */
export function windowsCandidates(
  spec: BrowserSpec,
  env: Record<string, string | undefined>
): string[] {
  if (!spec.windows) return []
  const exe = spec.windows.exe
  return WINDOWS_ROOTS.map((root) => env[root])
    .filter((root): root is string => Boolean(root))
    .map((root) => `${root}\\${exe}`)
}

/** Why a browser isn't supported on this platform yet, or undefined when it is. On Windows a browser
 * whose maker documents no native messaging key can't reach Mergelane's helper. */
export function notYetOn(spec: BrowserSpec, platform: string): string | undefined {
  if (platform !== 'win32') return spec.notYet
  if (!spec.windows) return spec.notYet
  if (spec.windows.hostKey === null) {
    return (
      spec.notYet ??
      `Not supported yet: ${spec.short} doesn’t document where it looks for Mergelane’s helper on Windows.`
    )
  }
  return spec.notYet
}

export interface BrowserState extends BrowserSpec {
  found: boolean
  /** Where it is: the app bundle's path, when found. */
  appPath: string | null
  /** When its extension last reached Mergelane; null if it never has. */
  contact: BrowserContact | null
  /** Where Mergelane saves the extension this browser loads, in the chosen location: the folder to
   * choose in "Load unpacked", or for Firefox the folder holding the manifest.json to choose. It is
   * written when the user installs. Null when this copy of Mergelane has no extension for it. */
  extensionFolder: string | null
}

/** What the browser's file picker is pointed at: the folder, or for Firefox its manifest.json. */
export function pickPath(browser: BrowserState): string | null {
  if (!browser.extensionFolder) return null
  const separator = browser.extensionFolder.includes('\\') ? '\\' : '/'
  return browser.kind === 'firefox'
    ? `${browser.extensionFolder}${separator}manifest.json`
    : browser.extensionFolder
}

/** Saving the extension for a browser: where it went, or why it couldn't. */
export type ExtensionSaved = { ok: true; folder: string } | { ok: false; message: string }

export interface BrowsersReport {
  browsers: BrowserState[]
  /** Whether any browser's extension has reached Mergelane yet. */
  extensionConnected: boolean
  /** The extension version this Mergelane ships, to tell an out-of-date one. */
  extensionVersion: string | null
  /** When the browsers were last looked for. */
  scannedAt: number
  /** The folder Mergelane saves the extension in: Downloads unless the user chose another. */
  extensionLocation: string
}

/** The steps to load the extension by hand in a browser, in order. Settings puts buttons under the
 * first (show the folder, copy its path) and the second (copy the page's address, open the browser):
 * no browser lets another app open its extensions page or pick the folder for the user (ADR-0047). */
export function installSteps(browser: BrowserSpec): string[] {
  if (browser.kind === 'firefox') {
    return [
      'Mergelane saved the extension in this folder. Keep it there.',
      `Open Firefox and go to ${browser.extensionsPage}.`,
      'Click “Load Temporary Add-on…” and choose manifest.json in that folder.',
      'Firefox keeps it until it quits; load it again after a restart.'
    ]
  }
  if (browser.kind === 'chrome') {
    return [
      `Mergelane saved the extension in this folder. Keep it there: ${browser.short} loads it from there.`,
      `Open ${browser.short} and go to ${browser.extensionsPage}.`,
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ]
  }
  return []
}
