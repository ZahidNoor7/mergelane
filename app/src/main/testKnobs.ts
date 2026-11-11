import { app } from 'electron'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from '../shared/types'

// Overrides for the end-to-end suite (e2e/), read from the environment. A packaged build ignores
// all of them, so a shipped app can't be steered through its environment variables.
const env: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env

function positiveNumber(name: string, fallback: number): number {
  const value = Number(env[name])
  return value > 0 ? value : fallback
}

export const testKnobs = {
  userDataDir: env['MERGELANE_USER_DATA'],
  /** The browser bridge's socket, instead of the one in userData (macOS caps socket paths at 104
   * bytes, and a test's userData path is longer). */
  browserSocket: env['MERGELANE_E2E_BROWSER_SOCKET'],
  /** Where to find mergelane-nmhost, and the home folder whose browser profiles get its manifest,
   * so a development build and the tests can register the host (nativeHost.ts). */
  nativeHostBinary: env['MERGELANE_E2E_NMHOST_BINARY'],
  nativeHostHome: env['MERGELANE_E2E_NMHOST_HOME'],
  /** A fake mergelane-daemon's socket, instead of the real one (e2e/systemMerge.spec.ts). */
  daemonSocket: env['MERGELANE_E2E_DAEMON_SOCKET'],
  /** The helper's log a diagnostics bundle reads, instead of /Library/Logs/Mergelane/daemon.log. */
  helperLog: env['MERGELANE_E2E_HELPER_LOG'],
  /** How a test run's administrator password prompt is answered, instead of showing it: the
   * osascript command is recorded (testRecord 'adminCommands') and never run. 'allow', 'cancel' or
   * 'fail:<reason>' (main/daemon/removal.ts simulatedAdminPrompt). Unset: the real prompt. */
  adminPrompt: env['MERGELANE_E2E_ADMIN_PROMPT'],
  /** The app version to compare with the helper's, so a development build (whose helper says
   * 'dev') can test the out-of-date banner (daemon.ts). Unset: no comparison. */
  appVersion: env['MERGELANE_E2E_APP_VERSION'],
  /** Keeps the window off-screen so a test run doesn't pop windows up over the desktop. */
  hideWindow: env['MERGELANE_E2E_HIDE_WINDOW'] === '1',
  blockBytes: positiveNumber('MERGELANE_E2E_BLOCK_BYTES', 8 * 1024 * 1024),
  retryBaseDelayMs: positiveNumber('MERGELANE_E2E_RETRY_BASE_MS', 1000),
  stallTimeoutMs: positiveNumber('MERGELANE_E2E_STALL_MS', 20_000),
  connectTimeoutMs: positiveNumber('MERGELANE_E2E_CONNECT_MS', 10_000),
  /** How long a server that keeps answering busy (429, 503, …) is waited out; see
   * downloadManager.ts. */
  serverBusyForMs: positiveNumber('MERGELANE_E2E_SERVER_BUSY_MS', 5 * 60_000),
  slowWarmupMs: positiveNumber('MERGELANE_E2E_SLOW_WARMUP_MS', 5_000),
  slowForMs: positiveNumber('MERGELANE_E2E_SLOW_FOR_MS', 10_000),
  silentAfterMs: positiveNumber('MERGELANE_E2E_SILENT_MS', 5_000),
  hedgeAfterMs: positiveNumber('MERGELANE_E2E_HEDGE_MS', 2_000),
  /** How long a magnet link may take to find peers that send its metadata. */
  magnetTimeoutMs: positiveNumber('MERGELANE_E2E_MAGNET_MS', 3 * 60_000),
  /** How long a magnet link only the DHT can help keeps looking once its first search finds no
   * one (Deluge's magnet prefetch also waits 30 s). */
  magnetGraceMs: positiveNumber('MERGELANE_E2E_MAGNET_GRACE_MS', 30_000),
  /** Where the update check reads releases from instead of GitHub (e2e/updates.spec.ts). Without
   * it, a test run never checks for updates on its own. */
  releasesUrl: env['MERGELANE_E2E_RELEASES_URL'],
  /** The version the update check compares releases with, instead of the app's. */
  updateAppVersion: env['MERGELANE_E2E_UPDATE_VERSION'],
  /** A file an update's disk image path is written to instead of opening it and quitting, so a
   * test run never opens anything on the Mac (e2e/updates.spec.ts). */
  updateOpenLog: env['MERGELANE_E2E_UPDATE_OPEN_LOG'],
  /** The folders a test run looks for browsers in, instead of /Applications and ~/Applications
   * (colon-separated). */
  applicationFolders: env['MERGELANE_E2E_APPLICATIONS']?.split(':').filter(Boolean),
  /** An extension build folder (extension/build.mjs <dir>) to hand out, instead of the project's,
   * which another test may be rebuilding. */
  extensionBuild: env['MERGELANE_E2E_EXTENSION_BUILD'],
  /** The login item status a test run pretends macOS reports ('enabled', 'requires-approval' or
   * 'not-registered'); unset, a test or development build has no login item to offer. */
  loginItemStatus: env['MERGELANE_E2E_LOGIN_ITEM'],
  /** How long after launch the daily update check first looks whether a check is due. */
  updateFirstCheckMs: positiveNumber('MERGELANE_E2E_UPDATE_FIRST_CHECK_MS', 10_000),
  /** Tests turn the DHT off, so a run never reaches out to the internet's DHT nodes. */
  torrentDht: env['MERGELANE_E2E_DHT'] !== '0',
  /** `MERGELANE_E2E_DHT_BOOTSTRAP=127.0.0.1:9` starts the DHT from these nodes instead of the
   * internet's, so a test can have a DHT that reaches no one. */
  torrentDhtBootstrap: env['MERGELANE_E2E_DHT_BOOTSTRAP']?.split(',').filter(Boolean)
}

