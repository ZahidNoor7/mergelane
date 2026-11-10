// Command mergelane-nmhost is Mergelane's native messaging host. The browser starts it for each message
// from the Mergelane extension; it relays the message to Mergelane.app over the app's browser socket and
// writes the answer back (docs/BROWSER-BRIDGE.md, internal/nmhost).
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nmhost"
)

// Set at build time: -X main.version=...
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr))
}

// run runs the host and returns the process exit code. stdout carries only protocol frames.
func run(args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "--version" {
		fmt.Fprintln(stdout, "mergelane-nmhost", version)
		return 0
	}
	opts := nmhost.OptionsFromEnv(args, getenv)
	opts.Log = stderr
	if err := nmhost.New(opts).Run(context.Background(), stdin, stdout); err != nil {
		fmt.Fprintln(stderr, "mergelane-nmhost:", err)
		return 1
	}
	return 0
}
