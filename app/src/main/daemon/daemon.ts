import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SystemMergeLink, SystemMergeSnapshot } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import { callDaemon, DaemonError } from './client'
import { installCommand } from './installCommand'

// System-wide merging is mergelane-daemon's job (CLAUDE.md architecture); the app only shows its
// state, switches it on and off, and installs it once with an administrator password.

const LABEL = 'io.github.zahidnoor7.mergelane.daemon'
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`

const options = (): { socketPath?: string } =>
  testKnobs.daemonSocket ? { socketPath: testKnobs.daemonSocket } : {}

function installed(): boolean {
  if (testKnobs.daemonInstalled !== undefined) return testKnobs.daemonInstalled === '1'
  return existsSync(PLIST)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the networks menu shows: the helper's state, and each link's merged traffic. */
export async function systemMergeSnapshot(error?: string): Promise<SystemMergeSnapshot> {
  const base = { installed: installed(), ...(error ? { error } : {}) }
  try {
    const [status, links, stats] = await Promise.all([
      callDaemon('status', undefined, options()),
      callDaemon('links', undefined, options()),
      callDaemon('stats', undefined, options())
    ])
    const traffic = new Map(stats.links.map((link) => [link.name, link]))
    return {
      ...base,
      reachable: true,
      state: status.state,
      ...(status.reason ? { reason: status.reason } : {}),
      links: links.links.map((link): SystemMergeLink => ({
        name: link.name,
        state: link.state,
        rxBps: traffic.get(link.name)?.rxBps ?? 0,
        txBps: traffic.get(link.name)?.txBps ?? 0,
        activeFlows: traffic.get(link.name)?.activeFlows ?? 0
      }))
    }
  } catch (caught) {
    return {
      ...base,
      reachable: false,
      state: 'off',
      links: [],
      ...(error ? {} : { error: message(caught) })
    }
  }
}

/** Turns system-wide merging on or off. A refusal (another VPN, no usable link) comes back as the
 * snapshot's error, in the daemon's own words. */
export async function setSystemMerge(on: boolean): Promise<SystemMergeSnapshot> {
  try {
    if (on) await callDaemon('enable', undefined, options())
    else await callDaemon('disable', {}, options())
    return await systemMergeSnapshot()
  } catch (caught) {
    return systemMergeSnapshot(caught instanceof DaemonError ? caught.message : message(caught))
  }
}

/** Installs the helper once: macOS asks for an administrator password. */
export async function installSystemMerge(): Promise<SystemMergeSnapshot> {
  if (!app.isPackaged) {
    return systemMergeSnapshot('Installing the helper needs the packaged app.')
  }
  const binary = join(process.resourcesPath, 'mergelane-daemon')
  try {
    await promisify(execFile)('/usr/bin/osascript', [
      '-e',
      installCommand(binary, process.getuid?.() ?? 0)
    ])
    return await systemMergeSnapshot()
  } catch (caught) {
    // osascript exits with -128 ("User canceled") when the password prompt is dismissed.
    const canceled = /-128|User canceled/i.test(message(caught))
    return systemMergeSnapshot(
      canceled ? 'Installation was canceled.' : `Couldn't install the helper: ${message(caught)}`
    )
  }
}
