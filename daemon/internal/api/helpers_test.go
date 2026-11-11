package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

var testTime = time.Date(2026, 11, 10, 9, 30, 0, 0, time.UTC)

func allowAll(uint32) bool { return true }

// fakeHandler answers every method from its fields and records the params it was given.
type fakeHandler struct {
	err      error // returned by every method when set
	statusFn func(context.Context) (Status, error)
	links    []Link
	stats    []LinkStats

	mu       sync.Mutex
	disables []DisableParams
	limits   []SetLimitParams
}

func (f *fakeHandler) Status(ctx context.Context) (Status, error) {
	if f.statusFn != nil {
		return f.statusFn(ctx)
	}
	return Status{State: StateOn, Since: testTime, Version: "test"}, f.err
}

func (f *fakeHandler) Enable(context.Context) (Status, error) {
	return Status{State: StateStarting, Version: "test"}, f.err
}

func (f *fakeHandler) Disable(_ context.Context, p DisableParams) (Status, error) {
	f.mu.Lock()
	f.disables = append(f.disables, p)
	f.mu.Unlock()
	return Status{State: StateOff, Reason: p.Reason, Version: "test"}, f.err
}

func (f *fakeHandler) Links(context.Context) (LinksResult, error) {
	return LinksResult{Links: f.links}, f.err
}

func (f *fakeHandler) Stats(context.Context) (Stats, error) {
	return Stats{At: testTime, Links: f.stats}, f.err
}

func (f *fakeHandler) SetLimit(_ context.Context, p SetLimitParams) (SetLimitResult, error) {
	f.mu.Lock()
	f.limits = append(f.limits, p)
	f.mu.Unlock()
	return SetLimitResult(p), f.err
}

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

// rawConn speaks the wire format by hand.
type rawConn struct {
	t *testing.T
	c *net.UnixConn
	r *bufio.Reader
}

func dialRaw(t *testing.T, path string) *rawConn {
	t.Helper()
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &rawConn{t: t, c: c, r: bufio.NewReaderSize(c, maxResponseBytes)}
}

func (rc *rawConn) send(s string) {
	rc.t.Helper()
	if _, err := rc.c.Write([]byte(s)); err != nil {
		rc.t.Fatal(err)
	}
}

// line reads one raw response line.
func (rc *rawConn) line() []byte {
	rc.t.Helper()
	rc.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	b, err := rc.r.ReadBytes('\n')
	if err != nil {
		rc.t.Fatalf("reading a response: %v (got %q)", err, b)
	}
	return b
}

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

func expectCode(t *testing.T, resp Response, id string, code Code) {
	t.Helper()
	if resp.V != ProtocolVersion || resp.ID != id || resp.OK || resp.Error == nil || resp.Error.Code != code {
		t.Fatalf("want %s error for id %q, got %+v (error %+v)", code, id, resp, resp.Error)
	}
	if resp.Error.Message == "" {
		t.Fatalf("%s error has no message", code)
	}
}

// jsonEqual reports whether two JSON texts hold the same value.
func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		t.Fatalf("%s: %v", a, err)
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return reflect.DeepEqual(va, vb)
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
