//go:build !windows

package api

import (
	"fmt"
	"net"
)

// Dial connects to the daemon's socket at path (normally SocketPath).
func Dial(path string) (*Client, error) {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	return NewClient(conn), nil
}
