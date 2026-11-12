// Open at login, per platform (ADR-0037; Windows in W1). Electron registers the app with macOS's SMAppService, or
// on Windows in the user's Run key (app.setLoginItemSettings, @platform darwin,win32 in Electron's types). These
// rules turn what Electron reports into what Settings shows; main/loginItem.ts calls Electron.

import type { LoginItemState, LoginItemStatus } from './types'

/** On Windows the login entry starts Mergelane with this argument, which is how it knows it was opened at login:
 * Electron's wasOpenedAtLogin is macOS only. */
export const OPENED_AT_LOGIN_ARG = '--opened-at-login'

const MAC_STATUSES: LoginItemStatus[] = [
  'enabled',
  'requires-approval',
  'not-registered',
  'not-found'
]

/** The parts of Electron's LoginItemSettings these rules read. */
export interface LoginItemReport {
  openAtLogin: boolean
  /** macOS only. */
  status?: string
  /** macOS only. */
  wasOpenedAtLogin?: boolean
}

/** Whether this build can open at login: only a packaged app on macOS or Windows. */
export function loginItemAvailable(platform: string, packaged: boolean): boolean {
  return packaged && (platform === 'darwin' || platform === 'win32')
}

/** What Settings shows, from what Electron reports. */
export function loginItemStateFrom(platform: string, report: LoginItemReport): LoginItemState {
  if (platform === 'win32') {
    // Windows has no approval step: the Run key either holds Mergelane or it doesn't.
    return { on: report.openAtLogin, status: report.openAtLogin ? 'enabled' : 'not-registered' }
  }
  return {
    on: report.openAtLogin,
    status: MAC_STATUSES.includes(report.status as LoginItemStatus)
      ? (report.status as LoginItemStatus)
      : 'not-registered'
  }
}

/** Whether this launch came from the login item. */
export function openedAtLoginFrom(
  platform: string,
  packaged: boolean,
  report: () => LoginItemReport,
  argv: readonly string[]
): boolean {
  if (!loginItemAvailable(platform, packaged)) return false
  if (platform === 'win32') return argv.includes(OPENED_AT_LOGIN_ARG)
  return report().wasOpenedAtLogin === true
}
