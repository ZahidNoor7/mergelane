package main

import (
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"testing"

	"github.com/Microsoft/go-winio"
)

var testPipes atomic.Int64

// listenApp listens where the host looks for the app on Windows: a named pipe (ADR-0056), as the app's browser
// bridge serves one. The host opens it as a file (internal/nmhost/pipe_windows.go), not as a Unix socket.
func listenApp(t *testing.T) (net.Listener, string) {
	t.Helper()
	path := fmt.Sprintf(`\\.\pipe\mergelane-nmhost-test-%d-%d`, os.Getpid(), testPipes.Add(1))
	ln, err := winio.ListenPipe(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	return ln, path
}

// missingApp is a pipe name nothing serves.
func missingApp(path string) string { return path + "-missing" }
