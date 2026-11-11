// The AppleScript the app runs, through an administrator password prompt, to install the bundled
// mergelane-daemon as a LaunchDaemon for the current user, or to remove it again
// (daemon/internal/launchd). Apple's Technical Note TN2065: `do shell script "command" with
// administrator privileges` "runs the command as the root user", through /bin/sh, so the command is
// one shell line whose paths are single-quoted words.

/** AppleScript string literal. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Shell single-quoted word. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function asAdministrator(shell: string): string {
  return `do shell script ${appleScriptString(shell)} with administrator privileges`
}

/** The admin-prompt command that installs the bundled helper as a LaunchDaemon for this user. */
export function installCommand(binary: string, uid: number): string {
  return asAdministrator(`${shellWord(binary)} install --uid ${uid} --source ${shellWord(binary)}`)
}

/** The admin-prompt command that removes the helper with the bundled binary's `uninstall`
 * (launchd.Uninstall): it boots the LaunchDaemon out, removes any routes left behind (the same
 * work as `mergelane-daemon cleanup`), then deletes the plist and the installed binary. The log
 * folder stays. */
export function uninstallCommand(binary: string): string {
  return asAdministrator(`${shellWord(binary)} uninstall`)
}
