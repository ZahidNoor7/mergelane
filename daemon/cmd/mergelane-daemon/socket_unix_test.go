//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
)

// testSocket gives a run a short socket path of its own (sun_path is 104 bytes on macOS), which this
// user may use.
func testSocket(t *testing.T, c *runConfig) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "mld")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	c.socketPath, c.allowedUID = filepath.Join(dir, "s"), os.Getuid()
}

// serve starts the control API on a socket of its own that lets everyone in.
func serve(t *testing.T, h api.Handler) string {
	t.Helper()
	var c runConfig
	testSocket(t, &c)
	srv, err := api.Listen(c.socketPath, 0o600, func(uint32) bool { return true }, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	return c.socketPath
}

// checkSocketListening: the socket is there, with mode 0666 (ADR-0005: the uid check, not the mode,
// decides who may use it).
func checkSocketListening(t *testing.T, path string) {
	t.Helper()
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o666 {
		t.Errorf("socket = %v, %v; want mode 0666 (ADR-0005)", fi, err)
	}
}

func socketGone(path string) error {
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s is still there: %v", path, err)
	}
	return nil
}

// breakSocket makes the socket impossible to create: a path longer than sun_path.
func breakSocket(c *runConfig) { c.socketPath = "/tmp/" + strings.Repeat("x", 120) }

const brokenSocket = "longer than"

func TestRunDaemonAuthorizesOnlyRootAndTheAllowedUser(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, which is always allowed")
	}
	h := newHarness(t)
	h.cfg.allowedUID = 0 // nobody but root
	errc := h.start(t)
	_, err := h.dial(t).Status(ctxT(t))
	if e := api.AsError(err); e == nil || e.Code != api.CodeNotAuthorized {
		t.Fatalf("status from an unlisted user = %v, want NOT_AUTHORIZED", err)
	}
	// Every CLI command reports the refusal.
	for _, args := range [][]string{{"status"}, {"on"}, {"off"}, {"links"}, {"stats"}, {"limit", "en0", "5"},
		{"events"}, {"auto-resume", "on"}} {
		code, _, errOut := run(args[0], append([]string{"-socket", h.cfg.socketPath}, args[1:]...)...)
		if code != 1 || !strings.Contains(errOut, "NOT_AUTHORIZED") {
			t.Errorf("%v = %d %q, want NOT_AUTHORIZED", args, code, errOut)
		}
	}
	h.shutdown(t, errc)
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
}