/** What a test run would have shown on the Mac (a notification, the menu bar's title) or
 * registered with it (a login item), kept on the main process's global for the test to read with
 * evaluateMain: `globalThis.__mergelaneTest`. */
export function testRecord(kind: string, value: unknown, replace = false): void {
  const store = ((globalThis as Record<string, unknown>).__mergelaneTest ??= {}) as Record<
    string,
    unknown
  >
  if (replace) store[kind] = value
  else ((store[kind] ??= []) as unknown[]).push(value)
}

/** `MERGELANE_E2E_DAEMON_INSTALLED`: whether the helper counts as installed, '1' or '0'; unset
 * (and in a packaged build) /Library is checked. Read on every call rather than once, so a test can
 * have the helper disappear after "Remove helper" by rewriting process.env in the main process. */
export function testDaemonInstalled(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env['MERGELANE_E2E_DAEMON_INSTALLED']
}

/** `MERGELANE_E2E_STREAMS=2` fixes how many streams each network runs and turns the automatic
 * sizing off, so a test can count requests. Read on every call rather than once, so a test can
 * change it between downloads. */
export function testStreamsPerNetwork(): number | null {
  if (app.isPackaged) return null
  const value = Number(process.env['MERGELANE_E2E_STREAMS'])
  return value > 0 ? value : null
}

/** `MERGELANE_E2E_INTERFACES=a=127.0.0.1,b=192.168.1.5` replaces the real interface list. Read on
 * every call rather than once, so a test can make a network "disappear" mid-download by
 * rewriting process.env in the main process. */
export function testInterfaces(): NetworkInterfaceInfo[] | null {
  if (app.isPackaged) return null
  const raw = process.env['MERGELANE_E2E_INTERFACES']
  if (raw === undefined) return null
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, address, subnet, kind] = entry.split('=')
      const inferredKind =
        kind === 'usb'
          ? ('usb' as const)
          : kind === 'wifi' ||
              id.toLowerCase().includes('wi-fi') ||
              id.toLowerCase().includes('wifi')
            ? ('wifi' as const)
            : ('ethernet' as const)
      return {
        id,
        device: id,
        displayName: id,
        addresses: [{ address, family: isIP(address) === 6 ? 6 : 4, subnet: subnet || undefined }],
        kind: inferredKind
      }
    })
}
