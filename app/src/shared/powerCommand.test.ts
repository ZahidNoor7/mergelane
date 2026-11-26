import { describe, expect, it } from 'vitest'
import { powerCommand } from './powerCommand'

describe('the command that sleeps or shuts down', () => {
  it('on macOS: pmset for sleep, the shutdown Apple event to loginwindow', () => {
    expect(powerCommand('sleep', 'darwin')).toEqual(['/usr/bin/pmset', ['sleepnow']])
    expect(powerCommand('shutdown', 'darwin')).toEqual([
      '/usr/bin/osascript',
      ['-e', 'tell application "loginwindow" to «event aevtshut»']
    ])
  })

  it('on Windows: a polite suspend request, and a shutdown with no time-out and no force', () => {
    const [shell, args] = powerCommand('sleep', 'win32')!
    expect(shell).toBe('powershell.exe')
    expect(args.at(-1)).toContain("SetSuspendState('Suspend', $false, $false)")
    const shutdown = powerCommand('shutdown', 'win32')
    expect(shutdown).toEqual(['shutdown.exe', ['/s', '/t', '0']])
    expect(shutdown![1]).not.toContain('/f')
  })

  it('nowhere else', () => {
    expect(powerCommand('sleep', 'linux')).toBeNull()
    expect(powerCommand('shutdown', 'freebsd')).toBeNull()
  })
})
