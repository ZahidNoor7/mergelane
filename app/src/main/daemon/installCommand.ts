// The AppleScript the app runs, through an administrator password prompt, to install the bundled
// mergelane-daemon as a LaunchDaemon for the current user (daemon/internal/launchd).

/** AppleScript string literal. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Shell single-quoted word. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** The admin-prompt command that installs the bundled helper as a LaunchDaemon for this user. */
export function installCommand(binary: string, uid: number): string {
  const shell = `${shellWord(binary)} install --uid ${uid} --source ${shellWord(binary)}`
  return `do shell script ${appleScriptString(shell)} with administrator privileges`
}
