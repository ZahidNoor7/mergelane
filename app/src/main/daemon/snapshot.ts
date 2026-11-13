import type {
  SystemMergeLink,
  SystemMergeLinkEvent,
  SystemMergeOutage,
  SystemMergeSnapshot
} from '../../shared/types'
import { isSetAutoResumeParams, isSetStickySitesParams } from '../../../../shared/daemon-api'
import { callDaemon, DaemonError } from './client'

// What the System merge section shows, read from mergelane-daemon. Free of Electron, so the e2e
// suite's Node side can run it against a fake daemon (e2e/daemonApi.spec.ts); daemon.ts supplies
// the context from the running app.

/** What reading the helper needs from the app around it. */
export interface SnapshotContext {
  /** The control socket; absent means the real one. */
  socketPath?: string
  /** Whether the helper is installed in /Library. */
  installed: boolean
  /** This app's version. The bundled helper is built with the same one (-X main.version). */
  appVersion: string
  /** Whether a running helper with another version counts as out of date. Off in a development
   * build, whose helper says 'dev'. */
  compareVersions: boolean
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown, ...codes: DaemonError['code'][]): boolean {
  return error instanceof DaemonError && codes.includes(error.code)
}

function socket(context: SnapshotContext): { socketPath?: string } {
  return context.socketPath ? { socketPath: context.socketPath } : {}
}

/** Whether a helper reporting `helperVersion` is not the one this app bundles. A 'dev' build on
 * either side has no version to compare. */
export function versionMismatch(context: SnapshotContext, helperVersion: string): boolean {
  return (
    context.compareVersions &&
    helperVersion !== 'dev' &&
    context.appVersion !== 'dev' &&
    helperVersion !== context.appVersion
  )
}

/** The event log as outages, oldest first. A link that loses its internet and is then unplugged
 * is one outage; it ends when the link is up again. Links that come back from `unknown` (just
 * probed) are not outages. */
export function outagesFrom(events: readonly SystemMergeLinkEvent[]): SystemMergeOutage[] {
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const open = new Map<string, SystemMergeOutage>()
  const outages: SystemMergeOutage[] = []
  for (const event of ordered) {
    const current = open.get(event.link)
    if (event.to === 'down' || event.to === 'gone') {
      if (current) {
        if (event.to === 'gone') current.kind = 'gone'
        continue
      }
      const outage: SystemMergeOutage = {
        link: event.link,
        kind: event.to,
        at: event.at,
        reason: event.reason
      }
      outages.push(outage)
      open.set(event.link, outage)
    } else if (event.to === 'up' && current) {
      current.backAt = event.at
      open.delete(event.link)
    }
  }
  return outages
}

/** The helper's link-change log; null when it is too old to keep one (UNKNOWN_METHOD). Any other
 * failure leaves the history empty rather than failing the whole snapshot. */
async function readEvents(context: SnapshotContext): Promise<SystemMergeLinkEvent[] | null> {
  try {
    return (await callDaemon('events', undefined, socket(context))).events
  } catch (caught) {
    return hasCode(caught, 'UNKNOWN_METHOD') ? null : []
  }
}

/** The helper's state, each link's merged traffic, its recent link changes, and whether it is the
 * helper this app bundles. `error` is shown as the last failed request. Status comes first: a
 * helper in another protocol is asked nothing else (shared/daemon-api.ts, "Versions and
 * compatibility"). */
export async function readSnapshot(
  context: SnapshotContext,
  error?: string
): Promise<SystemMergeSnapshot> {
  const base = {
    installed: context.installed,
    appVersion: context.appVersion,
    ...(error ? { error } : {})
  }
  try {
    const status = await callDaemon('status', undefined, socket(context))
    const [links, stats, log] = await Promise.all([
      callDaemon('links', undefined, socket(context)),
      callDaemon('stats', undefined, socket(context)),
      readEvents(context)
    ])
    const traffic = new Map(stats.links.map((link) => [link.name, link]))
    // A helper without the setting predates it, like one without the event log.
    const { autoResume, stickySites } = status
    return {
      ...base,
      reachable: true,
      state: status.state,
      ...(status.reason ? { reason: status.reason } : {}),
      helperVersion: status.version,
      helperOutdated:
        log === null ||
        autoResume === undefined ||
        stickySites === undefined ||
        versionMismatch(context, status.version),
      ...(autoResume === undefined ? {} : { autoResume }),
      ...(stickySites === undefined ? {} : { stickySites }),
      links: links.links.map((link): SystemMergeLink => ({
        name: link.name,
        state: link.state,
        rxBps: traffic.get(link.name)?.rxBps ?? 0,
        txBps: traffic.get(link.name)?.txBps ?? 0,
        activeFlows: traffic.get(link.name)?.activeFlows ?? 0
      })),
      events: log ?? [],
      outages: outagesFrom(log ?? [])
    }
  } catch (caught) {
    // A helper that answers in another protocol, or with a status this app can't read, is running
    // but isn't the one this app bundles: installing again replaces it.
    return {
      ...base,
      reachable: false,
      state: 'off',
      links: [],
      helperOutdated: hasCode(caught, 'UNSUPPORTED_VERSION', 'PROTOCOL'),
      events: [],
      outages: [],
      // A helper that isn't installed isn't running either; that's the install prompt, not an
      // error. One that is installed and can't be reached is.
      ...(error ||
      hasCode(caught, 'UNSUPPORTED_VERSION') ||
      (!context.installed && hasCode(caught, 'UNAVAILABLE'))
        ? {}
        : { error: message(caught) })
    }
  }
}

