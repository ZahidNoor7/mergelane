package nmhost

import (
	"context"
	"errors"
	"net"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// On Windows the app's browser bridge is a named pipe (ADR-0056): Node serves a net server on one, and Go's
// net package can't dial pipes. The host opens it as a file instead, overlapped, which os.NewFile turns into a
// pollable file with deadlines (`go doc os.NewFile`); a pipe client is opened with CreateFile (Microsoft
// Learn, "Named Pipes").

// pipeBusyWait is how long to wait between tries while every instance of the pipe is busy.
const pipeBusyWait = 20 * time.Millisecond

func dialPipe(ctx context.Context, path string) (net.Conn, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	for {
		h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil,
			windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED, 0)
		if err == nil {
			return &pipeConn{File: os.NewFile(uintptr(h), path), addr: pipeAddr(path)}, nil
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) {
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pipeBusyWait):
		}
	}
}

// pipeConn is a pipe opened as a file, as a net.Conn: os.File already reads, writes, closes and takes
// deadlines.
type pipeConn struct {
	*os.File
	addr pipeAddr
}

func (c *pipeConn) LocalAddr() net.Addr  { return c.addr }
func (c *pipeConn) RemoteAddr() net.Addr { return c.addr }

type pipeAddr string

func (a pipeAddr) Network() string { return "pipe" }
func (a pipeAddr) String() string  { return string(a) }
