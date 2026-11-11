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
