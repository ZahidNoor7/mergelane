import { describe, expect, it } from 'vitest'
import {
  OPENED_AT_LOGIN_ARG,
  loginItemAvailable,
  loginItemStateFrom,
  openedAtLoginFrom
} from './loginItem'

describe('loginItemAvailable', () => {
  it('is only for a packaged app on macOS or Windows', () => {
    expect(loginItemAvailable('darwin', true)).toBe(true)
    expect(loginItemAvailable('win32', true)).toBe(true)
    expect(loginItemAvailable('win32', false)).toBe(false)
    expect(loginItemAvailable('linux', true)).toBe(false)
  })
})

describe('loginItemStateFrom', () => {
  it('passes on what macOS reports, and calls anything else not registered', () => {
    expect(
      loginItemStateFrom('darwin', { openAtLogin: true, status: 'requires-approval' })
    ).toEqual({
      on: true,
      status: 'requires-approval'
    })
    expect(loginItemStateFrom('darwin', { openAtLogin: false, status: 'weird' })).toEqual({
      on: false,
      status: 'not-registered'
    })
  })

  it('on Windows, the Run key either holds Mergelane or not', () => {
    expect(loginItemStateFrom('win32', { openAtLogin: true })).toEqual({
      on: true,
      status: 'enabled'
    })
    expect(loginItemStateFrom('win32', { openAtLogin: false })).toEqual({
      on: false,
      status: 'not-registered'
    })
  })
})

describe('openedAtLoginFrom', () => {
  const report = (wasOpenedAtLogin: boolean) => () => ({ openAtLogin: true, wasOpenedAtLogin })

  it('asks macOS', () => {
    expect(openedAtLoginFrom('darwin', true, report(true), [])).toBe(true)
    expect(openedAtLoginFrom('darwin', true, report(false), [])).toBe(false)
  })

  it('on Windows, looks for the argument the login entry passes', () => {
    expect(
      openedAtLoginFrom('win32', true, report(false), ['Mergelane.exe', OPENED_AT_LOGIN_ARG])
    ).toBe(true)
    expect(openedAtLoginFrom('win32', true, report(true), ['Mergelane.exe'])).toBe(false)
  })

  it('is never true for a development build or elsewhere', () => {
    expect(openedAtLoginFrom('win32', false, report(true), [OPENED_AT_LOGIN_ARG])).toBe(false)
    expect(openedAtLoginFrom('linux', true, report(true), [OPENED_AT_LOGIN_ARG])).toBe(false)
  })
})
