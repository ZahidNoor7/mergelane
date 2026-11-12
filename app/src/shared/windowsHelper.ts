// The system-wide helper on Windows (W5, ADR-0059), as the app drives it: where the helper is installed,
// how its install and removal are started through Windows' administrator prompt (User Account Control),
// and how the app reads what came back. Pure, so it is tested on any platform; main/daemon/windowsAdmin.ts
// runs it.

/** The helper's control pipe (daemon/internal/api socketpath_windows.go). */
export const WINDOWS_HELPER_PIPE = '\\\\.\\pipe\\mergelane-daemon'

/** The installed helper: %ProgramFiles%\Mergelane\mergelane-daemon.exe (daemon/internal/winsvc PathsFor). */
export function windowsHelperBinary(programFiles = 'C:\\Program Files'): string {
  return `${programFiles.replace(/\\+$/, '')}\\Mergelane\\mergelane-daemon.exe`
}

// A user account's security identifier, as the helper accepts it (daemon/internal/api PipeSDDL): local and
// domain accounts (S-1-5-21-…) and Microsoft Entra ID accounts (S-1-12-1-…), never a group like Everyone.
const USER_SID = /^S-1-(5-21|12-1)-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/

/** The user's security identifier from `whoami /user /fo csv /nh`, which prints one CSV line:
 * "pc-name\user","S-1-5-21-…". Null when no field is a user account's SID. */
export function userSidFromWhoami(output: string): string | null {
  for (const field of output.split(/[\r\n,]+/)) {
    const value = field.trim().replace(/^"|"$/g, '')
    if (USER_SID.test(value)) return value
  }
  return null
}

/** One argument for a Windows command line, quoted so CommandLineToArgvW reads it back unchanged
 * (Microsoft Learn, "Parsing C++ command-line arguments"): backslashes are literal unless they come
 * before a quote, so those, and any before the closing quote, are doubled. */
export function windowsArgument(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let quoted = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes++
      continue
    }
    if (char === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    else quoted += '\\'.repeat(backslashes) + char
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** A PowerShell single-quoted string, in which only a quote needs escaping (by doubling it). */
export function powershellString(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** The exit code the elevation script gives when the user answers No to Windows' prompt:
 * ERROR_CANCELLED, "The operation was canceled by the user" (System Error Codes). */
export const ELEVATION_CANCELED = 1223

/** The PowerShell that starts `exe` with `args` as administrator (Start-Process -Verb RunAs, which brings up
 * Windows' prompt), waits for it, and exits with its exit code; 1223 when the prompt was declined, found
 * as the Win32 error under whatever Start-Process threw. An elevated program's output can't be read back,
 * so the helper writes its result to the --report file instead. */
export function elevationScript(exe: string, args: readonly string[]): string {
  const argumentLine = args.map(windowsArgument).join(' ')
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath ${powershellString(exe)} -ArgumentList ${powershellString(argumentLine)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    `  while ($e) { if ($e.NativeErrorCode -eq ${ELEVATION_CANCELED}) { exit ${ELEVATION_CANCELED} }; $e = $e.InnerException }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n')
}

/** The script as powershell.exe's -EncodedCommand takes it: base64 of its UTF-16LE text (about_PowerShell_exe),
 * so no quoting of the script itself is needed. */
export function encodedCommand(script: string): string {
  // Each UTF-16 code unit as two bytes, low byte first; btoa takes them as a binary string.
  let bytes = ''
  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i)
    bytes += String.fromCharCode(unit & 0xff, unit >> 8)
  }
  return btoa(bytes)
}

/** What an elevated run came to: done, declined at the prompt, or failed with a reason. */
export interface ElevationOutcome {
  ok: boolean
  canceled: boolean
  reason: string
}

/** Reads an elevated run's exit code, the helper's --report file ("ok", or "error: …") and PowerShell's
 * own error output. */
export function elevationOutcome(
  code: number | null,
  report: string | null,
  stderr: string
): ElevationOutcome {
  const reported = (report ?? '').trim()
  if (code === 0 && reported === 'ok') return { ok: true, canceled: false, reason: '' }
  if (code === ELEVATION_CANCELED) return { ok: false, canceled: true, reason: 'canceled' }
  const reason =
    reported.replace(/^error:\s*/, '') ||
    stderr.trim().replace(/\s+/g, ' ') ||
    (code === 0
      ? 'the helper didn’t say whether it finished.'
      : `the helper ended with code ${code ?? 'unknown'}.`)
  return { ok: false, canceled: false, reason }
}
