//go:build !windows

package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestServerManyRequestsPerConnection(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	// Three requests in one write, with a blank line and a CRLF line in between.
	rc.send(`{"v":1,"id":"a","method":"status"}` + "\n\n" +
		`{"v":1,"id":"b","method":"links"}` + "\r\n" +
		`{"v":1,"id":"c","method":"setLimit","params":{"link":"en0","mbps":5}}` + "\n")
	for _, id := range []string{"a", "b", "c"} {
		resp := rc.recv()
		if resp.ID != id || !resp.OK {
			t.Fatalf("want ok response %q, got %+v", id, resp)
		}
	}
	// One request split across two writes.
	rc.send(`{"v":1,"id":"d","meth`)
	time.Sleep(20 * time.Millisecond)
	rc.send(`od":"stats"}` + "\n")
	if resp := rc.recv(); resp.ID != "d" || !resp.OK {
		t.Fatalf("split request: %+v", resp)
	}
}

func TestServerLastLineWithoutNewline(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"last","method":"status"}`)
	if err := rc.c.(*net.UnixConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if resp := rc.recv(); resp.ID != "last" || !resp.OK {
		t.Fatalf("got %+v", resp)
	}
	rc.expectEOF()
}

func TestServerMalformedJSONKeepsConnection(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	rc.send("this is not json\n")
	expectCode(t, rc.recv(), "", CodeBadRequest)
	rc.send(`{"v":1,"id":"ok","method":"status"}` + "\n")
	if resp := rc.recv(); resp.ID != "ok" || !resp.OK {
		t.Fatalf("connection unusable after a malformed line: %+v", resp)
	}
}

func TestServerOversizeLine(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	rc.send(strings.Repeat("x", MaxLineBytes+1) + "\n")
	resp := rc.recv()
	expectCode(t, resp, "", CodeBadRequest)
	if !strings.Contains(resp.Error.Message, "longer than") {
		t.Fatalf("message %q", resp.Error.Message)
	}
	rc.expectEOF()
}

func TestServerLineAtLimit(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	head, tail := `{"v":1,"id":"`, `","method":"status"}`
	id := strings.Repeat("i", MaxLineBytes-len(head)-len(tail))
	line := head + id + tail
	if len(line) != MaxLineBytes {
		t.Fatalf("line is %d bytes", len(line))
	}
	rc.send(line + "\n")
	if resp := rc.recv(); resp.ID != id || !resp.OK {
		t.Fatalf("a line of exactly MaxLineBytes was refused: %+v", resp.Error)
	}
}

func TestServerProtocolErrors(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":2,"id":"v2","method":"status"}` + "\n")
	expectCode(t, rc.recv(), "v2", CodeUnsupportedVersion)
	rc.send(`{"v":1,"id":"m","method":"reboot"}` + "\n")
	expectCode(t, rc.recv(), "m", CodeUnknownMethod)
	rc.send(`{"v":1,"id":"p","method":"setLimit","params":{"link":"en0"}}` + "\n")
	expectCode(t, rc.recv(), "p", CodeBadRequest)
	// None of these close the connection.
	rc.send(`{"v":1,"id":"still","method":"status"}` + "\n")
	if resp := rc.recv(); !resp.OK {
		t.Fatalf("got %+v", resp)
	}
}

