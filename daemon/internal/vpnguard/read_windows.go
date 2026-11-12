package vpnguard

import (
	"context"
	"errors"
	"fmt"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// ReadRoutes reads the routing table for Conflicts. On Windows it fails until milestone W5 (see
// rib.Read), so the guard refuses rather than guessing.
func ReadRoutes() ([]Route, error) { return rib.Read() }

// ReadNCConnected has no Windows equivalent of macOS's network services yet: finding the VPN
// adapters that are on comes with milestone W5. Until then it fails, so the guard refuses.
func ReadNCConnected(context.Context) ([]string, error) {
	return nil, fmt.Errorf("listing VPN connections on Windows: %w", errors.ErrUnsupported)
}
