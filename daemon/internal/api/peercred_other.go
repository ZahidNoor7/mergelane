//go:build !darwin

package api

import (
	"errors"
	"net"
)

// peerUID is only implemented for macOS, the one platform mergelane-daemon supports. Elsewhere every
// peer is refused, so the package still builds for tooling but never serves anyone.
func peerUID(*net.UnixConn) (uint32, error) { return 0, errors.ErrUnsupported }
