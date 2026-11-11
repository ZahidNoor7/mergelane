package api

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// maxSocketPath is the longest socket path the kernel accepts: sun_path is char[104] in the
	// macOS SDK's <sys/un.h>, and Go's syscall package needs room for the terminating NUL.
	maxSocketPath = 103
	// writeTimeout bounds each response write, so a peer that stops reading cannot hold a
	// connection's goroutine forever.
	writeTimeout = 10 * time.Second
	// probeTimeout bounds the check for a live server on an existing socket.
	probeTimeout = 500 * time.Millisecond
	// maxAcceptBackoff caps the pause after a failing Accept (for example EMFILE).
	maxAcceptBackoff = time.Second
)

// acceptor is the part of *net.UnixListener the server uses; tests substitute failing ones.
type acceptor interface {
	AcceptUnix() (*net.UnixConn, error)
	Close() error
}

// Server serves the control API on a Unix socket. Create one with Listen and stop it with Close.
type Server struct {
	path      string
	ln        acceptor
	authorize func(uid uint32) bool
	h         Handler

	ctx    context.Context // cancelled by Close; passed to the handler
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu     sync.Mutex
	conns  map[*net.UnixConn]struct{}
	closed bool

	closeOnce sync.Once
	closeErr  error
}

// Listen creates the socket at path and starts serving h on it.
//
//   - The parent directory is created with mode 0755 if it is missing.
//   - A stale socket left at path by an earlier run is removed. Anything else at path (a file, a
//     symlink, a socket another process still serves) is left alone and Listen fails.
//   - The socket is chmod'ed to mode.
//   - Every connection's peer uid is read with LOCAL_PEERCRED. If authorize(uid) is false the peer
//     gets one NOT_AUTHORIZED response with id "" and the connection is closed.
//
// The socket's permissions are not the access control: on a multi-user Mac any local user may be
// able to connect, which is why every connection goes through authorize.
func Listen(path string, mode os.FileMode, authorize func(uid uint32) bool, h Handler) (*Server, error) {
	if authorize == nil || h == nil {
		return nil, errors.New("api: Listen needs an authorize func and a handler")
	}
	if len(path) > maxSocketPath {
		return nil, fmt.Errorf("api: socket path %q is longer than %d bytes", path, maxSocketPath)
	}
	if err := prepareDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if err := removeStale(path); err != nil {
		return nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	// Between bind and chmod the socket has the umask's mode. That is harmless: authorize, not the
	// mode, decides who may use it.
	if err := os.Chmod(path, mode.Perm()); err != nil {
		ln.Close()
		return nil, fmt.Errorf("api: %w", err)
	}
	return serve(path, ln, authorize, h), nil
}

func serve(path string, ln acceptor, authorize func(uint32) bool, h Handler) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		path: path, ln: ln, authorize: authorize, h: h,
		ctx: ctx, cancel: cancel,
		conns: make(map[*net.UnixConn]struct{}),
	}
	s.wg.Add(1)
	go s.acceptLoop()
	return s
}

// Path is the socket's path.
func (s *Server) Path() string { return s.path }

// Close stops accepting, closes every connection, cancels the context handlers run with, waits for
// running handlers to return and removes the socket file. It is safe to call more than once; later
// calls return the first call's result.
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.cancel()
		s.closeErr = s.ln.Close() // net.UnixListener also unlinks the socket file it created
		s.mu.Lock()
		s.closed = true
		for c := range s.conns {
			c.Close()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
	return s.closeErr
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	var backoff time.Duration
	for {
		c, err := s.ln.AcceptUnix()
		if err != nil {
			if s.ctx.Err() != nil {
				return // closed
			}
			// Running out of descriptors must not end the API for good: pause and retry, as
			// net/http does.
			backoff = min(max(2*backoff, 5*time.Millisecond), maxAcceptBackoff)
			select {
			case <-time.After(backoff):
			case <-s.ctx.Done():
				return
			}
			continue
		}
		backoff = 0
		if !s.track(c) {
			c.Close()
			return
		}
		go s.serveConn(c)
	}
}

// track registers c and counts its goroutine, unless the server is closing.
func (s *Server) track(c *net.UnixConn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.conns[c] = struct{}{}
	s.wg.Add(1)
	return true
}

func (s *Server) untrack(c *net.UnixConn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
	c.Close()
}

func (s *Server) serveConn(c *net.UnixConn) {
	defer s.wg.Done()
	defer s.untrack(c)

	uid, err := peerUID(c)
	if err != nil || !s.authorize(uid) {
		s.write(c, ErrorResponse("", Errorf(CodeNotAuthorized,
			"this user is not allowed to control mergelane-daemon")))
		return
	}
	r := bufio.NewReaderSize(c, MaxLineBytes+1) // room for the newline
	for {
		line, err := r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			s.write(c, ErrorResponse("", Errorf(CodeBadRequest,
				"request line is longer than %d bytes", MaxLineBytes)))
			return
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return // closed, by the peer or by Close
		}
		if len(bytes.TrimSpace(line)) > 0 { // blank lines are ignored
			if s.write(c, s.handle(line)) != nil {
				return
			}
		}
		if err != nil {
			return // EOF, after answering a last line that had no newline
		}
	}
}

func (s *Server) handle(line []byte) Response {
	req, err := ParseRequest(line)
	if err != nil {
		return ErrorResponse(req.ID, err)
	}
	return Dispatch(s.ctx, s.h, req)
}

func (s *Server) write(c *net.UnixConn, resp Response) error {
	b, err := EncodeResponse(resp)
	if err != nil {
		return err
	}
	if err := c.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	_, err = c.Write(b)
	return err
}

// prepareDir makes sure dir exists, creating it with mode 0755 (whatever the umask) if it does not.
func prepareDir(dir string) error {
	fi, err := os.Stat(dir)
	if err == nil {
		if !fi.IsDir() {
			return fmt.Errorf("api: %s is not a directory", dir)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("api: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("api: %w", err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return fmt.Errorf("api: %w", err)
	}
	return nil
}

// removeStale deletes a socket an earlier run left at path. It never follows a symlink, never
// deletes anything that is not a socket and never takes over a socket another process serves.
func removeStale(path string) error {
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("api: %w", err)
	}
	if fi.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("api: %s exists and is not a socket; not removing it", path)
	}
	if c, err := net.DialTimeout("unix", path, probeTimeout); err == nil {
		c.Close()
		return fmt.Errorf("api: %s is in use by another process", path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("api: %w", err)
	}
	return nil
}
