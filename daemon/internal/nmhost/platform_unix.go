//go:build !windows

package nmhost

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// defaultDial reaches the app's Unix socket.
var defaultDial = dialUnix

func dialUnix(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}

// ParentApp returns the executable of process pid, the browser that started the host, as ps(1)
// reports it (its full path on macOS), or "" when it can't be read. It runs /bin/ps without a shell,
// with a short timeout, and needs no privileges.
func ParentApp(ctx context.Context, pid int) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// SocketPath returns the app's browser socket: $MERGELANE_BROWSER_SOCKET, else
// $HOME/Library/Application Support/Mergelane/browser.sock. It returns "" when neither is set, so
// that the host never dials a path relative to its working directory.
func SocketPath(getenv func(string) string) string {
	if p := getenv(EnvSocket); p != "" {
		return p
	}
	home := getenv("HOME")
	if home == "" {
		return ""
	}
	return filepath.Join(home, "Library", "Application Support", "Mergelane", "browser.sock")
}

// openArgv starts the app in the background (-g: don't bring it to the front) by bundle ID, so it is
// found wherever it is installed.
var openArgv = []string{"/usr/bin/open", "-g", "-b", BundleID}

// OpenApp asks Launch Services to start Mergelane.app in the background. It returns once open(1) has
// handed the launch over, not when the app is ready.
func OpenApp(ctx context.Context) error { return runCommand(ctx, openArgv) }

// runCommand runs argv without a shell. Its output is captured, never sent to the host's stdout, and
// is part of the error when the command fails.
func runCommand(ctx context.Context, argv []string) error {
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		if msg := bytes.TrimSpace(out); len(msg) > 0 {
			return fmt.Errorf("%s: %w: %s", argv[0], err, msg)
		}
		return fmt.Errorf("%s: %w", argv[0], err)
	}
	return nil
}
