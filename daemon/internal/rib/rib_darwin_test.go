package rib

import (
	"encoding/binary"
	"net/netip"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/net/route"
	"golang.org/x/sys/unix"
)

// The literals in rib.go come from the SDK's <net/route.h>; x/sys generates its values from the same header.
func TestFlagsMatchSDK(t *testing.T) {
	for _, c := range []struct {
		name      string
		got, want uint
	}{
		{"RTF_GATEWAY", FlagGateway, unix.RTF_GATEWAY},
		{"RTF_HOST", FlagHost, unix.RTF_HOST},
		{"RTF_LLINFO", FlagLLInfo, unix.RTF_LLINFO},
		{"RTF_STATIC", FlagStatic, unix.RTF_STATIC},
		{"RTF_PROTO2", FlagProto2, unix.RTF_PROTO2},
		{"RTF_IFSCOPE", FlagIfscope, unix.RTF_IFSCOPE},
	} {
		if c.got != c.want {
			t.Errorf("%s = %#x, x/sys says %#x", c.name, c.got, c.want)
		}
	}
}

// Interface indexes as on the Mac these fixtures were taken from (netstat -rn: link#14 is en0).
var names = map[int]string{1: "lo0", 14: "en0", 18: "utun0", 22: "utun4"}

func name(i int) string { return names[i] }

func v4(a, b, c, d byte) *route.Inet4Addr { return &route.Inet4Addr{IP: [4]byte{a, b, c, d}} }

func v6(s string, zone int) *route.Inet6Addr {
	return &route.Inet6Addr{IP: netip.MustParseAddr(s).As16(), ZoneID: zone}
}

func msg(index int, flags int, dst, gw, mask route.Addr) *route.RouteMessage {
	return &route.RouteMessage{Index: index, Flags: flags, Addrs: []route.Addr{dst, gw, mask}}
}