func TestServerHandlerErrors(t *testing.T) {
	h := &fakeHandler{err: Errorf(CodeVPNActive, "utun4 carries the default route")}
	s := startServer(t, h, allowAll)
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"1","method":"enable"}` + "\n")
	resp := rc.recv()
	expectCode(t, resp, "1", CodeVPNActive)
	if resp.Error.Message != "utun4 carries the default route" {
		t.Fatalf("message %q", resp.Error.Message)
	}

	h2 := &fakeHandler{err: errors.New("sysctl failed")}
	s2 := startServer(t, h2, allowAll)
	rc2 := dialRaw(t, s2.Path())
	rc2.send(`{"v":1,"id":"2","method":"stats"}` + "\n")
	resp = rc2.recv()
	expectCode(t, resp, "2", CodeInternal)
	if resp.Error.Message != "sysctl failed" {
		t.Fatalf("message %q", resp.Error.Message)
	}
}

func TestServerRefusesUnauthorizedPeer(t *testing.T) {
	var asked atomic.Int64
	asked.Store(-1)
	s := startServer(t, &fakeHandler{}, func(uid uint32) bool {
		asked.Store(int64(uid))
		return false
	})
	rc := dialRaw(t, s.Path())
	// The refusal arrives without the peer sending anything, and then the server hangs up.
	expectCode(t, rc.recv(), "", CodeNotAuthorized)
	rc.expectEOF()
	if got := asked.Load(); got != int64(os.Getuid()) {
		t.Fatalf("authorize got uid %d, want %d", got, os.Getuid())
	}
}

// TestPeerCredIsOwnUID checks the real LOCAL_PEERCRED path end to end: a connection from this
// process must report this process's uid.
func TestPeerCredIsOwnUID(t *testing.T) {
	var mu sync.Mutex
	var uids []uint32
	s := startServer(t, &fakeHandler{}, func(uid uint32) bool {
		mu.Lock()
		uids = append(uids, uid)
		mu.Unlock()
		return true
	})
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"1","method":"status"}` + "\n")
	if resp := rc.recv(); !resp.OK {
		t.Fatalf("got %+v", resp)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(uids) != 1 || uids[0] != uint32(os.Getuid()) {
		t.Fatalf("authorize saw %v, want [%d]", uids, os.Getuid())
	}

	// And directly, on both ends of a fresh connection.
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath(t), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cli, err := net.DialUnix("unix", nil, ln.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	srv, err := ln.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	for _, c := range []*net.UnixConn{srv, cli} {
		uid, err := peerUID(c)
		if err != nil || uid != uint32(os.Getuid()) {
			t.Fatalf("peerUID = %d, %v; want %d", uid, err, os.Getuid())
		}
	}
	cli.Close()
	if _, err := peerUID(cli); err == nil {
		t.Fatal("peerUID on a closed connection succeeded")
	}
}

func TestListenRemovesStaleSocket(t *testing.T) {
	path := sockPath(t)
	// A socket file whose server is gone, as a crash leaves it.
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close()
	if fi, err := os.Lstat(path); err != nil || fi.Mode().Type() != fs.ModeSocket {
		t.Fatalf("no stale socket to test with: %v", err)
	}
	s, err := Listen(path, 0o666, allowAll, &fakeHandler{})
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	defer s.Close()
	rc := dialRaw(t, path)
	rc.send(`{"v":1,"id":"1","method":"status"}` + "\n")
	if resp := rc.recv(); !resp.OK {
		t.Fatalf("got %+v", resp)
	}
}

func TestListenRefusesLiveSocket(t *testing.T) {
	s := startServer(t, &fakeHandler{}, allowAll)
	if s2, err := Listen(s.Path(), 0o666, allowAll, &fakeHandler{}); err == nil {
		s2.Close()
		t.Fatal("took over a socket another server still serves")
	} else if !strings.Contains(err.Error(), "in use") {
		t.Fatalf("error %v", err)
	}
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"1","method":"status"}` + "\n")
	if resp := rc.recv(); !resp.OK {
		t.Fatalf("first server broken: %+v", resp)
	}
}

func TestListenLeavesNonSocketsAlone(t *testing.T) {
	path := sockPath(t)
	if err := os.WriteFile(path, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(path, 0o666, allowAll, &fakeHandler{}); err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Fatalf("error %v", err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "keep me" {
		t.Fatalf("file changed: %q, %v", b, err)
	}

	// A symlink is not followed, even to a socket.
	target := startServer(t, &fakeHandler{}, allowAll).Path()
	link := filepath.Join(filepath.Dir(path), "link.sock")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(link, 0o666, allowAll, &fakeHandler{}); err == nil {
		t.Fatal("listened over a symlink")
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode().Type() != fs.ModeSymlink {
		t.Fatalf("symlink changed: %v", err)
	}
}

func TestListenSocketMode(t *testing.T) {
	for _, mode := range []os.FileMode{0o600, 0o660, 0o666} {
		s, err := Listen(sockPath(t), mode, allowAll, &fakeHandler{})
		if err != nil {
			t.Fatal(err)
		}
		fi, err := os.Lstat(s.Path())
		s.Close()
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Type() != fs.ModeSocket || fi.Mode().Perm() != mode {
			t.Errorf("mode %v, want socket %v", fi.Mode(), mode)
		}
	}
}

func TestListenErrors(t *testing.T) {
	h := &fakeHandler{}
	if _, err := Listen(sockPath(t), 0o666, nil, h); err == nil {
		t.Error("nil authorize accepted")
	}
	if _, err := Listen(sockPath(t), 0o666, allowAll, nil); err == nil {
		t.Error("nil handler accepted")
	}
	if _, err := Listen("/tmp/"+strings.Repeat("x", 100), 0o666, allowAll, h); err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Errorf("long path: %v", err)
	}

	base := filepath.Dir(sockPath(t))
	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(filepath.Join(file, "d.sock"), 0o666, allowAll, h); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Errorf("parent is a file: %v", err)
	}
	if _, err := Listen(filepath.Join(file, "sub", "d.sock"), 0o666, allowAll, h); err == nil {
		t.Error("parent below a file accepted")
	}

	if os.Getuid() == 0 {
		t.Log("running as root: permission checks skipped")
		return
	}
	ro := filepath.Join(base, "ro")
	if err := os.Mkdir(ro, 0o755); err != nil {
		t.Fatal(err)
	}
	// A stale socket inside a directory we cannot write: neither removable nor replaceable.
	stale := filepath.Join(ro, "stale.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close()
	if err := os.Chmod(ro, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(ro, 0o755) })
	if _, err := Listen(stale, 0o666, allowAll, h); err == nil {
		t.Error("removed a socket from a read-only directory")
	}
	if _, err := Listen(filepath.Join(ro, "new.sock"), 0o666, allowAll, h); err == nil {
		t.Error("bound in a read-only directory")
	}
	if _, err := Listen(filepath.Join(ro, "sub", "d.sock"), 0o666, allowAll, h); err == nil {
		t.Error("created a directory inside a read-only one")
	}
	// A directory we cannot search: the stale-socket check itself fails.
	if err := os.Chmod(ro, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(stale, 0o666, allowAll, h); err == nil {
		t.Error("listened in an unsearchable directory")
	}
}

func TestServerCloseIsIdempotent(t *testing.T) {
	s, err := Listen(sockPath(t), 0o666, allowAll, &fakeHandler{})
	if err != nil {
		t.Fatal(err)
	}
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"1","method":"status"}` + "\n")
	rc.recv()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	rc.expectEOF()
	if _, err := os.Lstat(s.Path()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("socket file left behind: %v", err)
	}
	if c, err := net.Dial("unix", s.Path()); err == nil {
		c.Close()
		t.Fatal("still accepting after Close")
	}
}

