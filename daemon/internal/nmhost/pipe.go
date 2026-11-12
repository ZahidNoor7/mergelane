package nmhost

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// PipeName is the Windows named pipe the app's browser bridge listens on, for the app's own folder (its
// userData, %APPDATA%\Mergelane by default): \\.\pipe\mergelane-browser- and the first 16 hex digits of the
// SHA-256 of the folder's path, its ASCII letters lowercased (Windows paths ignore case). One per folder, so a
// test profile never reaches the user's Mergelane, and no user's name shows in the pipe list. The app
// (app/src/shared/browserPipe.ts) and the test kit compute the same name; shared/fixtures/browser-pipe.json holds
// the examples all of them are tested against.
func PipeName(userData string) string {
	sum := sha256.Sum256([]byte(asciiLower(userData)))
	return `\\.\pipe\mergelane-browser-` + hex.EncodeToString(sum[:])[:16]
}

// asciiLower lowercases A-Z only, the same in Go, JavaScript and PowerShell whatever the locale.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, s)
}
