import { afterEach, describe, expect, it } from 'vitest'
import { onWindows, platformWords, words } from './platformWords'

describe('platformWords', () => {
  afterEach(() => {
    window.mergelane.platform = 'darwin'
  })

  it('speaks of the Mac on macOS, as before', () => {
    expect(platformWords('darwin')).toMatchObject({
      thisComputer: 'this Mac',
      revealLabel: 'Show in Finder',
      statusArea: 'the menu bar',
      settingsShortcut: '⌘,',
      adminPrompt: 'Your Mac asks for your administrator password.',
      adminPromptShort: 'Your Mac asks for your password.'
    })
  })

  it('speaks of the PC on Windows', () => {
    expect(platformWords('win32')).toEqual({
      computer: 'PC',
      thisComputer: 'this PC',
      appearanceSource: 'Windows',
      system: 'Windows',
      revealLabel: 'Show in File Explorer',
      statusArea: 'the notification area',
      settingsShortcut: 'Ctrl+,',
      adminPrompt: 'Windows asks for an administrator’s permission.',
      adminPromptShort: 'Windows asks an administrator to approve the update once.'
    })
  })

  it('reads the platform at the time of the call', () => {
    expect(onWindows()).toBe(false)
    window.mergelane.platform = 'win32'
    expect(onWindows()).toBe(true)
    expect(words().computer).toBe('PC')
  })
})
