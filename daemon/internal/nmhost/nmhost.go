// Package nmhost is mergelane-nmhost, the native messaging host that carries the browser extension's
// messages to Mergelane.app (ADR-0021). The browser starts it with framed JSON on stdin; it forwards
// each message to the app's browser socket and writes the app's answer back, framed, on stdout.
// The protocol is in docs/BROWSER-BRIDGE.md.
//
// stdout carries only protocol frames. Everything else, logs included, goes to stderr.
package nmhost

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// ProtocolVersion is the "v" of every request line sent to the app. 3 added "browser" (M3.4b).
	ProtocolVersion = 3
	// BundleID is Mergelane.app's bundle identifier, which wake launches.
	BundleID = "io.github.zahidnoor7.mergelane"
	// EnvSocket overrides the app's socket path.
	EnvSocket = "MERGELANE_BROWSER_SOCKET"
	// EnvNoLaunch, when "1", stops wake from launching the app (for tests). The host still retries.
	EnvNoLaunch = "MERGELANE_NMHOST_NO_LAUNCH"
)

// Caller returns what identifies the extension that started the host, from the host's arguments
// (os.Args[1:]). Chrome passes the caller's origin, chrome-extension://<id>/, as the first argument.
// Firefox passes the path of the host manifest first and the add-on ID second. It returns "" when
// the argument is missing.
func Caller(args []string) string {
	i := 0
	if len(args) > 0 && strings.HasSuffix(args[0], ".json") {
		i = 1
	}
	if i < len(args) {
		return args[i]
	}
	return ""
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

// OptionsFromEnv returns the Options the host runs with, from its arguments (os.Args[1:]) and
// environment. Everything it leaves unset takes its default in New.
func OptionsFromEnv(args []string, getenv func(string) string) Options {
	return Options{
		Origin:     Caller(args),
		SocketPath: SocketPath(getenv),
		NoLaunch:   getenv(EnvNoLaunch) == "1",
	}
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
