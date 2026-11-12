package tun

import (
	"errors"
	"net/netip"
)

// System merge on Windows (a Wintun adapter, its capture routes and their cleanup) is milestone W5
// in docs/WINDOWS-PLAN.md, with Net Merge's Windows engine re-imported then. Until then nothing in
// this package touches Windows networking: open refuses before creating an adapter, so configure
// and delRoutes are never reached with real work to do.
const openHint = "System merge is not available on Windows yet"

func init() {
	errUnsupported = errors.New("system merge is not available on Windows yet")
}

func configure(string, int, netip.Prefix) (int, error) { return 0, errUnsupported }

// delRoutes has nothing to remove: no route is ever added on Windows yet.
func delRoutes(int) {}

// The adapter's IPv6 address and the capture routes are shared with macOS and come into use here in
// W5; referenced so they stay declared once for both platforms.
var _ = []any{tunIP6, routes4, routes6}
