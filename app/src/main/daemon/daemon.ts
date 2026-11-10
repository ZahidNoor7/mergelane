import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SystemMergeSnapshot } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import { installCommand } from './installCommand'
import {
  afterInstall,
  mergeIsOn,
  readSnapshot,
  switchAutoResume,
  switchMerge,
  type SnapshotContext
} from './snapshot'

// System-wide merging is mergelane-daemon's job (CLAUDE.md architecture); the app only shows its
// state, switches it on and off, and installs it with an administrator password: once, and again
// whenever the running helper isn't the one this app bundles (M2.4).

const LABEL = 'io.github.zahidnoor7.mergelane.daemon'
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`

function installed(): boolean {
  if (testKnobs.daemonInstalled !== undefined) return testKnobs.daemonInstalled === '1'
  return existsSync(PLIST)
}

/** The bundled helper is built with the app's version, so a packaged app expects the running
 * helper to report the same. A development build's helper says 'dev' and the app's version is
 * package.json's, so there is nothing to compare there, unless a test claims a version with
 * MERGELANE_E2E_APP_VERSION (ignored by a packaged build, like every test knob). */
function versionCheck(): Pick<SnapshotContext, 'appVersion' | 'compareVersions'> {
  if (app.isPackaged) return { appVersion: app.getVersion(), compareVersions: true }
  const claimed = testKnobs.appVersion
  return claimed
    ? { appVersion: claimed, compareVersions: true }
    : { appVersion: app.getVersion(), compareVersions: false }
}

function context(): SnapshotContext {
  return {
    ...(testKnobs.daemonSocket ? { socketPath: testKnobs.daemonSocket } : {}),
    installed: installed(),
    ...versionCheck()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the networks menu shows: the helper's state, each link's merged traffic, its recent link
 * changes, and whether it needs updating. */
export function systemMergeSnapshot(error?: string): Promise<SystemMergeSnapshot> {
  return readSnapshot(context(), error)
}

/** Turns system-wide merging on or off. */
export function setSystemMerge(on: boolean): Promise<SystemMergeSnapshot> {
  return switchMerge(context(), on)
}

/** Turns "back on after a crash" on or off. */
export function setSystemMergeAutoResume(enabled: boolean): Promise<SystemMergeSnapshot> {
  return switchAutoResume(context(), enabled)
}

/** Installs the bundled helper: macOS asks for an administrator password. The same command
 * updates an older helper, since the helper's install boots out the one already running; merging
 * that was on then comes back on once the new helper answers. */
export async function installSystemMerge(): Promise<SystemMergeSnapshot> {
  if (!app.isPackaged) {
    return systemMergeSnapshot('Installing the helper needs the packaged app.')
  }
  const binary = join(process.resourcesPath, 'mergelane-daemon')
  const wasOn = await mergeIsOn(context())
  try {
    await promisify(execFile)('/usr/bin/osascript', [
      '-e',
      installCommand(binary, process.getuid?.() ?? 0)
    ])
    return await afterInstall(context(), wasOn)
  } catch (caught) {
    // osascript exits with -128 ("User canceled") when the password prompt is dismissed.
    const canceled = /-128|User canceled/i.test(message(caught))
    return systemMergeSnapshot(
      canceled ? 'Installation was canceled.' : `Couldn't install the helper: ${message(caught)}`
    )
  }
}
