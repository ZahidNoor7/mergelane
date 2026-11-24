//go:build !windows

package nmhost

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// The app's browser bridge on macOS is a Unix socket, which the host dials with dialUnix.

// socketPath returns a socket path in a fresh directory under /tmp: macOS's per-user $TMPDIR is too long for
// sun_path (104 bytes in <sys/un.h>).
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nmh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "browser.sock")
}

// listenApp serves the app's side at path.
func listenApp(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

// staleApp is a socket file nobody listens on, as after an app crash: ECONNREFUSED.
func staleApp(t *testing.T) string {
	t.Helper()
	stale := socketPath(t)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	l.SetUnlinkOnClose(false)
	l.Close()
	return stale
}

// missingApp is a path with no socket file at all.
const missingApp = "/tmp/nmh-missing/browser.sock"
