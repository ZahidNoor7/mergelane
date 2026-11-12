package api

import (
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// refusesByUID: on Windows the pipe's security descriptor decides, before the server sees anyone.
const refusesByUID = false

var testPipes atomic.Int32

// startServer serves h on a pipe of its own that this user may open. authorize isn't asked on Windows.
func startServer(t *testing.T, h Handler, _ func(uint32) bool) *Server {
	t.Helper()
	path := fmt.Sprintf(`\\.\pipe\mergelane-api-test-%d-%d`, os.Getpid(), testPipes.Add(1))
	s, err := ListenPipe(path, currentUserSID(t), h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func dialPath(path string) (net.Conn, error) {
	timeout := 5 * time.Second
	return winio.DialPipe(path, &timeout)
}

// missingPath is a pipe no server serves.
func missingPath(*testing.T) string {
	return fmt.Sprintf(`\\.\pipe\mergelane-api-test-missing-%d`, os.Getpid())
}