func TestServerCloseCancelsHandlers(t *testing.T) {
	started := make(chan struct{})
	seen := make(chan error, 1)
	h := &fakeHandler{statusFn: func(ctx context.Context) (Status, error) {
		close(started)
		<-ctx.Done()
		seen <- ctx.Err()
		return Status{}, ctx.Err()
	}}
	s, err := Listen(sockPath(t), 0o666, allowAll, h)
	if err != nil {
		t.Fatal(err)
	}
	rc := dialRaw(t, s.Path())
	rc.send(`{"v":1,"id":"1","method":"status"}` + "\n")
	<-started
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return")
	}
	if err := <-seen; !errors.Is(err, context.Canceled) {
		t.Fatalf("handler ctx: %v", err)
	}
	// The cancelled handler's answer may or may not get out before its connection is closed. If
	// it does, it is the error for that request; either way the connection then ends.
	rc.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if b, err := rc.r.ReadBytes('\n'); err == nil {
		var resp Response
		if json.Unmarshal(b, &resp) != nil || resp.ID != "1" || resp.OK {
			t.Fatalf("unexpected answer %s", b)
		}
		rc.expectEOF()
	} else if !errors.Is(err, io.EOF) || len(b) != 0 {
		t.Fatalf("want EOF, got %q, %v", b, err)
	}
}

// fakeAcceptor fails Accept fail times (always if fail < 0), then blocks until release is closed
// (returning conn) or until Close (unless holdOnClose).
type fakeAcceptor struct {
	fail        int32
	holdOnClose bool
	calls       atomic.Int32
	conn        net.Conn
	release     chan struct{}
	closed      chan struct{}
	once        sync.Once
}

func newFakeAcceptor(fail int32) *fakeAcceptor {
	return &fakeAcceptor{fail: fail, release: make(chan struct{}), closed: make(chan struct{})}
}

func (f *fakeAcceptor) Accept() (net.Conn, error) {
	if n := f.calls.Add(1); f.fail < 0 || n <= f.fail {
		return nil, syscall.EMFILE
	}
	select {
	case <-f.release:
		return f.conn, nil
	case <-f.closed:
		return nil, net.ErrClosed
	}
}

func (f *fakeAcceptor) Close() error {
	if !f.holdOnClose {
		f.once.Do(func() { close(f.closed) })
	}
	return nil
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAcceptErrorsAreRetried(t *testing.T) {
	fa := newFakeAcceptor(3)
	s := serve("", fa, unixPeerUID, allowAll, &fakeHandler{})
	waitFor(t, "a fourth Accept", func() bool { return fa.calls.Load() >= 4 })
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCloseDuringAcceptBackoff(t *testing.T) {
	fa := newFakeAcceptor(-1) // always fails
	s := serve("", fa, unixPeerUID, allowAll, &fakeHandler{})
	waitFor(t, "backoff to grow", func() bool { return fa.calls.Load() >= 6 })
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close waited out the accept backoff")
	}
}
