//go:build !windows

package api

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Tests that need Unix-only calls (umask, socketpair). On Windows the control channel becomes a
// named pipe in milestone W5, with its own tests.

func TestListenCreatesParentDir(t *testing.T) {
	// A restrictive umask must not leak into the directory's mode.
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	base := filepath.Dir(sockPath(t))
	path := filepath.Join(base, "run", "ml", "d.sock")
	s, err := Listen(path, 0o666, allowAll, &fakeHandler{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fi, err := os.Stat(filepath.Dir(path))
	if err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o755 {
		t.Fatalf("parent %v, %v; want a 0755 directory", fi.Mode(), err)
	}
}

func TestConnAcceptedWhileClosingIsDropped(t *testing.T) {
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	// net.FileConn dups the descriptor, so the originals are closed at once: otherwise they would
	// keep the pair open after the server closes its end.
	f0, f1 := os.NewFile(uintptr(fds[0]), "a"), os.NewFile(uintptr(fds[1]), "b")
	c0, err0 := net.FileConn(f0)
	peer, err1 := net.FileConn(f1)
	f0.Close()
	f1.Close()
	if err0 != nil || err1 != nil {
		t.Fatal(err0, err1)
	}
	defer peer.Close()

	fa := newFakeAcceptor(0)
	fa.conn = c0.(*net.UnixConn)
	fa.holdOnClose = true // Close must not wake Accept; release does
	s := serve("", fa, allowAll, &fakeHandler{})
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	waitFor(t, "Close to mark the server closed", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.closed
	})
	close(fa.release) // Accept now returns a connection to a closing server
	<-done
	peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	if n, err := peer.Read(make([]byte, 1)); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("connection accepted during Close was not closed: %d, %v", n, err)
	}
}
