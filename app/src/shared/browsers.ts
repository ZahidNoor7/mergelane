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

/** A browser as Settings shows it: the spec, whether it is on this Mac, and where the extension
 * folder to load is. */
export interface BrowserState extends BrowserSpec {
  found: boolean
  /** The folder to choose in the browser ("Load unpacked"), or for Firefox the folder holding the
   * manifest.json to choose; null when the extension isn't ready for this browser. */
  extensionFolder: string | null
}

export interface BrowsersReport {
  browsers: BrowserState[]
  /** Whether any browser's extension has reached Mergelane yet. */
  extensionConnected: boolean
  /** When the browsers were last looked for. */
  scannedAt: number
}

/** The steps to load the extension by hand in a browser, in order. */
export function installSteps(browser: BrowserSpec): string[] {
  if (browser.kind === 'firefox') {
    return [
      'Show the extension folder in the Finder.',
      `In Firefox, go to ${browser.extensionsPage}.`,
      'Click “Load Temporary Add-on…” and choose manifest.json in that folder.',
      'Firefox keeps it until it quits; load it again after a restart.'
    ]
  }
  if (browser.kind === 'chrome') {
    return [
      'Show the extension folder in the Finder.',
      `In ${browser.short}, go to ${browser.extensionsPage}.`,
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ]
  }
  return []
}