func TestFromMessage(t *testing.T) {
	const (
		u, g, s, h, l = syscall.RTF_UP, FlagGateway, FlagStatic, FlagHost, FlagLLInfo
		i, p2         = FlagIfscope, FlagProto2
	)
	for _, c := range []struct {
		name string
		in   *route.RouteMessage
		want Route
		ok   bool
	}{
		{"IPv4 default (UGSc en0)", msg(14, u|g|s, v4(0, 0, 0, 0), v4(192, 168, 1, 1), nil),
			Route{netip.MustParsePrefix("0.0.0.0/0"), "192.168.1.1", "en0", u | g | s, false}, true},
		{"zero-length mask is /0 too", msg(14, u|g|s, v4(0, 0, 0, 0), v4(192, 168, 1, 1), v4(0, 0, 0, 0)),
			Route{netip.MustParsePrefix("0.0.0.0/0"), "192.168.1.1", "en0", u | g | s, false}, true},
		{"macOS's scoped IPv6 default on a utun (UGcIg)", msg(18, u|g|i, v6("::", 0), v6("fe80::", 18), nil),
			Route{netip.MustParsePrefix("::/0"), "fe80::%utun0", "utun0", u | g | i, false}, true},
		{"link-local gateway without a zone gets the route's interface", msg(14, u|g|i, v6("::", 0), v6("fe80::1", 0), nil),
			Route{netip.MustParsePrefix("::/0"), "fe80::1%en0", "en0", u | g | i, false}, true},
		{"unknown zone index falls back to the route's interface", msg(14, u|g|i, v6("::", 0), v6("fe80::1", 99), nil),
			Route{netip.MustParsePrefix("::/0"), "fe80::1%en0", "en0", u | g | i, false}, true},
		{"global IPv6 gateway has no zone", msg(14, u|g, v6("2001:db8::", 0), v6("2001:db8::1", 0), v6("ffff:ffff::", 0)),
			Route{netip.MustParsePrefix("2001:db8::/32"), "2001:db8::1", "en0", u | g, false}, true},
		{"capture route 0/1 (route add -interface utun4 -proto2)",
			msg(22, u|s|p2, v4(0, 0, 0, 0), &route.LinkAddr{Index: 22, Name: "utun4"}, v4(128, 0, 0, 0)),
			Route{netip.MustParsePrefix("0.0.0.0/1"), "link#22", "utun4", u | s | p2, false}, true},
		{"capture route 8000::/1", msg(22, u|s, v6("8000::", 0), &route.LinkAddr{Index: 22}, v6("8000::", 0)),
			Route{netip.MustParsePrefix("8000::/1"), "link#22", "utun4", u | s, false}, true},
		{"link gateway without an index uses the route's", msg(14, u|s, v4(192, 168, 1, 0), &route.LinkAddr{}, v4(255, 255, 255, 0)),
			Route{netip.MustParsePrefix("192.168.1.0/24"), "link#14", "en0", u | s, false}, true},
		{"host route has no netmask", msg(1, u|h, v4(127, 0, 0, 1), v4(127, 0, 0, 1), nil),
			Route{netip.MustParsePrefix("127.0.0.1/32"), "127.0.0.1", "lo0", u | h, false}, true},
		{"ARP entry has a MAC gateway", msg(14, u|h|l, v4(192, 168, 1, 1), &route.LinkAddr{Index: 14, Addr: []byte{0xf4, 0xe8, 0x4f, 0xdf, 0xcb, 0x76}}, nil),
			Route{netip.MustParsePrefix("192.168.1.1/32"), "f4:e8:4f:df:cb:76", "en0", u | h | l, false}, true},
		{"no gateway at all", &route.RouteMessage{Index: 14, Flags: u | h, Addrs: []route.Addr{v4(10, 0, 0, 1)}},
			Route{netip.MustParsePrefix("10.0.0.1/32"), "", "en0", u | h, false}, true},
		{"unknown gateway type", msg(14, u|g, v4(0, 0, 0, 0), &route.DefaultAddr{}, nil),
			Route{netip.MustParsePrefix("0.0.0.0/0"), "", "en0", u | g, false}, true},

		{"non-contiguous mask", msg(14, u, v4(10, 0, 0, 0), v4(10, 0, 0, 1), v4(255, 0, 255, 0)), Route{}, false},
		{"IPv6 mask on an IPv4 route", msg(14, u, v4(10, 0, 0, 0), v4(10, 0, 0, 1), v6("ffff::", 0)), Route{}, false},
		{"IPv4 mask on an IPv6 route", msg(14, u, v6("2001:db8::", 0), v6("2001:db8::1", 0), v4(255, 0, 0, 0)), Route{}, false},
		{"mask of another family", msg(14, u, v4(10, 0, 0, 0), v4(10, 0, 0, 1), &route.LinkAddr{}), Route{}, false},
		{"AF_LINK destination", msg(14, u, &route.LinkAddr{Index: 14}, nil, nil), Route{}, false},
		{"interface gone", msg(77, u|g, v4(0, 0, 0, 0), v4(10, 0, 0, 1), nil), Route{}, false},
		// x/net fills Err from rtm_use on darwin, so a busy route has one; it must still be read.
		{"busy route (x/net's Err is rtm_use)", &route.RouteMessage{Index: 22, Flags: u | s, Err: syscall.Errno(4722),
			Addrs: []route.Addr{v4(0, 0, 0, 0), &route.LinkAddr{Index: 22}, v4(128, 0, 0, 0)}},
			Route{netip.MustParsePrefix("0.0.0.0/1"), "link#22", "utun4", u | s, false}, true},
		{"no addresses", &route.RouteMessage{Index: 14}, Route{}, false},
	} {
		got, ok := fromMessage(c.in, name)
		if ok != c.ok || got != c.want {
			t.Errorf("%s:\n got  %v (%v)\n want %v (%v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestFromMessagesSkipsOtherMessages(t *testing.T) {
	got := fromMessages([]route.Message{
		&route.InterfaceMessage{Index: 14},
		msg(14, FlagGateway, v4(0, 0, 0, 0), v4(192, 168, 1, 1), nil),
		msg(77, FlagGateway, v4(0, 0, 0, 0), v4(10, 0, 0, 1), nil),
	}, name)
	if len(got) != 1 || got[0].Iface != "en0" {
		t.Errorf("got %v, want just the en0 default", got)
	}
}

// rtMsg encodes one route the way the kernel's NET_RT_DUMP does: a struct rt_msghdr (<net/route.h>;
// 92 bytes, as in x/net's zsys_darwin.go) followed by 4-byte-aligned sockaddrs, the netmask in the
// kernel's compact form (sa_len covers only the significant bytes; see x/net's address_darwin_test.go).
func rtMsg(index uint16, flags uint32, sockaddrs ...[]byte) []byte {
	const hdr = 92
	var body []byte
	for _, sa := range sockaddrs {
		body = append(body, sa...)
		for len(body)%4 != 0 {
			body = append(body, 0)
		}
	}
	b := make([]byte, hdr, hdr+len(body))
	binary.LittleEndian.PutUint16(b[0:2], uint16(hdr+len(body)))
	b[2], b[3] = syscall.RTM_VERSION, syscall.RTM_GET
	binary.LittleEndian.PutUint16(b[4:6], index)
	binary.LittleEndian.PutUint32(b[8:12], flags)
	binary.LittleEndian.PutUint32(b[12:16], syscall.RTA_DST|syscall.RTA_GATEWAY|syscall.RTA_NETMASK)
	binary.LittleEndian.PutUint32(b[28:32], 4722) // rtm_use: the routes are carrying traffic
	return append(b, body...)
}

func TestKernelEncodedCaptureRoutes(t *testing.T) {
	sin := func(a byte) []byte { return []byte{16, syscall.AF_INET, 0, 0, a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0} }
	sin6 := func(a byte) []byte {
		b := make([]byte, 28)
		b[0], b[1], b[8] = 28, syscall.AF_INET6, a
		return b
	}
	link := []byte{20, syscall.AF_LINK, 22, 0, 0xff, 5, 0, 0, 'u', 't', 'u', 'n', '4', 0, 0, 0, 0, 0, 0, 0}
	half4 := []byte{5, 0xff, 0, 0, 0x80}             // 128.0.0.0, compact
	half6 := []byte{9, 0xff, 0, 0, 0, 0, 0, 0, 0x80} // 8000::, compact
	flags := uint32(syscall.RTF_UP | FlagStatic | FlagProto2)
	var rib []byte
	rib = append(rib, rtMsg(22, flags, sin(0), link, half4)...)
	rib = append(rib, rtMsg(22, flags, sin(128), link, half4)...)
	rib = append(rib, rtMsg(22, flags, sin6(0), link, half6)...)
	rib = append(rib, rtMsg(22, flags, sin6(0x80), link, half6)...)
	msgs, err := route.ParseRIB(route.RIBTypeRoute, rib)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range fromMessages(msgs, name) {
		got = append(got, r.Dst.String()+" "+r.Gateway+" "+r.Iface)
	}
	want := "0.0.0.0/1 link#22 utun4, 128.0.0.0/1 link#22 utun4, ::/1 link#22 utun4, 8000::/1 link#22 utun4"
	if strings.Join(got, ", ") != want {
		t.Errorf("got  %s\nwant %s", strings.Join(got, ", "), want)
	}
}

func TestRouteHelpers(t *testing.T) {
	r := Route{netip.MustParsePrefix("::/0"), "fe80::%utun0", "utun0", FlagGateway | FlagIfscope, false}
	if !r.Scoped() {
		t.Error("RTF_IFSCOPE route not Scoped")
	}
	if (Route{Flags: FlagGateway}).Scoped() {
		t.Error("unscoped route reported Scoped")
	}
	if s := r.String(); s != "::/0 via fe80::%utun0 on utun0 flags 0x1000002" {
		t.Errorf("String() = %q", s)
	}
}

// Read-only smoke test against this machine's real table.
func TestReadRealTable(t *testing.T) {
	routes, err := Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) == 0 {
		t.Fatal("no routes read")
	}
	loopback := false
	for _, r := range routes {
		t.Log(r)
		if !r.Dst.IsValid() || r.Iface == "" {
			t.Errorf("malformed route %v", r)
		}
		loopback = loopback || (r.Dst == netip.MustParsePrefix("127.0.0.1/32") && r.Iface == "lo0")
	}
	if !loopback {
		t.Error("the 127.0.0.1 host route on lo0, which every Mac has, was not read")
	}
}
