package api

import (
	"errors"
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
)

// pipeBufferBytes is the pipe's buffer each way: a whole request line fits.
const pipeBufferBytes = MaxLineBytes + 1

// ListenPipe serves h on the named pipe at path (normally SocketPath). Only SYSTEM, Administrators and
// the user with userSID may open it (PipeSDDL): Windows refuses anyone else before a connection exists,
// so every connection that reaches the server is authorized. go-winio creates the pipe's first
// instance exclusively, so the call fails if another process already serves that name.
func ListenPipe(path, userSID string, h Handler) (*Server, error) {
	if h == nil {
		return nil, errors.New("api: ListenPipe needs a handler")
	}
	sddl, err := PipeSDDL(userSID)
	if err != nil {
		return nil, err
	}
	ln, err := winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: sddl,
		InputBufferSize:    pipeBufferBytes,
		OutputBufferSize:   pipeBufferBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	return serve(path, ln, pipePeer, pipeAuthorized, h), nil
}

// pipePeer has no uid to give: the pipe's security descriptor already decided.
func pipePeer(net.Conn) (uint32, error) { return 0, nil }

func pipeAuthorized(uint32) bool { return true }
