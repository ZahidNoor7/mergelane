import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app, shell } from 'electron'
import {
  BROWSERS,
  EXTENSION_FOLDER_NAME,
  notYetOn,
  windowsCandidates,
  type BrowserSpec,
  type BrowserId,
  type BrowsersReport,
  type BrowserState,
  type ExtensionKind,
  type ExtensionSaved
} from '../shared/browsers'
import type { AppSettings } from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { testKnobs, testRecord } from './testKnobs'

// Settings › Browser extensions (M3.4a, docs/DECISIONS.md ADR-0038 and ADR-0047): which browsers are
// on this Mac, and the Mergelane extension saved where the user can find it — Downloads unless they
// choose another folder — for them to load by hand ("Load unpacked", or Firefox's temporary add-on).
// It is saved when they install, never just by opening Settings. Every copy Mergelane saved is
// refreshed when Mergelane's version changes, so loading it once keeps working across app updates.

/** Where apps are installed: /Applications and the user's own. A test run uses its own folders. */
function applicationFolders(): string[] {
  if (testKnobs.applicationFolders) return testKnobs.applicationFolders
  return ['/Applications', join(homedir(), 'Applications')]
}

/** Where a browser is installed: its app bundle on macOS, its executable on Windows (W2); null when
 * it isn't. */
function browserLocation(spec: BrowserSpec): string | null {
  const candidates =
    process.platform === 'win32' && !testKnobs.applicationFolders
      ? windowsCandidates(spec, process.env)
      : applicationFolders().map((folder) => join(folder, spec.app))
  return candidates.find((path) => existsSync(path)) ?? null
}

/** The extension build Mergelane ships: inside the app when packaged, the build folder otherwise. */
function bundledExtension(kind: ExtensionKind): string {
  if (app.isPackaged) return join(process.resourcesPath, 'browser-extension', kind)
  return join(testKnobs.extensionBuild ?? join(app.getAppPath(), 'extension', 'dist'), kind)
}

/** Where the extension is saved unless the user chose a folder: Downloads. A test run uses a
 * folder of its own, so it never writes to the computer's Downloads (not "Downloads": the download
 * engine's own "downloads" folder is there, and macOS folder names ignore case). */
function defaultLocation(): string {
  if (testKnobs.userDataDir) return join(testKnobs.userDataDir, 'Test Downloads')
  return app.getPath('downloads')
}

function locationOf(settings: AppSettings): string {
  return settings.extensionLocation ?? defaultLocation()
}

/** The folder the user loads for `kind`, in `location`. */
function folderIn(location: string, kind: ExtensionKind): string {
  return join(location, EXTENSION_FOLDER_NAME[kind])
}

/** Where Mergelane kept the extension before ADR-0047; still refreshed for anyone who loaded it. */
function earlierFolder(kind: ExtensionKind): string {
  return join(app.getPath('userData'), 'Browser Extension', kind)
}

const STAMP = '.mergelane-version'

/** A folder of that name is there already, and Mergelane didn't make it. */
class FolderTaken extends Error {}

async function stampOf(folder: string): Promise<string | null> {
  return readFile(join(folder, STAMP), 'utf8').catch(() => null)
}

/** Copies the extension for `kind` into `target` when it is missing or from another version of the
 * app. Never touches a folder Mergelane didn't make. Returns false when there is no build to copy. */
async function copyExtension(kind: ExtensionKind, target: string): Promise<boolean> {
  const source = bundledExtension(kind)
  if (!existsSync(join(source, 'manifest.json'))) return false
  const version = app.getVersion()
  const stamped = await stampOf(target)
  if (stamped === version && existsSync(join(target, 'manifest.json'))) return true
  if (stamped === null && existsSync(target)) {
    const inside = await readdir(target).catch(() => null)
    if (inside === null || inside.length > 0) throw new FolderTaken()
  }
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  await writeFile(join(target, STAMP), version)
  return true
}

/** Brings every copy Mergelane saved up to this version, leaving any the user deleted. */
export async function refreshExtensionCopies(): Promise<void> {
  const settings = await loadSettings()
  const copies = [
    ...(settings.extensionCopies ?? []),
    ...(['chrome', 'firefox'] as const).map((kind) => ({ kind, path: earlierFolder(kind) }))
  ]
  for (const { kind, path } of copies) {
    if ((await stampOf(path)) === null) continue
    await copyExtension(kind, path).catch((error) =>
      console.error(`[mergelane] couldn't update the extension in ${path}`, error)
    )
  }
}

