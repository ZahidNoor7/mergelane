//go:build !windows

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// listenApp listens where the host looks for the app on macOS: a Unix socket, in a fresh directory under /tmp
// (macOS's per-user $TMPDIR is too long for sun_path, 104 bytes in <sys/un.h>).
func listenApp(t *testing.T) (net.Listener, string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nmh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "browser.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	return ln, path
}

// missingApp is a socket path next to path that nothing listens on.
func missingApp(path string) string { return filepath.Join(filepath.Dir(path), "missing.sock") }
