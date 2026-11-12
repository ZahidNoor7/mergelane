package rib

import (
	"encoding/binary"
	"net/netip"
	"slices"
	"strconv"
)

// The Windows routing table, in a form the pure code below can turn into Routes on any OS, so the
// conversion is tested on the Mac (windows_test.go) while read_windows.go only reads.

// Address families in a SOCKADDR_INET, as Windows numbers them (ws2def.h): AF_INET6 is 23 there.
const (
	winAFInet  = 2
	winAFInet6 = 23
)

// IfTypePPP is IANA's ifType for PPP (ipifcons.h IF_TYPE_PPP): Windows' own VPN connections (IKEv2,
// SSTP, L2TP, PPTP) and dial-up appear as PPP adapters while they are connected.
const IfTypePPP = 23

// PhysicalIfType reports whether an IANA ifType is real network hardware: Ethernet (with its fast
// and gigabit variants), Wi-Fi and mobile broadband. Tunnels (131), PPP (23), "proprietary virtual"
// (53, most VPN drivers, Wintun included) and software loopback (24) are not.
func PhysicalIfType(t uint32) bool {
	switch t {
	case 6, 62, 69, 117, // ethernet (incl. fast / gigabit variants)
		71,       // IEEE 802.11 Wi-Fi
		243, 244: // mobile broadband (WWAN)
		return true
	}
	return false
}

// Adapter is what the routing-table code needs to know about a Windows adapter.
type Adapter struct {
	Alias  string // its name in Settings and `Get-NetAdapter`, e.g. "Wi-Fi", "Ethernet 2"
	IfType uint32 // IANA ifType
	Up     bool   // operationally up
}

// WinRow is one row of Windows' routing table (MIB_IPFORWARD_ROW2), reduced to what Routes need.
type WinRow struct {
	Index   uint32       // InterfaceIndex
	Dst     netip.Prefix // DestinationPrefix
	NextHop netip.Addr   // unspecified (0.0.0.0 or ::) for an on-link route
}

// FromWindows turns Windows' routing table into Routes:
//   - Iface is the adapter's alias, or "if<index>" for an adapter Windows didn't list;
//   - Gateway is the next hop, or "link#<index>" for an on-link route, as netstat writes it on macOS;
//   - Tunnel is set when the adapter isn't network hardware (PhysicalIfType), or when the route is one
//     half of the address space (a /1): OpenVPN's TAP adapter calls itself Ethernet, but only a VPN
//     splits the default route in two. A plain default route (/0) on hardware is just the network's.
//
// Windows has no scoped routes like macOS's RTF_IFSCOPE, so Flags stays 0.
func FromWindows(rows []WinRow, adapters map[uint32]Adapter) []Route {
	out := make([]Route, 0, len(rows))
	for _, r := range rows {
		if !r.Dst.IsValid() {
			continue
		}
		a, known := adapters[r.Index]
		iface := a.Alias
		if !known || iface == "" {
			iface = "if" + strconv.FormatUint(uint64(r.Index), 10)
		}
		gateway := "link#" + strconv.FormatUint(uint64(r.Index), 10)
		if r.NextHop.IsValid() && !r.NextHop.IsUnspecified() {
			gateway = r.NextHop.String()
		}
		out = append(out, Route{
			Dst:     r.Dst,
			Gateway: gateway,
			Iface:   iface,
			Tunnel:  (known && !PhysicalIfType(a.IfType)) || r.Dst.Bits() == 1,
		})
	}
	return out
}

// ConnectedPPP lists the PPP adapters that are up (Windows' own VPN connections and dial-up), by alias,
// sorted.
func ConnectedPPP(adapters map[uint32]Adapter) []string {
	var names []string
	for _, a := range adapters {
		if a.Up && a.IfType == IfTypePPP && a.Alias != "" {
			names = append(names, a.Alias)
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// SockaddrAddr reads the address out of a SOCKADDR_INET's 28 bytes: the family (little-endian), then a
// sockaddr_in (port, 4-byte address) or a sockaddr_in6 (port, flow info, 16-byte address, scope id). An
// IPv6 address keeps no zone: Routes compare addresses, and a route's interface is in Iface. Any other
// family gives the zero Addr.
func SockaddrAddr(b [28]byte) netip.Addr {
	switch binary.LittleEndian.Uint16(b[0:2]) {
	case winAFInet:
		return netip.AddrFrom4([4]byte(b[4:8]))
	case winAFInet6:
		return netip.AddrFrom16([16]byte(b[8:24]))
	}
	return netip.Addr{}
}
