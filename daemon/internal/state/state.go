// Package state holds where the daemon keeps its files. The control socket lives in DefaultDir;
// per-link speed caps persist in limits.json (see limits.go), and the auto-resume setting with the
// facts a restart needs in prefs.json (see prefs.go).
package state

import (
	"os"
	"path/filepath"
	"runtime"
)

// macStateDir holds the control socket. It is under /var/run because the daemon runs as root but
// is driven by a normal user, so the directory has to be root-owned. macOS empties it at boot.
const macStateDir = "/var/run/mergelane"

// macLimitsDir is where the caps live on macOS: /var/run is emptied at boot, and a metered-tether
// cap that forgets itself after a reboot is worse than no cap at all. Application Support is the
// usual place for a setting that has to stay.
const macLimitsDir = "/Library/Application Support/Mergelane/daemon"

// DefaultDir is the daemon's state directory: a fixed root-owned path on macOS, so root never
// follows a symlink planted in a user-owned directory.
func DefaultDir() string {
	if runtime.GOOS == "darwin" {
		return macStateDir
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "mergelane")
}

// Prepare creates the state directory, readable by everyone (the socket inside checks each
// caller's uid itself).
func Prepare(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Chmod(dir, 0o755)
}
