//go:build !windows

package api

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// refusesByUID: the server itself refuses a peer whose uid authorize turns down (NOT_AUTHORIZED).
const refusesByUID = true

// sockPath returns a fresh socket path. t.TempDir() is used when the path fits in sun_path (104
// bytes in <sys/un.h>, so 103 usable); macOS's per-user $TMPDIR is long, so it may not.
func sockPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "d.sock")
	if len(p) <= maxSocketPath {
		return p
	}
	dir, err := os.MkdirTemp("/tmp", "mlapi")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "d.sock")
}

func startServer(t *testing.T, h Handler, authorize func(uint32) bool) *Server {
	t.Helper()
	s, err := Listen(sockPath(t), 0o666, authorize, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func dialPath(path string) (net.Conn, error) {
	return net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
}

// missingPath is where no server listens.
func missingPath(t *testing.T) string { return sockPath(t) }

func (rc *rawConn) recv() Response {
	rc.t.Helper()
	b := rc.line()
	var resp Response
	if err := json.Unmarshal(b, &resp); err != nil {
		rc.t.Fatalf("response %q: %v", b, err)
	}
	return resp
}

// expectEOF checks that the server closed the connection.
func (rc *rawConn) expectEOF() {
	rc.t.Helper()
	rc.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	b, err := rc.r.ReadByte()
	if !errors.Is(err, io.EOF) {
		rc.t.Fatalf("want EOF, got byte %q, err %v", b, err)
	}
}
