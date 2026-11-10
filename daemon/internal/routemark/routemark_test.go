package routemark

import (
	"net/netip"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// netstat's flag letters (man netstat) as RTF bits (x/sys, generated from <net/route.h>); "2" is
// RTF_PROTO2, the marker.
var letters = map[rune]uint{
	'1': unix.RTF_PROTO1, '2': unix.RTF_PROTO2, '3': unix.RTF_PROTO3, 'C': unix.RTF_CLONING,
	'c': unix.RTF_PRCLONING, 'G': unix.RTF_GATEWAY, 'H': unix.RTF_HOST, 'I': unix.RTF_IFSCOPE,
	'i': unix.RTF_IFREF, 'L': unix.RTF_LLINFO, 'm': unix.RTF_MULTICAST, 'r': unix.RTF_ROUTER,
	'S': unix.RTF_STATIC, 'U': unix.RTF_UP, 'W': unix.RTF_WASCLONED, 'g': unix.RTF_GLOBAL,
}

func r(dst, gw, flags, iface string) Route {
	var f uint
	for _, c := range flags {
		bit, ok := letters[c]
		if !ok {
			panic("unknown netstat flag " + string(c))
		}
		f |= bit
	}
	return Route{Dst: netip.MustParsePrefix(dst), Gateway: gw, Iface: iface, Flags: f}
}

func TestFlagIsRTFPROTO2(t *testing.T) {
	if Flag != unix.RTF_PROTO2 {
		t.Errorf("Flag = %#x, x/sys says RTF_PROTO2 = %#x", Flag, unix.RTF_PROTO2)
	}
	if Flag != 0x4000 { // <net/route.h>: #define RTF_PROTO2 0x4000
		t.Errorf("Flag = %#x, the SDK header says 0x4000", Flag)
	}
}

func cmd(s string) []string { return strings.Fields(s) }

func TestArgs(t *testing.T) {
	p := netip.MustParsePrefix
	for _, c := range []struct {
		name        string
		in          Route
		add, delete string
	}{
		// The capture routes keep upstream's exact commands, plus -proto2 on add.
		{"capture 0/1", Capture(p("0.0.0.0/1"), "utun4"),
			"-q -n add -inet 0.0.0.0/1 -interface utun4 -proto2", "-q -n delete -inet 0.0.0.0/1 -interface utun4"},
		{"capture 128/1", Capture(p("128.0.0.0/1"), "utun4"),
			"-q -n add -inet 128.0.0.0/1 -interface utun4 -proto2", "-q -n delete -inet 128.0.0.0/1 -interface utun4"},
		{"capture ::/1", Capture(p("::/1"), "utun4"),
			"-q -n add -inet6 ::/1 -interface utun4 -proto2", "-q -n delete -inet6 ::/1 -interface utun4"},
		{"capture 8000::/1", Capture(p("8000::/1"), "utun4"),
			"-q -n add -inet6 8000::/1 -interface utun4 -proto2", "-q -n delete -inet6 8000::/1 -interface utun4"},
		// The scoped defaults keep upstream's scopedArgs order, plus -proto2 on add.
		{"scoped IPv4 default", ScopedDefault(false, "192.168.1.1", "en0"),
			"-q -n add -inet default 192.168.1.1 -ifscope en0 -proto2", "-q -n delete -inet default 192.168.1.1 -ifscope en0"},
		{"scoped IPv6 default gets the zone", ScopedDefault(true, "fe80::1", "en0"),
			"-q -n add -inet6 default fe80::1%en0 -ifscope en0 -proto2", "-q -n delete -inet6 default fe80::1%en0 -ifscope en0"},
		{"scoped IPv6 default keeps a zone it has", ScopedDefault(true, "fe80::1%feth3", "feth3"),
			"-q -n add -inet6 default fe80::1%feth3 -ifscope feth3 -proto2", "-q -n delete -inet6 default fe80::1%feth3 -ifscope feth3"},
		// As read back from the table.
		{"capture route read back", r("0.0.0.0/1", "link#22", "US2", "utun4"),
			"-q -n add -inet 0.0.0.0/1 -interface utun4 -proto2", "-q -n delete -inet 0.0.0.0/1 -interface utun4"},
		{"scoped default read back", r("0.0.0.0/0", "192.168.1.1", "UGScI2", "en0"),
			"-q -n add -inet default 192.168.1.1 -ifscope en0 -proto2", "-q -n delete -inet default 192.168.1.1 -ifscope en0"},
		{"scoped interface route", r("10.0.0.0/8", "link#9", "USI", "feth1"),
			"-q -n add -inet 10.0.0.0/8 -interface feth1 -ifscope feth1 -proto2", "-q -n delete -inet 10.0.0.0/8 -interface feth1 -ifscope feth1"},
		{"network route via a gateway", r("10.0.0.0/8", "10.1.1.1", "UGS", "en0"),
			"-q -n add -inet 10.0.0.0/8 10.1.1.1 -proto2", "-q -n delete -inet 10.0.0.0/8 10.1.1.1"},
		{"host route", r("10.0.0.1/32", "10.1.1.1", "UGHS", "en0"),
			"-q -n add -inet -host 10.0.0.1 10.1.1.1 -proto2", "-q -n delete -inet -host 10.0.0.1 10.1.1.1"},
	} {
		if got := AddArgs(c.in); !reflect.DeepEqual(got, cmd(c.add)) {
			t.Errorf("%s: AddArgs\n got  %q\n want %q", c.name, got, cmd(c.add))
		}
		if got := DeleteArgs(c.in); !reflect.DeepEqual(got, cmd(c.delete)) {
			t.Errorf("%s: DeleteArgs\n got  %q\n want %q", c.name, got, cmd(c.delete))
		}
	}
}

func TestConstructorsDescribeTheRouteTheyAdd(t *testing.T) {
	c := Capture(netip.MustParsePrefix("0.0.0.0/1"), "utun4")
	if c.Flags&Flag == 0 || c.Scoped() || c.Flags&rib.FlagGateway != 0 {
		t.Errorf("Capture flags %#x: want marked, unscoped, no gateway", c.Flags)
	}
	s := ScopedDefault(false, "192.168.1.1", "en0")
	if s.Flags&Flag == 0 || !s.Scoped() || s.Flags&rib.FlagGateway == 0 || s.Dst.Bits() != 0 {
		t.Errorf("ScopedDefault %v: want a marked, scoped default via a gateway", s)
	}
	if got := Marked([]Route{c, s}); len(got) != 2 {
		t.Errorf("Marked does not recognise our own routes: %v", got)
	}
}

// table is a recorded table (this Mac, 2026-11-10) with the daemon's marked routes added, plus routes
// that look alike but are not ours.
var (
	ourCapture4  = []Route{r("0.0.0.0/1", "link#30", "US2", "utun7"), r("128.0.0.0/1", "link#30", "US2", "utun7")}
	ourCapture6  = []Route{r("::/1", "link#30", "US2", "utun7"), r("8000::/1", "link#30", "US2", "utun7")}
	ourScopedEn0 = r("0.0.0.0/0", "192.168.1.1", "UGScI2", "en0") // en0 is primary: a leftover
	ourScopedV6  = r("::/0", "fe80::1%en0", "UGScI2", "en0")      // en0 has no unscoped IPv6 default: kept (#20)
	ourScopedEn5 = r("0.0.0.0/0", "172.20.10.1", "UGScI2", "en5") // en5 stopped being primary: kept (#20)
	table        = []Route{
		r("0.0.0.0/0", "192.168.1.1", "UGScg", "en0"),
		r("127.0.0.0/8", "127.0.0.1", "UCS", "lo0"),
		r("127.0.0.1/32", "127.0.0.1", "UH", "lo0"),
		r("192.168.1.0/24", "link#14", "UCS", "en0"),
		r("::/0", "fe80::%utun0", "UGcIg", "utun0"),
		r("fe80::/64", "link#14", "UCI", "en0"),
		ourCapture4[0], ourCapture4[1], ourCapture6[0], ourCapture6[1],
		ourScopedEn0, ourScopedV6, ourScopedEn5,
		// Not ours:
		r("0.0.0.0/1", "link#22", "US", "utun4"),                  // another VPN's capture route, unmarked
		r("192.168.1.50/32", "aa:bb:cc:dd:ee:ff", "US2", "en0"),   // arp -s ... pub: RTF_ANNOUNCE on a /32
		r("192.168.1.51/32", "aa:bb:cc:dd:ee:01", "UHLS2", "en0"), // published ARP host entry
		r("2001:db8::5/128", "aa:bb:cc:dd:ee:02", "UHLS2", "en0"), // ndp -s ... proxy
		r("10.0.0.0/2", "link#30", "US2", "utun7"),                // marked, but no route we add looks like this
		r("0.0.0.0/0", "10.0.6.1", "UGScI", "en6"),                // the scoped default macOS keeps on a non-primary en6
		r("172.20.10.0/28", "link#15", "UCS", "en5"),
	}
)

func TestMarked(t *testing.T) {
	want := []Route{ourCapture4[0], ourCapture4[1], ourCapture6[0], ourCapture6[1], ourScopedEn0, ourScopedV6, ourScopedEn5}
	if got := Marked(table); !reflect.DeepEqual(got, want) {
		t.Errorf("Marked:\n got  %v\n want %v", got, want)
	}
	if got := Marked(nil); got != nil {
		t.Errorf("Marked(nil) = %v", got)
	}
	if got := Marked([]Route{{Flags: Flag}}); got != nil {
		t.Errorf("a marked route without a valid destination was returned: %v", got)
	}
}

func TestLeftovers(t *testing.T) {
	want := []Route{ourCapture4[0], ourCapture4[1], ourCapture6[0], ourCapture6[1], ourScopedEn0}
	if got := Leftovers(table); !reflect.DeepEqual(got, want) {
		t.Errorf("Leftovers:\n got  %v\n want %v", got, want)
	}
	// Once en5 is primary again (its unscoped default is back), our scoped default there is a leftover.
	withEn5 := append([]Route{r("0.0.0.0/0", "172.20.10.1", "UGSc", "en5")}, table...)
	if got := Leftovers(withEn5); !slicesContain(got, ourScopedEn5) {
		t.Errorf("scoped default on a primary en5 not cleaned up: %v", got)
	}
}

func slicesContain(rs []Route, x Route) bool {
	for _, r := range rs {
		if r == x {
			return true
		}
	}
	return false
}

func TestInstalled(t *testing.T) {
	p := netip.MustParsePrefix
	want := []Route{Capture(p("0.0.0.0/1"), "utun7"), Capture(p("128.0.0.0/1"), "utun7"), Capture(p("::/1"), "utun7"), Capture(p("8000::/1"), "utun7")}
	vpnTookOver := []Route{
		r("0.0.0.0/1", "link#22", "US", "utun4"),    // a VPN replaced our 0/1
		r("128.0.0.0/1", "link#30", "US2", "utun7"), // ours
		r("::/1", "link#30", "USI2", "utun7"),       // scoped, so not the capture route
	}
	if got := Installed(vpnTookOver, want); !reflect.DeepEqual(got, want[1:2]) {
		t.Errorf("Installed:\n got  %v\n want %v", got, want[1:2])
	}
	if got := Installed(nil, want); got != nil {
		t.Errorf("Installed on an empty table = %v", got)
	}
}

func TestCleanupCommands(t *testing.T) {
	got := CleanupCommands(Leftovers(table))
	want := [][]string{
		cmd("-q -n delete -inet 0.0.0.0/1 -interface utun7"),
		cmd("-q -n delete -inet 128.0.0.0/1 -interface utun7"),
		cmd("-q -n delete -inet6 ::/1 -interface utun7"),
		cmd("-q -n delete -inet6 8000::/1 -interface utun7"),
		cmd("-q -n delete -inet default 192.168.1.1 -ifscope en0"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CleanupCommands:\n got  %q\n want %q", got, want)
	}
	// Capture routes go first even when listed after the scoped ones; the input is not reordered.
	in := []Route{ourScopedEn0, ourCapture6[1], ourCapture4[0]}
	got = CleanupCommands(in)
	if got[0][4] != "8000::/1" || got[1][4] != "0.0.0.0/1" || got[2][4] != "default" {
		t.Errorf("order: %q", got)
	}
	if in[0] != ourScopedEn0 {
		t.Error("CleanupCommands reordered its input")
	}
	if got := CleanupCommands(nil); got == nil || len(got) != 0 {
		t.Errorf("CleanupCommands(nil) = %#v, want empty", got)
	}
}

// Read-only: what cleanup would do on this machine right now.
func TestLeftoversOnThisMac(t *testing.T) {
	routes, err := rib.Read()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range Marked(routes) {
		t.Logf("marked: %v", r)
	}
	for _, c := range CleanupCommands(Leftovers(routes)) {
		t.Logf("cleanup would run: /sbin/route %s", strings.Join(c, " "))
	}
}
