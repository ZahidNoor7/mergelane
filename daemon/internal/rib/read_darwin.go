package rib

import (
	"net"
	"net/netip"
	"strconv"
	"syscall"

	"golang.org/x/net/route"
)

// Read dumps the whole routing table, both families and scoped routes included, with the same
// sysctl (NET_RT_DUMP) that nics.DefaultRoutes reads. It only reads; no privileges needed.
func Read() ([]Route, error) {
	b, err := route.FetchRIB(syscall.AF_UNSPEC, route.RIBTypeRoute, 0)
	if err != nil {
		return nil, err
	}
	msgs, err := route.ParseRIB(route.RIBTypeRoute, b)
	if err != nil {
		return nil, err
	}
	// One interface listing per dump, not one lookup per route: the guard reads the table every second.
	names := map[int]string{}
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, ifc := range ifs {
		names[ifc.Index] = ifc.Name
	}
	return fromMessages(msgs, func(i int) string { return names[i] }), nil
}

// fromMessages converts parsed routing messages, in table order. Entries that are not IPv4/IPv6 routes,
// or whose interface has no name (it went away mid-dump), are skipped.
func fromMessages(msgs []route.Message, name func(index int) string) []Route {
	var out []Route
	for _, m := range msgs {
		if rm, ok := m.(*route.RouteMessage); ok {
			if r, ok := fromMessage(rm, name); ok {
				out = append(out, r)
			}
		}
	}
	return out
}

// fromMessage ignores rm.Err on purpose: x/net (v0.56.0, route_classic.go) reads it from bytes 28-32 of
// the header, which in darwin's struct rt_msghdr (<net/route.h>) is rtm_use, not rtm_errno (24-28). So
// on a table dump Err is the route's use count, and skipping messages with Err set would hide exactly the
// busy routes, such as another VPN's 0/1.
func fromMessage(rm *route.RouteMessage, name func(index int) string) (Route, bool) {
	if len(rm.Addrs) <= syscall.RTAX_DST {
		return Route{}, false
	}
	iface := name(rm.Index)
	if iface == "" {
		return Route{}, false
	}
	var dst netip.Addr
	switch a := rm.Addrs[syscall.RTAX_DST].(type) {
	case *route.Inet4Addr:
		dst = netip.AddrFrom4(a.IP)
	case *route.Inet6Addr:
		dst = netip.AddrFrom16(a.IP) // x/net already cleared the KAME-embedded scope of link-local ones
	default:
		return Route{}, false // AF_LINK and other families
	}
	flags := uint(rm.Flags)
	bits := dst.BitLen()
	if flags&FlagHost == 0 {
		var mask route.Addr
		if len(rm.Addrs) > syscall.RTAX_NETMASK {
			mask = rm.Addrs[syscall.RTAX_NETMASK]
		}
		if bits = maskBits(mask, dst.Is4()); bits < 0 {
			return Route{}, false
		}
	}
	r := Route{Dst: netip.PrefixFrom(dst, bits), Iface: iface, Flags: flags}
	if len(rm.Addrs) > syscall.RTAX_GATEWAY {
		r.Gateway = gateway(rm.Addrs[syscall.RTAX_GATEWAY], rm.Index, iface, name)
	}
	return r, true
}

// maskBits is the prefix length of a netmask in the kernel's form. Like nics.zeroMask, a network
// route without a netmask counts as /0: that is how the kernel reports a default route. It returns -1
// for a non-contiguous mask or one of the other family.
func maskBits(a route.Addr, v4 bool) int {
	var m net.IPMask
	switch a := a.(type) {
	case nil:
		return 0
	case *route.Inet4Addr:
		if !v4 {
			return -1
		}
		m = net.IPMask(a.IP[:])
	case *route.Inet6Addr:
		if v4 {
			return -1
		}
		m = net.IPMask(a.IP[:])
	default:
		return -1
	}
	ones, total := m.Size()
	if total == 0 {
		return -1
	}
	return ones
}

// gateway formats a next hop the way route(8) accepts it back: an IPv6 link-local gateway carries its
// zone ("fe80::1%en0"), and a link without a link-layer address is "link#N", as netstat shows it.
func gateway(a route.Addr, index int, iface string, name func(int) string) string {
	switch g := a.(type) {
	case *route.Inet4Addr:
		return netip.AddrFrom4(g.IP).String()
	case *route.Inet6Addr:
		ip := netip.AddrFrom16(g.IP)
		if ip.IsLinkLocalUnicast() {
			zone := iface
			if z := name(g.ZoneID); g.ZoneID != 0 && z != "" {
				zone = z
			}
			ip = ip.WithZone(zone)
		}
		return ip.String()
	case *route.LinkAddr:
		if len(g.Addr) > 0 {
			return net.HardwareAddr(g.Addr).String()
		}
		if g.Index != 0 {
			index = g.Index
		}
		return "link#" + strconv.Itoa(index)
	}
	return ""
}
