import { existsSync } from 'node:fs'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import {
  BROWSERS,
  type BrowserId,
  type BrowsersReport,
  type BrowserState,
  type ExtensionKind
} from '../shared/browsers'
import { loadSettings } from './settings'
import { testKnobs, testRecord } from './testKnobs'

// Settings › Browser extensions (M3.4a, docs/DECISIONS.md ADR-0038): which browsers are on this Mac,
// and a copy of the Mergelane extension for each kind, in Mergelane's own folder, for the user to
// load by hand ("Load unpacked", or Firefox's temporary add-on). The copy is refreshed when
// Mergelane's version changes, so loading it once keeps working across app updates.

/** Where apps are installed: /Applications and the user's own. A test run uses its own folders. */
function applicationFolders(): string[] {
  if (testKnobs.applicationFolders) return testKnobs.applicationFolders
  return ['/Applications', join(homedir(), 'Applications')]
}

/** The extension build Mergelane ships: inside the app when packaged, the build folder otherwise. */
function bundledExtension(kind: ExtensionKind): string {
  if (app.isPackaged) return join(process.resourcesPath, 'browser-extension', kind)
  return join(testKnobs.extensionBuild ?? join(app.getAppPath(), 'extension', 'dist'), kind)
}

/** The folder the user loads in the browser. */
export function extensionFolder(kind: ExtensionKind): string {
  return join(app.getPath('userData'), 'Browser Extension', kind)
}

const STAMP = '.mergelane-version'

/** Copies the extension for `kind` into Mergelane's folder when it is missing or from another
 * version of the app; returns the folder, or null when there is no build to copy. */
async function prepareExtension(kind: ExtensionKind): Promise<string | null> {
  const source = bundledExtension(kind)
  if (!existsSync(join(source, 'manifest.json'))) return null
  const target = extensionFolder(kind)
  const version = app.getVersion()
  const stamped = await readFile(join(target, STAMP), 'utf8').catch(() => null)
  if (stamped !== version || !existsSync(join(target, 'manifest.json'))) {
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true })
    await writeFile(join(target, STAMP), version)
  }
  return target
}

/** Looks for every known browser, and readies the extension for those Mergelane supports. */
export async function scanBrowsers(): Promise<BrowsersReport> {
  const folders = applicationFolders()
  const settings = await loadSettings()
  const contacts = settings.browserContacts ?? {}
  const prepared = new Map<ExtensionKind, string | null>()
  const browsers: BrowserState[] = []
  for (const spec of BROWSERS) {
    const found = folders.some((folder) => existsSync(join(folder, spec.app)))
    let folder: string | null = null
    if (found && spec.kind) {
      if (!prepared.has(spec.kind)) {
        prepared.set(
          spec.kind,
          await prepareExtension(spec.kind).catch((error) => {
            console.error(`[mergelane] couldn't ready the ${spec.kind} extension`, error)
            return null
          })
        )
      }
      folder = prepared.get(spec.kind) ?? null
    }
    browsers.push({ ...spec, found, extensionFolder: folder, contact: contacts[spec.id] ?? null })
  }
  const shipped = await readFile(join(bundledExtension('chrome'), 'manifest.json'), 'utf8')
    .then((text) => String(JSON.parse(text).version))
    .catch(() => null)
  return {
    browsers,
    extensionConnected: settings.browserExtensionUsed === true,
    extensionVersion: shipped,
    scannedAt: Date.now()
  }
}

/** Shows the extension folder for a browser in the Finder (its manifest.json selected). */
export async function revealExtension(id: BrowserId): Promise<void> {
  const spec = BROWSERS.find((each) => each.id === id)
  if (!spec?.kind) return
  const folder = await prepareExtension(spec.kind)
  if (!folder) return
  const manifest = join(folder, 'manifest.json')
  // A test run never opens a Finder window: it notes what it would show.
  if (testKnobs.userDataDir) return testRecord('revealed', manifest)
  shell.showItemInFolder(manifest)
}
