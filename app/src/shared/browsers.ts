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

export interface BrowserSpec {
  id: BrowserId
  name: string
  short: string
  /** The app's bundle name in /Applications or ~/Applications. */
  app: string
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
    kind: 'chrome',
    extensionsPage: 'chrome://extensions'
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    short: 'Edge',
    app: 'Microsoft Edge.app',
    kind: 'chrome',
    extensionsPage: 'edge://extensions'
  },
  {
    id: 'chromium',
    name: 'Chromium',
    short: 'Chromium',
    app: 'Chromium.app',
    kind: 'chrome',
    extensionsPage: 'chrome://extensions'
  },
  {
    id: 'firefox',
    name: 'Firefox',
    short: 'Firefox',
    app: 'Firefox.app',
    kind: 'firefox',
    extensionsPage: 'about:debugging#/runtime/this-firefox'
  },
  {
    id: 'brave',
    name: 'Brave',
    short: 'Brave',
    app: 'Brave Browser.app',
    kind: null,
    extensionsPage: null,
    notYet: 'Not supported yet: Brave doesn’t document where it looks for Mergelane’s helper.'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    short: 'Vivaldi',
    app: 'Vivaldi.app',
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

/** The browser whose executable started Mergelane's helper (its path, from ps), if it's one we know:
 * the executable sits inside the browser's app bundle. */
export function browserOfExecutable(path: string): BrowserId | null {
  return BROWSERS.find((each) => path.includes(`/${each.app}/`))?.id ?? null
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
  return browser.kind === 'firefox'
    ? `${browser.extensionFolder}/manifest.json`
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
