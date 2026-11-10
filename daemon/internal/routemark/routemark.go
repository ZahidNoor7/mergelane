// Package routemark marks the routes the daemon adds, and finds them again (ADR-0006).
//
// Every route the daemon adds goes in with route(8)'s -proto2 modifier, which sets RTF_PROTO2 on the
// kernel's entry (XNU keeps the flags it is given, rt_flags = RTF_UP | flags, and reports them in
// table dumps). Cleanup then removes only routes that carry the marker and have the shape of one we add,
// so it never touches a route macOS, a VPN or the user made.
//
// XNU also uses RTF_PROTO2, under the name RTF_ANNOUNCE, for published proxy-ARP and proxy-NDP entries
// (`arp -s ... pub`, `ndp -s ... proxy`); `arp -s ... pub` even stores them as /32 network routes. So
// the marker alone is not proof: Marked also requires the shape of our routes.
//
// Everything here is pure; the argument lists are for /sbin/route (without the program name).
package routemark

import (
	"cmp"
	"net/netip"
	"slices"
	"strings"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// Route is a routing-table entry, shared with vpnguard through package rib.
type Route = rib.Route

// Flag is the marker: RTF_PROTO2 (0x4000 in the SDK's <net/route.h>, unix.RTF_PROTO2 in x/sys), which
// route(8)'s -proto2 sets.
const Flag = rib.FlagProto2

// Capture is a capture route: dst goes straight into the tunnel iface (route ... -interface iface).
func Capture(dst netip.Prefix, iface string) Route {
	return Route{Dst: dst, Iface: iface, Flags: rib.FlagStatic | Flag}
}

// ScopedDefault is a default route via gw that only sockets bound to iface use (route ... -ifscope
// iface). An IPv6 gateway gets iface as its zone unless it has one, as upstream's scopedArgs did.
func ScopedDefault(v6 bool, gw, iface string) Route {
	dst := netip.PrefixFrom(netip.IPv4Unspecified(), 0)
	if v6 {
		dst = netip.PrefixFrom(netip.IPv6Unspecified(), 0)
		if !strings.Contains(gw, "%") {
			gw += "%" + iface
		}
	}
	return Route{Dst: dst, Gateway: gw, Iface: iface, Flags: rib.FlagGateway | rib.FlagIfscope | rib.FlagStatic | Flag}
}

// AddArgs adds r with the marker:
//
//	-q -n add -inet 0.0.0.0/1 -interface utun4 -proto2
//	-q -n add -inet6 default fe80::1%en0 -ifscope en0 -proto2
func AddArgs(r Route) []string { return append(args("add", r), "-proto2") }

// DeleteArgs deletes r. It has no -proto2: XNU's RTM_DELETE finds the entry by destination and netmask
// (and the scope, for -ifscope) only, so the marker does not matter there.
func DeleteArgs(r Route) []string { return args("delete", r) }

// args follows upstream's argument order, so a capture route still reads
// "-q -n <verb> -inet <dst> -interface <iface>" and a scoped default "-q -n <verb> -inet default <gw> -ifscope <iface>".
func args(verb string, r Route) []string {
	a := []string{"-q", "-n", verb, "-inet"}
	if r.Dst.Addr().Is6() {
		a[3] = "-inet6"
	}
	switch {
	case r.Dst.Bits() == 0:
		a = append(a, "default")
	case r.Flags&rib.FlagHost != 0:
		a = append(a, "-host", r.Dst.Addr().String())
	default:
		a = append(a, r.Dst.String())
	}
	if r.Flags&rib.FlagGateway != 0 {
		a = append(a, r.Gateway)
	} else {
		a = append(a, "-interface", r.Iface)
	}
	if r.Scoped() {
		a = append(a, "-ifscope", r.Iface)
	}
	return a
}

// Marked returns, in order, the routes that carry Flag and have the shape of a route the daemon adds:
// a default or a /1 half, never a host or link-layer (ARP/ND) entry. A published proxy-ARP entry also
// carries RTF_PROTO2, but is a /32 or a host route.
func Marked(routes []Route) []Route {
	var out []Route
	for _, r := range routes {
		if r.Flags&Flag != 0 && r.Flags&(rib.FlagHost|rib.FlagLLInfo) == 0 && r.Dst.IsValid() && r.Dst.Bits() <= 1 {
			out = append(out, r)
		}
	}
	return out
}

// Leftovers returns the marked routes that cleanup should delete. That is all of Marked, except a
// scoped default on an adapter with no unscoped default of that family: the adapter is not the primary
// service, so macOS wants a scoped default there itself, and ours (left in place on purpose when the
// adapter stopped being primary, see syncScoped and #20) is standing in for the one macOS could not add.
// Deleting it would leave the adapter without a default route until it reconnects.
func Leftovers(routes []Route) []Route {
	type fam struct {
		iface string
		v6    bool
	}
	primary := map[fam]bool{}
	for _, r := range routes {
		if r.Dst.IsValid() && r.Dst.Bits() == 0 && !r.Scoped() {
			primary[fam{r.Iface, r.Dst.Addr().Is6()}] = true
		}
	}
	var out []Route
	for _, r := range Marked(routes) {
		if r.Scoped() && r.Dst.Bits() == 0 && !primary[fam{r.Iface, r.Dst.Addr().Is6()}] {
			continue
		}
		out = append(out, r)
	}
	return out
}

// Installed returns those of want that table holds as such: same destination, interface and scoping.
// Deleting by destination takes whatever entry holds it (see DeleteArgs), so this keeps a delete from
// hitting another VPN's route that replaced ours.
func Installed(table, want []Route) []Route {
	var out []Route
	for _, w := range want {
		if slices.ContainsFunc(table, func(t Route) bool {
			return t.Dst == w.Dst && t.Iface == w.Iface && t.Scoped() == w.Scoped()
		}) {
			out = append(out, w)
		}
	}
	return out
}

// CleanupCommands returns the /sbin/route argument lists that delete routes (Leftovers' result). Capture
// routes come first, so capture stops before the scoped defaults that pinned sockets rely on go:
// configure adds them in the opposite order.
func CleanupCommands(routes []Route) [][]string {
	sorted := slices.Clone(routes)
	slices.SortStableFunc(sorted, func(a, b Route) int {
		return cmp.Compare(boolInt(a.Scoped()), boolInt(b.Scoped()))
	})
	out := make([][]string, 0, len(sorted))
	for _, r := range sorted {
		out = append(out, DeleteArgs(r))
	}
	return out
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
