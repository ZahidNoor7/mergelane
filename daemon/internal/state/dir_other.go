//go:build !windows

package state

import "os"

// windowsDir is Windows' state directory; elsewhere there is none.
func windowsDir() string { return "" }

// Prepare creates the state directory, readable by everyone (the socket inside checks each
// caller's uid itself).
func Prepare(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Chmod(dir, 0o755)
}
