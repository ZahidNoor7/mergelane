package rib

import (
	"encoding/binary"
	"net/netip"
	"reflect"
	"testing"
)

func sockaddr4(a string) [28]byte {
	var b [28]byte
	binary.LittleEndian.PutUint16(b[0:2], winAFInet)
	ip := netip.MustParseAddr(a).As4()
	copy(b[4:8], ip[:])
	return b
}

func sockaddr6(a string, scope uint32) [28]byte {
	var b [28]byte
	binary.LittleEndian.PutUint16(b[0:2], winAFInet6)
	binary.LittleEndian.PutUint32(b[4:8], 0x12345) // flow info, ignored
	ip := netip.MustParseAddr(a).As16()
	copy(b[8:24], ip[:])
	binary.LittleEndian.PutUint32(b[24:28], scope)
	return b
}

func TestSockaddrAddr(t *testing.T) {
	if got := SockaddrAddr(sockaddr4("192.168.1.1")); got != netip.MustParseAddr("192.168.1.1") {
		t.Errorf("IPv4: %v", got)
	}
	if got := SockaddrAddr(sockaddr6("fe80::1", 7)); got != netip.MustParseAddr("fe80::1") {
		t.Errorf("IPv6 (zone dropped): %v", got)
	}
	if got := SockaddrAddr(sockaddr4("0.0.0.0")); !got.IsUnspecified() || !got.Is4() {
		t.Errorf("unspecified IPv4: %v", got)
	}
	var other [28]byte
	binary.LittleEndian.PutUint16(other[0:2], 1) // AF_UNIX
	if got := SockaddrAddr(other); got.IsValid() {
		t.Errorf("another family gave %v, want the zero Addr", got)
	}
}

func TestPhysicalIfType(t *testing.T) {
	for typ, want := range map[uint32]bool{6: true, 71: true, 243: true, 244: true, 117: true,
		23: false, 53: false, 131: false, 24: false} {
		if got := PhysicalIfType(typ); got != want {
			t.Errorf("PhysicalIfType(%d) = %v, want %v", typ, got, want)
		}
	}
}

// A PC on Wi-Fi with a WireGuard tunnel (Wintun, type 53) holding the default route, an OpenVPN TAP
// adapter (Ethernet type) splitting it in two, and a route on an adapter Windows didn't list.
func TestFromWindows(t *testing.T) {
	adapters := map[uint32]Adapter{
		12: {Alias: "Wi-Fi", IfType: 71, Up: true},
		30: {Alias: "WireGuard Tunnel", IfType: 53, Up: true},
		44: {Alias: "OpenVPN TAP-Windows6", IfType: 6, Up: true},
	}
	p := netip.MustParsePrefix
	a := netip.MustParseAddr
	rows := []WinRow{
		{Index: 12, Dst: p("0.0.0.0/0"), NextHop: a("192.168.1.1")},
		{Index: 12, Dst: p("192.168.1.0/24"), NextHop: a("0.0.0.0")},
		{Index: 30, Dst: p("0.0.0.0/0"), NextHop: a("0.0.0.0")},
		{Index: 30, Dst: p("::/0"), NextHop: a("::")},
		{Index: 44, Dst: p("0.0.0.0/1"), NextHop: a("10.8.0.1")},
		{Index: 44, Dst: p("128.0.0.0/1"), NextHop: a("10.8.0.1")},
		{Index: 99, Dst: p("10.0.0.0/8"), NextHop: netip.Addr{}},
		{Index: 12, Dst: netip.Prefix{}}, // skipped
	}
	want := []Route{
		{Dst: p("0.0.0.0/0"), Gateway: "192.168.1.1", Iface: "Wi-Fi"},
		{Dst: p("192.168.1.0/24"), Gateway: "link#12", Iface: "Wi-Fi"},
		{Dst: p("0.0.0.0/0"), Gateway: "link#30", Iface: "WireGuard Tunnel", Tunnel: true},
		{Dst: p("::/0"), Gateway: "link#30", Iface: "WireGuard Tunnel", Tunnel: true},
		{Dst: p("0.0.0.0/1"), Gateway: "10.8.0.1", Iface: "OpenVPN TAP-Windows6", Tunnel: true},
		{Dst: p("128.0.0.0/1"), Gateway: "10.8.0.1", Iface: "OpenVPN TAP-Windows6", Tunnel: true},
		{Dst: p("10.0.0.0/8"), Gateway: "link#99", Iface: "if99"},
	}
	if got := FromWindows(rows, adapters); !reflect.DeepEqual(got, want) {
		t.Errorf("FromWindows:\n got %v\nwant %v", got, want)
	}
}

func TestConnectedPPP(t *testing.T) {
	adapters := map[uint32]Adapter{
		1: {Alias: "Work VPN", IfType: IfTypePPP, Up: true},
		2: {Alias: "Work VPN", IfType: IfTypePPP, Up: true}, // the same adapter's IPv6 index
		3: {Alias: "Old dial-up", IfType: IfTypePPP, Up: false},
		4: {Alias: "Wi-Fi", IfType: 71, Up: true},
		5: {Alias: "", IfType: IfTypePPP, Up: true},
		6: {Alias: "Another VPN", IfType: IfTypePPP, Up: true},
	}
	if got, want := ConnectedPPP(adapters), []string{"Another VPN", "Work VPN"}; !reflect.DeepEqual(got, want) {
		t.Errorf("ConnectedPPP = %v, want %v", got, want)
	}
	if got := ConnectedPPP(nil); got != nil {
		t.Errorf("ConnectedPPP(nil) = %v, want nil", got)
	}
}
