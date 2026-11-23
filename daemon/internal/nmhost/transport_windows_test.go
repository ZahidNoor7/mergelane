package nmhost

import (
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"testing"

	"github.com/Microsoft/go-winio"
)

// The app's browser bridge on Windows is a named pipe (ADR-0056), which the host opens with dialPipe: the tests
// serve one, so they go the way the host goes on Windows. (Windows has Unix sockets too, but they don't reliably
// end a read when the other side closes, which the host relies on: seen on GitHub's runners, ADR-0075.)

var testPipes atomic.Int64

// socketPath returns a pipe name of this test's own.
func socketPath(*testing.T) string {
	return fmt.Sprintf(`\\.\pipe\mergelane-nmhost-test-%d-%d`, os.Getpid(), testPipes.Add(1))
}

// listenApp serves the app's side at path.
func listenApp(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := winio.ListenPipe(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

// staleApp is a pipe nobody serves, as after an app crash.
func staleApp(t *testing.T) string { return socketPath(t) }

// missingApp is another pipe nobody serves.
const missingApp = `\\.\pipe\mergelane-nmhost-test-missing`
