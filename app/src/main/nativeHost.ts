import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID, NATIVE_HOST } from '../shared/browserBridge'

// Registers mergelane-nmhost with the user's browsers (docs/BROWSER-BRIDGE.md): a per-user
// manifest in each browser's NativeMessagingHosts folder, no admin rights needed. Locations from
// Chrome's, Microsoft's and Mozilla's native messaging docs (user-specific, macOS); Edge's is
// learn.microsoft.com, "Native messaging", Step 3 (the Stable channel's folder).

interface Browser {
  /** The browser's own Application Support folder: only browsers that have one get a manifest. */
  dir: string
  firefox: boolean
}

export function browsers(home: string): Browser[] {
  const support = join(home, 'Library', 'Application Support')
  return [
    { dir: join(support, 'Google', 'Chrome'), firefox: false },
    { dir: join(support, 'Google', 'ChromeForTesting'), firefox: false },
    { dir: join(support, 'Chromium'), firefox: false },
    { dir: join(support, 'Mozilla'), firefox: true },
    { dir: join(support, 'Microsoft Edge'), firefox: false }
  ]
}

/** The manifest JSON for one browser. */
export function hostManifest(binary: string, firefox: boolean): string {
  const common = {
    name: NATIVE_HOST,
    description: 'Hands downloads from the browser to Mergelane',
    path: binary,
    type: 'stdio'
  }
  const manifest = firefox
    ? { ...common, allowed_extensions: [FIREFOX_EXTENSION_ID] }
    : { ...common, allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Writes the manifest for every installed browser; returns the files written. A browser that
 * isn't installed gets nothing, and one that can't be written to is skipped. */
export async function registerNativeHost(
  binary: string,
  home: string,
  exists: (path: string) => boolean = existsSync
): Promise<string[]> {
  const written: string[] = []
  for (const browser of browsers(home)) {
    if (!exists(browser.dir)) continue
    const folder = join(browser.dir, 'NativeMessagingHosts')
    const file = join(folder, `${NATIVE_HOST}.json`)
    try {
      await mkdir(folder, { recursive: true })
      await writeFile(file, hostManifest(binary, browser.firefox), { mode: 0o644 })
      written.push(file)
    } catch (error) {
      console.warn(`[mergelane] couldn't register the browser host in ${folder}:`, error)
    }
  }
  return written
}

// Windows (W2): the manifest may sit anywhere, and each browser finds it through a key under HKCU whose
// default value is the manifest's full path (Chrome's, Microsoft's and Mozilla's native messaging docs, which
// give `REG ADD "HKCU\…\NativeMessagingHosts\<name>" /ve /t REG_SZ /d "<manifest>" /f`). Mergelane keeps the
// two manifests (one for the Chrome family, one for Firefox) in its own folder, and writes one key per
// installed browser whose maker documents its key (shared/browsers.ts WindowsBrowser.hostKey). These are
// Mergelane's own keys, under the current user; the uninstaller removes them.

/** One browser's registration: its key, and the manifest it points at. */
export interface WindowsHostKey {
  key: string
  manifest: string
}

/** Runs reg.exe; a variable for tests. */
export type RegRunner = (args: string[]) => Promise<void>

export const runReg: RegRunner = (args) =>
  new Promise((resolve, reject) => {
    const reg = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
    execFile(reg, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })

/** The keys to write for the installed browsers, each pointing at the manifest of its kind. */
export function windowsHostKeys(
  manifests: { chrome: string; firefox: string },
  browsers: { hostKey: string | null; firefox: boolean }[]
): WindowsHostKey[] {
  return browsers
    .filter((browser): browser is { hostKey: string; firefox: boolean } => browser.hostKey !== null)
    .map((browser) => ({
      key: `HKCU\\${browser.hostKey}\\${NATIVE_HOST}`,
      manifest: browser.firefox ? manifests.firefox : manifests.chrome
    }))
}

/** Writes the two manifests into `folder` and one key per installed browser; returns the keys written. A key
 * that can't be written is skipped. */
export async function registerNativeHostWindows(
  binary: string,
  folder: string,
  browsers: { hostKey: string | null; firefox: boolean }[],
  run: RegRunner = runReg
): Promise<WindowsHostKey[]> {
  if (!browsers.some((browser) => browser.hostKey !== null)) return []
  const dir = join(folder, 'NativeMessagingHosts')
  const manifests = { chrome: join(dir, 'chrome.json'), firefox: join(dir, 'firefox.json') }
  await mkdir(dir, { recursive: true })
  await writeFile(manifests.chrome, hostManifest(binary, false))
  await writeFile(manifests.firefox, hostManifest(binary, true))
  const written: WindowsHostKey[] = []
  for (const entry of windowsHostKeys(manifests, browsers)) {
    try {
      await run(['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', entry.manifest, '/f'])
      written.push(entry)
    } catch (error) {
      console.warn(`[mergelane] couldn't register the browser host in ${entry.key}:`, error)
    }
  }
  return written
}
