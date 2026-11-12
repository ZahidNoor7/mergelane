// Package rib is a read-only view of the routing table: the Route type that the VPN guard (vpnguard)
// and the route marker (routemark) share, and Read, which dumps the table (macOS: read_darwin.go;
// Windows: read_windows.go, through windows.go).
//
// It is its own package so that both users get the same Route and the same reader, while their logic
// stays pure and testable against recorded tables.
package rib

import (
	"fmt"
	"net/netip"
)

// Route flags (RTF_*), from <net/route.h> in the macOS SDK. They are literals rather than
// golang.org/x/sys/unix constants so the pure code here and in its users needs no OS-specific import;
// TestFlagsMatchSDK checks them against unix.RTF_* on darwin.
const (
	FlagGateway = 0x2       // RTF_GATEWAY: the next hop is a gateway address, not the link itself
	FlagHost    = 0x4       // RTF_HOST: a host entry (no netmask)
	FlagLLInfo  = 0x400     // RTF_LLINFO: an ARP or neighbour-discovery entry
	FlagStatic  = 0x800     // RTF_STATIC: added by hand; route(8) sets it on every route it adds
	FlagProto2  = 0x4000    // RTF_PROTO2: route(8)'s -proto2; XNU also names it RTF_ANNOUNCE (published ARP/ND entries)
	FlagIfscope = 0x1000000 // RTF_IFSCOPE: scoped, used only by sockets bound to Iface (IP_BOUND_IF)
)

// Route is one routing-table entry.
type Route struct {
	Dst     netip.Prefix // destination; Bits() == 0 for a default route, the full length for a host entry
	Gateway string       // next hop: an IP ("192.168.1.1", "fe80::1%en0"), "link#N", or a link-layer address
	Iface   string       // outgoing interface, e.g. "en0", "utun4"; on Windows the adapter's alias, e.g. "Wi-Fi"
	Flags   uint         // RTF_* bits; see the Flag constants (always 0 on Windows)
	// Tunnel says the route belongs to a tunnel or VPN where the interface's name can't say so: on
	// Windows, set by FromWindows. On macOS the VPN guard tells tunnels by their names.
	Tunnel bool
}

// Scoped reports whether the route only serves sockets bound to its interface (RTF_IFSCOPE, netstat's I).
func (r Route) Scoped() bool { return r.Flags&FlagIfscope != 0 }

// String is a netstat-like one-liner for logs and test failures.
func (r Route) String() string {
	return fmt.Sprintf("%s via %s on %s flags %#x", r.Dst, r.Gateway, r.Iface, r.Flags)
}
