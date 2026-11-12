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
	"strings"
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

// OptionsFromEnv returns the Options the host runs with, from its arguments (os.Args[1:]) and
// environment. Everything it leaves unset takes its default in New.
func OptionsFromEnv(args []string, getenv func(string) string) Options {
	return Options{
		Origin:     Caller(args),
		SocketPath: SocketPath(getenv),
		NoLaunch:   getenv(EnvNoLaunch) == "1",
	}
}

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
