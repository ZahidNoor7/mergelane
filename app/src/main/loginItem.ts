import { app } from 'electron'
import type { LoginItemState, LoginItemStatus } from '../shared/types'
import { testKnobs, testRecord } from './testKnobs'

// Settings › General › "Open at login" (docs/DECISIONS.md ADR-0037). Electron registers the app
// itself with macOS's SMAppService (type mainAppService, the default). Its docs warn this "may
// silently fail" for an app that isn't notarized, so Settings shows the status macOS reports rather
// than assuming. Only a packaged app registers: a development or test build never adds itself to the
// Mac's Login Items.

const STATUSES: LoginItemStatus[] = ['enabled', 'requires-approval', 'not-registered', 'not-found']

let testOn = false

/** Whether the app opens at login, and what macOS says about it. */
export function loginItemState(): LoginItemState {
  const pretend = testKnobs.loginItemStatus
  if (pretend !== undefined) {
    return { on: testOn, status: testOn ? (pretend as LoginItemStatus) : 'not-registered' }
  }
  if (process.platform !== 'darwin' || !app.isPackaged) return { on: false, status: 'unavailable' }
  const { openAtLogin, status } = app.getLoginItemSettings()
  return {
    on: openAtLogin,
    status: STATUSES.includes(status as LoginItemStatus)
      ? (status as LoginItemStatus)
      : 'not-registered'
  }
}

/** Turns Open at login on or off, and reports what macOS made of it. */
export function setOpenAtLogin(on: boolean): LoginItemState {
  if (testKnobs.loginItemStatus !== undefined) {
    testOn = on
    testRecord('loginItem', on)
    return loginItemState()
  }
  if (loginItemState().status === 'unavailable') return loginItemState()
  app.setLoginItemSettings({ openAtLogin: on })
  return loginItemState()
}

/** Whether macOS opened Mergelane at login, so it starts in the menu bar without its window. */
export function openedAtLogin(): boolean {
  return (
    process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
  )
}
