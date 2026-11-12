package api

import (
	"fmt"
	"time"

	"github.com/Microsoft/go-winio"
)

// dialTimeout bounds waiting for the pipe: go-winio retries while every instance is busy.
const dialTimeout = 5 * time.Second

// Dial connects to the daemon's named pipe at path (normally SocketPath).
func Dial(path string) (*Client, error) {
	timeout := dialTimeout
	conn, err := winio.DialPipe(path, &timeout)
	if err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	return NewClient(conn), nil
}
