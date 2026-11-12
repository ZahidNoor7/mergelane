import { createHash } from 'node:crypto'

// The browser bridge on Windows (W2, ADR-0056) is a named pipe, since Node serves a local "socket" there as one
// (Node's net documentation: "On Windows, the local domain is implemented using a named pipe"). Its name comes
// from the app's own folder, so a test profile never reaches the user's Mergelane and no user's name shows in
// the pipe list. mergelane-nmhost (daemon/internal/nmhost/pipe.go) and the test kit compute the same name, and
// all three are tested against shared/fixtures/browser-pipe.json.

/** A-Z only, the same in Go, JavaScript and PowerShell whatever the locale. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** The pipe for an app folder (userData): \\.\pipe\mergelane-browser- and 16 hex digits of the SHA-256 of
 * the folder's path, its ASCII letters lowercased (Windows paths ignore case). */
export function browserPipePath(userData: string): string {
  const digest = createHash('sha256').update(asciiLower(userData), 'utf8').digest('hex')
  return `\\\\.\\pipe\\mergelane-browser-${digest.slice(0, 16)}`
}
