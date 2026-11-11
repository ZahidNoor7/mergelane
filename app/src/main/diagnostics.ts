import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { cpus, homedir, machine, release, totalmem, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import {
  buildDiagnostics,
  diagnosticsFileName,
  diagnosticsReadme,
  redactLog,
  type DiagnosticsInput,
  type RedactionContext
} from '../shared/diagnostics'
import type { NetworkActivity } from '../shared/networkActivity'
import type { DownloadUpdate } from '../shared/types'
import { systemMergeSnapshot } from './daemon/daemon'
import { listHistory } from './download/history'
import { loadUsenetServer, viewOf } from './download/nzb/usenetServer'
import { listActiveInterfaces } from './network/interfaces'
import { loadSettings } from './settings'
import { testKnobs } from './testKnobs'

// The diagnostics bundle (M3.7, docs/DECISIONS.md ADR-0042): on request only, from Settings › General
// or the app menu's "Save Diagnostics…". The user picks where it goes; Mergelane never sends it
// anywhere. What goes in, and what is redacted, is decided in shared/diagnostics.ts.

/** The parts only the running app knows (registerIpcHandlers sets them). */
interface Sources {
  downloads: () => Promise<DownloadUpdate[]>
  activity: () => Promise<NetworkActivity>
}

let sources: Sources | null = null
/** The last bundle saved, for "Show in Finder". */
let lastSaved: string | null = null

export function registerDiagnostics(given: Sources): void {
  sources = given
}

const HELPER_LOG = '/Library/Logs/Mergelane/daemon.log'
/** The most of the helper's log read: its end, which holds the newest lines. */
const LOG_TAIL_BYTES = 64 * 1024

/** The end of the helper's log, or null when there is none or it can't be read. Read only. */
async function helperLogTail(): Promise<string | null> {
  const handle = await open(testKnobs.helperLog ?? HELPER_LOG, 'r').catch(() => null)
  if (!handle) return null
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf-8')
    // A tail cut mid-line starts at the next whole one.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

function redactionContext(): RedactionContext {
  let userName: string | undefined
  try {
    userName = userInfo().username
  } catch {
    // No account name to look for: the home folder is still replaced.
  }
  return { home: homedir(), ...(userName ? { userName } : {}) }
}

/** Everything the bundle is made from, each part on its own so one that fails leaves the rest. */
async function gather(now: number): Promise<DiagnosticsInput> {
  const processors = cpus()
  const [helper, networks, activity, settings, usenet, downloads, history] = await Promise.all([
    systemMergeSnapshot().catch(() => null),
    listActiveInterfaces().catch(() => []),
    sources?.activity().catch(() => ({ events: [] })) ?? { events: [] },
    loadSettings().catch(() => ({})),
    loadUsenetServer()
      .then((server) => (server ? viewOf(server) : null))
      .catch(() => null),
    sources?.downloads().catch(() => []) ?? [],
    listHistory().catch(() => [])
  ])
  return {
    generatedAt: now,
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      translated: app.runningUnderARM64Translation
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      machine: machine(),
      macOS: process.getSystemVersion(),
      darwin: release(),
      cpu: processors[0]?.model ?? 'unknown',
      cpuCount: processors.length,
      memoryBytes: totalmem()
    },
    helper,
    networks,
    activity,
    settings,
    usenet,
    downloads: downloads.map((update) => update.state),
    history
  }
}

/** Builds the bundle and writes it to `target` as a zip: a folder of files is zipped by macOS's
 * own ditto in a temporary folder, then copied into place, so a failure leaves nothing half
 * written where the user asked for it. */
export async function writeDiagnostics(target: string, now = Date.now()): Promise<void> {
  const context = redactionContext()
  const [input, log] = await Promise.all([gather(now), helperLogTail()])
  const report = buildDiagnostics(input, context)
  const work = await mkdtemp(join(app.getPath('temp'), 'mergelane-diagnostics-'))
  try {
    const folder = join(work, diagnosticsFileName(now).replace(/\.zip$/, ''))
    await mkdir(folder)
    await writeFile(join(folder, 'README.txt'), diagnosticsReadme(now, log !== null))
    await writeFile(join(folder, 'diagnostics.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (log !== null)
      await writeFile(join(folder, 'helper-log.txt'), `${redactLog(log, context)}\n`)
    const zip = join(work, 'bundle.zip')
    // -c -k: a PKZip archive; --norsrc: no resource forks or extended attributes; --keepParent:
    // the folder itself at the archive's root (man ditto).
    await promisify(execFile)('/usr/bin/ditto', [
      '-c',
      '-k',
      '--norsrc',
      '--keepParent',
      folder,
      zip
    ])
    await copyFile(zip, target)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Asks where to save one, then saves it. Null when the user cancels. */
export async function saveDiagnostics(window: BrowserWindow | null): Promise<string | null> {
  const now = Date.now()
  const options: Electron.SaveDialogOptions = {
    title: 'Save Diagnostics',
    defaultPath: join(app.getPath('downloads'), diagnosticsFileName(now)),
    buttonLabel: 'Save',
    message: 'Mergelane never sends this anywhere. Attach it to a GitHub issue yourself.',
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  const target = /\.zip$/i.test(result.filePath) ? result.filePath : `${result.filePath}.zip`
  try {
    await writeDiagnostics(target, now)
  } catch (error) {
    console.error('[mergelane] failed to save diagnostics', error)
    // No system error codes in the words: the renderer's describeError reads them as a download's.
    throw new Error('The diagnostics couldn’t be saved there. Choose another folder.')
  }
  lastSaved = target
  return target
}

/** The last bundle saved, in the Finder. */
export function revealDiagnostics(): void {
  if (lastSaved) shell.showItemInFolder(lastSaved)
}