/** Turns system-wide merging on or off. A refusal (another VPN, no usable link) comes back as the
 * snapshot's error, in the daemon's own words. */
export async function switchMerge(
  context: SnapshotContext,
  on: boolean
): Promise<SystemMergeSnapshot> {
  try {
    if (on) await callDaemon('enable', undefined, socket(context))
    else await callDaemon('disable', {}, socket(context))
  } catch (caught) {
    return readSnapshot(context, message(caught))
  }
  return readSnapshot(context)
}

/** Whether merging turns itself back on after the helper crashes (off by default, ADR-0024). A
 * helper too old for the setting is reported as out of date, without the setting. */
export async function switchAutoResume(
  context: SnapshotContext,
  enabled: boolean
): Promise<SystemMergeSnapshot> {
  const params = { enabled }
  // The renderer's word, checked as the daemon checks it (a strict boolean) before it's sent.
  if (!isSetAutoResumeParams(params)) return readSnapshot(context, 'That setting needs on or off.')
  try {
    await callDaemon('setAutoResume', params, socket(context))
  } catch (caught) {
    if (!hasCode(caught, 'UNKNOWN_METHOD')) return readSnapshot(context, message(caught))
    const snapshot = await readSnapshot(
      context,
      "This helper can't turn merging back on by itself. Update it first."
    )
    delete snapshot.autoResume
    return { ...snapshot, helperOutdated: true }
  }
  return readSnapshot(context)
}

/** Whether system merge keeps each site on one network (on by default, ADR-0048). A helper too old
 * for the setting is reported as out of date, without the setting. */
export async function switchStickySites(
  context: SnapshotContext,
  enabled: boolean
): Promise<SystemMergeSnapshot> {
  const params = { enabled }
  if (!isSetStickySitesParams(params)) return readSnapshot(context, 'That setting needs on or off.')
  try {
    await callDaemon('setStickySites', params, socket(context))
  } catch (caught) {
    if (!hasCode(caught, 'UNKNOWN_METHOD')) return readSnapshot(context, message(caught))
    const snapshot = await readSnapshot(
      context,
      "This helper can't keep a site on one network. Update it first."
    )
    delete snapshot.stickySites
    return { ...snapshot, helperOutdated: true }
  }
  return readSnapshot(context)
}

/** Whether merging is on (or turning on) right now; false when the helper can't say. */
export async function mergeIsOn(context: SnapshotContext): Promise<boolean> {
  try {
    const { state } = await callDaemon('status', undefined, socket(context))
    return state === 'on' || state === 'starting'
  } catch {
    return false
  }
}

/** After the helper is installed again (an update): waits up to `waitMs` for the new one to answer,
 * then turns merging back on if it was on before. An update stops the old helper cleanly, so the
 * new one starts off and auto-resume doesn't apply (that is for crashes). A refusal is shown. */
export async function afterInstall(
  context: SnapshotContext,
  wasOn: boolean,
  { waitMs = 10_000, everyMs = 250 }: { waitMs?: number; everyMs?: number } = {}
): Promise<SystemMergeSnapshot> {
  const deadline = Date.now() + waitMs
  let state: string | undefined
  // A new helper first cleans up (ADR-0007), so it gets a little longer to answer than to start.
  const ask = { ...socket(context), timeoutMs: everyMs * 4 }
  while (state === undefined) {
    try {
      state = (await callDaemon('status', undefined, ask)).state
    } catch {
      if (Date.now() >= deadline) return readSnapshot(context)
      await new Promise((resolve) => setTimeout(resolve, everyMs))
    }
  }
  if (!wasOn || state === 'on' || state === 'starting') return readSnapshot(context)
  try {
    await callDaemon('enable', undefined, socket(context))
  } catch (caught) {
    return readSnapshot(
      context,
      `The helper is updated, but system merge didn't turn back on: ${message(caught)}`
    )
  }
  return readSnapshot(context)
}

/** What the speed test needs to know before it goes through system merge (ADR-0064): whether
 * merging is on, why not, whether it keeps each site on one network, and whether any network has a
 * speed limit in it. Null when the helper can't be asked. */
export async function readSpeedTestState(context: SnapshotContext): Promise<{
  on: boolean
  reason?: string
  stickySites?: boolean
  limited: boolean
} | null> {
  try {
    const [status, links] = await Promise.all([
      callDaemon('status', undefined, socket(context)),
      callDaemon('links', undefined, socket(context))
    ])
    return {
      on: status.state === 'on',
      ...(status.reason ? { reason: status.reason } : {}),
      ...(status.stickySites === undefined ? {} : { stickySites: status.stickySites }),
      limited: links.links.some((link) => (link.limitMbps ?? 0) > 0)
    }
  } catch {
    return null
  }
}

/** Each network's traffic now, by its device name, from the helper's counters: system merge's own,
 * and everything on the interface. Null when the helper can't be asked. */
export async function readTraffic(
  context: SnapshotContext
): Promise<Record<
  string,
  { rxBps: number; txBps: number; linkRxBps: number; linkTxBps: number }
> | null> {
  try {
    const stats = await callDaemon('stats', undefined, { ...socket(context), timeoutMs: 2_000 })
    return Object.fromEntries(
      stats.links.map((link) => [
        link.name,
        {
          rxBps: link.rxBps,
          txBps: link.txBps,
          linkRxBps: link.linkRxBps,
          linkTxBps: link.linkTxBps
        }
      ])
    )
  } catch {
    return null
  }
}
