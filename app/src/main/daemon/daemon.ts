import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SystemMergeRemoval, SystemMergeSnapshot } from '../../shared/types'
import { testDaemonInstalled, testKnobs, testRecord } from '../testKnobs'
import { installCommand } from './installCommand'
import { removeHelper, simulatedAdminPrompt } from './removal'
import {
  afterInstall,
  mergeIsOn,
  readSnapshot,
  switchAutoResume,
  switchStickySites,
  switchMerge,
  type SnapshotContext
} from './snapshot'

// System-wide merging is mergelane-daemon's job (CLAUDE.md architecture); the app only shows its
// state, switches it on and off, and installs it with an administrator password: once, and again
// whenever the running helper isn't the one this app bundles (M2.4). It removes it again the same
// way (ADR-0046).

const LABEL = 'io.github.zahidnoor7.mergelane.daemon'
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`

function installed(): boolean {
  const claimed = testDaemonInstalled()
  if (claimed !== undefined) return claimed === '1'
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

/** The helper inside the app bundle, which installs and removes itself. */
function bundledHelper(): string {
  return join(process.resourcesPath, 'mergelane-daemon')
}

/** Runs an AppleScript with osascript(1), whose `-e` gives the script as one line: here, the
 * administrator password prompt (installCommand.ts). A test run (MERGELANE_E2E_ADMIN_PROMPT)
 * records the command it would run and answers the prompt itself; nothing is run. */
async function runAsAdmin(script: string): Promise<void> {
  const argv = ['-e', script]
  if (testKnobs.adminPrompt !== undefined) {
    testRecord('adminCommands', ['/usr/bin/osascript', ...argv])
    return simulatedAdminPrompt(testKnobs.adminPrompt)
  }
  await promisify(execFile)('/usr/bin/osascript', argv)
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

/** Turns "keep each site on one network" on or off. */
export function setSystemMergeStickySites(enabled: boolean): Promise<SystemMergeSnapshot> {
  return switchStickySites(context(), enabled)
}

/** Installs the bundled helper: macOS asks for an administrator password. The same command
 * updates an older helper, since the helper's install boots out the one already running; merging
 * that was on then comes back on once the new helper answers. */
export async function installSystemMerge(): Promise<SystemMergeSnapshot> {
  if (!app.isPackaged) {
    return systemMergeSnapshot('Installing the helper needs the packaged app.')
  }
  const binary = bundledHelper()
  const wasOn = await mergeIsOn(context())
  try {
    await runAsAdmin(installCommand(binary, process.getuid?.() ?? 0))
    return await afterInstall(context(), wasOn)
  } catch (caught) {
    // osascript exits with -128 ("User canceled") when the password prompt is dismissed.
    const canceled = /-128|User canceled/i.test(message(caught))
    return systemMergeSnapshot(
      canceled ? 'Installation was canceled.' : `Couldn't install the helper: ${message(caught)}`
    )
  }
}

/** Turns system merge off, then removes the helper: macOS asks for an administrator password once
 * (removal.ts). Mergelane's own downloads don't use the helper, so they keep working. */
export async function removeSystemMerge(): Promise<SystemMergeRemoval> {
  // A development build has no bundled helper to run; a test run answers the prompt itself.
  if (!app.isPackaged && testKnobs.adminPrompt === undefined) {
    return {
      outcome: 'failed',
      message: 'Removing the helper needs the packaged app.',
      snapshot: await systemMergeSnapshot()
    }
  }
  return removeHelper(context, bundledHelper(), runAsAdmin)
}
