package vpnguard

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// scutil is what ReadNCConnected runs; a variable only so the tests can make it fail.
var scutil = "/usr/sbin/scutil"

// ReadRoutes reads the routing table for Conflicts (read-only, no privileges needed).
func ReadRoutes() ([]Route, error) { return rib.Read() }

// ReadNCConnected runs `scutil --nc list` (read-only) and returns the services that are on; see
// ParseNCList for which statuses count.
func ReadNCConnected(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, scutil, "--nc", "list").Output()
	if err != nil {
		return nil, fmt.Errorf("scutil --nc list: %w", err)
	}
	return ParseNCList(string(out)), nil
}
