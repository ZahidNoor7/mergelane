import { app } from 'electron'
import {
  OPENED_AT_LOGIN_ARG,
  loginItemAvailable,
  loginItemStateFrom,
  openedAtLoginFrom
} from '../shared/loginItem'
import type { LoginItemState } from '../shared/types'
import { testKnobs, testRecord } from './testKnobs'

// Settings › General › "Open at login" (docs/DECISIONS.md ADR-0037). Electron registers the app
// itself: with macOS's SMAppService (type mainAppService, the default), whose docs warn this "may
// silently fail" for an app that isn't notarized, so Settings shows the status macOS reports rather
// than assuming; on Windows in the user's Run key, with an argument that tells a login launch apart
// (shared/loginItem.ts). Only a packaged app registers: a development or test build never adds
// itself to the computer's login items.

/** On Windows, Electron finds and writes the entry by the executable and these arguments. */
const WINDOWS_ENTRY = { args: [OPENED_AT_LOGIN_ARG] }

let testOn = false

/** Whether the app opens at login, and what the system says about it. */
export function loginItemState(): LoginItemState {
  const pretend = testKnobs.loginItemStatus
  if (pretend !== undefined) {
    return { on: testOn, status: testOn ? (pretend as LoginItemState['status']) : 'not-registered' }
  }
  if (!loginItemAvailable(process.platform, app.isPackaged))
    return { on: false, status: 'unavailable' }
  const options = process.platform === 'win32' ? WINDOWS_ENTRY : undefined
  return loginItemStateFrom(process.platform, app.getLoginItemSettings(options))
}

/** Turns Open at login on or off, and reports what the system made of it. */
export function setOpenAtLogin(on: boolean): LoginItemState {
  if (testKnobs.loginItemStatus !== undefined) {
    testOn = on
    testRecord('loginItem', on)
    return loginItemState()
  }
  if (loginItemState().status === 'unavailable') return loginItemState()
  app.setLoginItemSettings(
    process.platform === 'win32' ? { openAtLogin: on, ...WINDOWS_ENTRY } : { openAtLogin: on }
  )
  return loginItemState()
}

/** Whether the system opened Mergelane at login, so it starts in the menu bar (macOS) or the
 * notification area (Windows) without its window. */
export function openedAtLogin(): boolean {
  return openedAtLoginFrom(
    process.platform,
    app.isPackaged,
    () => app.getLoginItemSettings(),
    process.argv
  )
}
