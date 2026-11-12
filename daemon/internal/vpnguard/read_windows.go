package vpnguard

import (
	"context"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// ReadRoutes reads the routing table for Conflicts (rib.Read), with each route on a VPN's adapter
// marked Tunnel.
func ReadRoutes() ([]Route, error) { return rib.Read() }

// ReadNCConnected lists Windows' own VPN connections that are on: the PPP adapters that are up
// (rib.ConnectedPPP), by the name Windows shows for them. They play the part of macOS's network
// services: one that is connected keeps merging off even when it takes only some traffic.
func ReadNCConnected(context.Context) ([]string, error) {
	adapters, err := rib.Adapters()
	if err != nil {
		return nil, err
	}
	return rib.ConnectedPPP(adapters), nil
}