/** Looks for every known browser, and where the extension for each is (or will be) saved. */
export async function scanBrowsers(): Promise<BrowsersReport> {
  await refreshExtensionCopies()
  const settings = await loadSettings()
  const contacts = settings.browserContacts ?? {}
  const location = locationOf(settings)
  const browsers: BrowserState[] = BROWSERS.map((spec) => {
    const appPath = browserLocation(spec)
    const built =
      spec.kind !== null && existsSync(join(bundledExtension(spec.kind), 'manifest.json'))
    return {
      ...spec,
      notYet: notYetOn(spec, process.platform),
      found: appPath !== null,
      appPath,
      extensionFolder: built && spec.kind ? folderIn(location, spec.kind) : null,
      contact: contacts[spec.id] ?? null
    }
  })
  const shipped = await readFile(join(bundledExtension('chrome'), 'manifest.json'), 'utf8')
    .then((text) => String(JSON.parse(text).version))
    .catch(() => null)
  return {
    browsers,
    extensionConnected: settings.browserExtensionUsed === true,
    extensionVersion: shipped,
    scannedAt: Date.now(),
    extensionLocation: location
  }
}

/** Saves the extension a browser loads in the chosen folder, and remembers it to keep it updated. */
export async function saveExtension(id: BrowserId): Promise<ExtensionSaved> {
  const kind = BROWSERS.find((each) => each.id === id)?.kind
  if (!kind) return { ok: false, message: 'Mergelane has no extension for this browser yet.' }
  const settings = await loadSettings()
  const location = locationOf(settings)
  const folder = folderIn(location, kind)
  try {
    if (!(await copyExtension(kind, folder))) {
      return { ok: false, message: 'The extension isn’t in this copy of Mergelane.' }
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof FolderTaken
          ? `“${basename(location)}” already has a folder named “${EXTENSION_FOLDER_NAME[kind]}” that Mergelane didn’t make. Move it, or choose another folder for the extension.`
          : `Mergelane couldn’t save the extension in “${basename(location)}”: ${(error as Error).message}`
    }
  }
  const copies = settings.extensionCopies ?? []
  if (!copies.some((copy) => copy.path === folder)) {
    await saveSettings({ extensionCopies: [...copies, { kind, path: folder }] })
  }
  return { ok: true, folder }
}

/** Saves the extension, then shows its folder in the Finder, selected. */
export async function revealExtension(id: BrowserId): Promise<ExtensionSaved> {
  const saved = await saveExtension(id)
  if (!saved.ok) return saved
  // A test run never opens a Finder window: it notes what it would show.
  if (testKnobs.userDataDir) testRecord('revealed', saved.folder)
  else shell.showItemInFolder(saved.folder)
  return saved
}

/** Makes `location` the folder the extension is saved in. */
export async function setExtensionLocation(location: string): Promise<void> {
  await saveSettings({ extensionLocation: location })
}

/** The folder the extension is saved in now. */
export async function extensionLocation(): Promise<string> {
  return locationOf(await loadSettings())
}

/** Opens a browser, as double-clicking it in the Finder (`open`, man open(1)) or File Explorer would. */
export async function openBrowser(id: BrowserId): Promise<void> {
  const spec = BROWSERS.find((each) => each.id === id)
  const appPath = spec ? browserLocation(spec) : null
  if (!appPath) return
  // A test run never opens a browser: it notes which it would open.
  if (testKnobs.userDataDir) return testRecord('openedBrowser', appPath)
  if (process.platform === 'win32') {
    const problem = await shell.openPath(appPath)
    if (problem) console.error(`[mergelane] couldn't open ${appPath}: ${problem}`)
    return
  }
  await new Promise<void>((resolve) => {
    execFile('open', [appPath], (error) => {
      if (error) console.error(`[mergelane] couldn't open ${appPath}`, error)
      resolve()
    })
  })
}

/** The installed Windows browsers' native messaging keys, for nativeHost.ts (W2). */
export function installedWindowsHosts(): { hostKey: string | null; firefox: boolean }[] {
  return BROWSERS.filter((spec) => spec.windows && browserLocation(spec) !== null).map((spec) => ({
    hostKey: spec.windows?.hostKey ?? null,
    firefox: spec.kind === 'firefox'
  }))
}
