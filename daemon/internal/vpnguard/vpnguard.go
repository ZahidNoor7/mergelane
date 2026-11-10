// Package vpnguard decides whether another VPN is active, so that system-wide merging never installs
// its routes over another VPN's (CLAUDE.md, "Coexist with VPNs"). The daemon checks it before enabling
// and while enabled.
//
// Two signals, because neither is enough alone (ADR-0017): a VPN made from a plain process's utun is
// not listed by `scutil --nc list`, so the routing table is read too; and macOS keeps utun interfaces
// of its own, so a utun only counts when it carries a route that takes all traffic.
//
// Conflicts and ParseNCList are pure; ReadRoutes and ReadNCConnected are the thin readers that feed them.
package vpnguard

import (
	"cmp"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// Route is a routing-table entry, shared with routemark through package rib.
type Route = rib.Route

// Kind says which signal found a conflict.
type Kind int

const (
	// KindRoute: a tunnel interface that is not ours carries a route that takes all traffic of a family.
	KindRoute Kind = iota + 1
	// KindService: `scutil --nc list` shows a VPN service that is on.
	KindService
)

func (k Kind) String() string {
	switch k {
	case KindRoute:
		return "route"
	case KindService:
		return "service"
	}
	return "Kind(" + strconv.Itoa(int(k)) + ")"
}

// Conflict is one reason system-wide merging must stay off.
type Conflict struct {
	Kind      Kind
	Interface string         // KindRoute: the tunnel, e.g. "utun4"
	Service   string         // KindService: the service's name as scutil shows it
	Routes    []netip.Prefix // KindRoute: the all-traffic routes found on Interface, sorted
}

// Message is a plain-English reason for the user, ending with what to do.
func (c Conflict) Message() string {
	const fix = " Turn it off to use system-wide merging."
	if c.Kind == KindService {
		return "The VPN “" + c.Service + "” is on." + fix
	}
	var v4, v6 bool
	for _, p := range c.Routes {
		v4, v6 = v4 || p.Addr().Is4(), v6 || p.Addr().Is6()
	}
	traffic := "all traffic"
	switch {
	case v4 && !v6:
		traffic = "all IPv4 traffic"
	case v6 && !v4:
		traffic = "all IPv6 traffic"
	}
	who := "Another VPN (" + c.Interface + ")"
	switch prefix, _ := splitName(c.Interface); prefix {
	case "ipsec":
		who = "An IPsec VPN (" + c.Interface + ")"
	case "ppp":
		who = "A PPP connection (" + c.Interface + ")"
	}
	return who + " is routing " + traffic + "." + fix
}

// tunnelName matches the interfaces a VPN can use on macOS:
//   - utunN: every Network Extension VPN, and wireguard-go, OpenVPN 3, tailscaled, etc. from a plain process
//     (wireguard-go's tun_darwin.go only accepts "utun[0-9]*");
//   - ipsecN: the built-in IKEv2/IPsec client;
//   - pppN: the built-in L2TP/PPTP clients (and PPPoE, which merging cannot run alongside either);
//   - tunN/tapN: the legacy tuntaposx kernel extension (older Tunnelblick/OpenVPN set-ups).
//
// wgN is left out: macOS has no such interfaces, WireGuard there always uses a utun.
var tunnelName = regexp.MustCompile(`^(utun|ipsec|ppp|tun|tap)[0-9]+$`)

// Conflicts lists why system-wide merging must stay off; none means it may turn on.
//
// A route conflicts when it is on a tunnel interface (tunnelName) for which ours returns false, is not
// scoped, and takes all traffic of its family: a default (0.0.0.0/0, ::/0) or one of the /1 halves
// (0.0.0.0/1, 128.0.0.0/1, ::/1, 8000::/1). Scoped routes (RTF_IFSCOPE) are ignored: they only serve
// sockets bound to that interface, so they capture nothing and our routes cannot override them, and
// macOS itself gives every utun of its own a scoped IPv6 default ("default fe80::%utunN UGcIg" with no
// VPN at all), so counting them would block merging on every Mac.
//
// Every name in ncConnected (from ParseNCList) conflicts too.
//
// Order is deterministic: services first (they carry a name the user recognises), sorted, then
// interfaces in natural order (ipsec0, ppp0, utun4, utun10), each with its routes sorted.
func Conflicts(routes []Route, ours func(iface string) bool, ncConnected []string) []Conflict {
	var out []Conflict
	services := slices.Clone(ncConnected)
	slices.Sort(services)
	for _, s := range slices.Compact(services) {
		if s != "" {
			out = append(out, Conflict{Kind: KindService, Service: s})
		}
	}
	byIface := map[string][]netip.Prefix{}
	for _, r := range routes {
		if !r.Dst.IsValid() || r.Dst.Bits() > 1 || r.Scoped() || !tunnelName.MatchString(r.Iface) {
			continue
		}
		if ours != nil && ours(r.Iface) {
			continue
		}
		byIface[r.Iface] = append(byIface[r.Iface], r.Dst)
	}
	ifaces := make([]string, 0, len(byIface))
	for name := range byIface {
		ifaces = append(ifaces, name)
	}
	slices.SortFunc(ifaces, naturalCompare)
	for _, name := range ifaces {
		ps := byIface[name]
		slices.SortFunc(ps, netip.Prefix.Compare)
		out = append(out, Conflict{Kind: KindRoute, Interface: name, Routes: slices.Compact(ps)})
	}
	return out
}

// splitName splits "utun10" into "utun" and 10.
func splitName(s string) (string, int) {
	i := len(s)
	for i > 0 && s[i-1] >= '0' && s[i-1] <= '9' {
		i--
	}
	n, _ := strconv.Atoi(s[i:])
	return s[:i], n
}

func naturalCompare(a, b string) int {
	pa, na := splitName(a)
	pb, nb := splitName(b)
	return cmp.Or(strings.Compare(pa, pb), cmp.Compare(na, nb), strings.Compare(a, b))
}

// ParseNCList returns, in output order, the names of the services in `scutil --nc list` output that
// are on: "Connected", and also "Connecting" and "Disconnecting", because then the VPN's routes may be
// in place (or about to be) and merging must not race it. "Disconnected", "Invalid" and "Unknown" are off.
//
// configd's nc.c prints each service as
//
//	<* or space> (<status>)<pad to 16> <service ID> <interface name><pad to 18> "<name>"<pad> [<type>[:<subtype>]]
//
// The padding uses CFStringPad, which also cuts: a name of 31 characters or more loses its closing quote
// (and, from 32, its last character). So the name is read from the first quote up to the closing quote,
// or else up to the " [type]" suffix, and the interface name, which may contain spaces, is never split on.
func ParseNCList(output string) []string {
	var on []string
	for _, line := range strings.Split(output, "\n") {
		// The header ("Available network connection services in the current set (*=enabled):") and any
		// other line that is not a service do not start with "(" once the enabled mark is gone.
		s := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "*"))
		if !strings.HasPrefix(s, "(") {
			continue
		}
		status, rest, ok := strings.Cut(s[1:], ")")
		if !ok {
			continue
		}
		switch strings.TrimSpace(status) {
		case "Connected", "Connecting", "Disconnecting":
		default:
			continue
		}
		if name := serviceName(rest); name != "" {
			on = append(on, name)
		}
	}
	return on
}

// serviceName takes what follows the status: `<id> <interface> "<name>" [<type>]`.
func serviceName(rest string) string {
	_, quoted, ok := strings.Cut(rest, `"`)
	if !ok {
		// No quoted name at all; fall back to the service ID so the conflict still shows.
		if f := strings.Fields(rest); len(f) > 0 {
			return f[0]
		}
		return ""
	}
	q := strings.TrimRight(quoted, " \t")
	// Drop the " [type:subtype]" suffix: the last "[" after a blank, with the line ending in "]".
	if i := strings.LastIndex(q, "["); i > 0 && strings.HasSuffix(q, "]") && (q[i-1] == ' ' || q[i-1] == '\t') {
		q = strings.TrimRight(q[:i], " \t")
	}
	return strings.TrimSuffix(q, `"`)
}
