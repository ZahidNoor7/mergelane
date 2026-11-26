// The commands that sleep or shut the computer down when the queue finishes (ADR-0079); why each
// is the polite one is in main/power.ts, which runs them. Pure, so it is unit-tested on its own.

export type PowerAction = 'sleep' | 'shutdown'

/** The command for an action on a platform, or null where Mergelane can't do it. */
export function powerCommand(
  action: PowerAction,
  platform: NodeJS.Platform
): [string, string[]] | null {
  if (platform === 'darwin') {
    return action === 'sleep'
      ? ['/usr/bin/pmset', ['sleepnow']]
      : ['/usr/bin/osascript', ['-e', 'tell application "loginwindow" to «event aevtshut»']]
  }
  if (platform === 'win32') {
    return action === 'sleep'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
          ]
        ]
      : ['shutdown.exe', ['/s', '/t', '0']]
  }
  return null
}
