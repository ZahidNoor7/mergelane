//go:build darwin

package vpnguard

import (
	"context"
	"fmt"
	"net/netip"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// netstat's flag letters (man netstat) as RTF bits (x/sys, generated from <net/route.h>), so fixtures
// read like `netstat -rn` lines.
var letters = map[rune]uint{
	'1': unix.RTF_PROTO1, '2': unix.RTF_PROTO2, '3': unix.RTF_PROTO3, 'B': unix.RTF_BLACKHOLE,
	'b': unix.RTF_BROADCAST, 'C': unix.RTF_CLONING, 'c': unix.RTF_PRCLONING, 'D': unix.RTF_DYNAMIC,
	'G': unix.RTF_GATEWAY, 'H': unix.RTF_HOST, 'I': unix.RTF_IFSCOPE, 'i': unix.RTF_IFREF,
	'L': unix.RTF_LLINFO, 'M': unix.RTF_MODIFIED, 'm': unix.RTF_MULTICAST, 'R': unix.RTF_REJECT,
	'r': unix.RTF_ROUTER, 'S': unix.RTF_STATIC, 'U': unix.RTF_UP, 'W': unix.RTF_WASCLONED,
	'X': unix.RTF_XRESOLVE, 'Y': unix.RTF_PROXY, 'g': unix.RTF_GLOBAL,
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

// thisMac is the table of the Mac this package was written on, with no VPN (`netstat -rn` and
// `scutil --nc list` empty, 2026-11-10). macOS gives each of its own utuns a scoped IPv6 default.
var thisMac = []Route{
	r("0.0.0.0/0", "192.168.1.1", "UGScg", "en0"),
	r("127.0.0.0/8", "127.0.0.1", "UCS", "lo0"),
	r("127.0.0.1/32", "127.0.0.1", "UH", "lo0"),
	r("169.254.0.0/16", "link#14", "UCS", "en0"),
	r("192.168.1.0/24", "link#14", "UCS", "en0"),
	r("192.168.1.1/32", "f4:e8:4f:df:cb:76", "UHLWIir", "en0"),
	r("224.0.0.0/4", "link#14", "UmCS", "en0"),
	r("255.255.255.255/32", "link#14", "UCS", "en0"),
	r("::/0", "fe80::%utun0", "UGcIg", "utun0"),
	r("::/0", "fe80::%utun1", "UGcIg", "utun1"),
	r("::/0", "fe80::%utun2", "UGcIg", "utun2"),
	r("::/0", "fe80::%utun3", "UGcIg", "utun3"),
	r("::/0", "fe80::%utun5", "UGcIg", "utun5"),
	r("::/0", "fe80::%utun6", "UGcIg", "utun6"),
	r("::1/128", "::1", "UHL", "lo0"),
	r("fe80::/64", "link#14", "UCI", "en0"),
	r("fe80::/64", "fe80::8c37:16dd:e1a1:e65f%utun0", "UcI", "utun0"),
	r("ff00::/8", "link#14", "UmCI", "en0"),
	r("ff00::/8", "fe80::8c37:16dd:e1a1:e65f%utun0", "UmCI", "utun0"),
}

// runner is the shape spike S1 saw on the CI runner (ADR-0017): utun0-utun3 with link-local and
// multicast routes only.
var runner = func() []Route {
	rs := []Route{r("0.0.0.0/0", "10.0.0.1", "UGScg", "en0"), r("10.0.0.0/24", "link#6", "UCS", "en0")}
	for i := range 4 {
		u := fmt.Sprintf("utun%d", i)
		rs = append(rs, r("fe80::/64", "fe80::1%"+u, "UcI", u), r("ff00::/8", "fe80::1%"+u, "UmCI", u))
	}
	return rs
}()

func with(base []Route, extra ...Route) []Route {
	return append(append([]Route(nil), base...), extra...)
}

func pfx(ss ...string) []netip.Prefix {
	var out []netip.Prefix
	for _, s := range ss {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}

func iface(name string, routes ...string) Conflict {
	return Conflict{Kind: KindRoute, Interface: name, Routes: pfx(routes...)}
}

func service(name string) Conflict { return Conflict{Kind: KindService, Service: name} }

func oursIs(names ...string) func(string) bool {
	return func(s string) bool {
		for _, n := range names {
			if s == n {
				return true
			}
		}
		return false
	}
}

func TestConflicts(t *testing.T) {
	// What `route -q -n add -inet 0.0.0.0/1 -interface utun4` leaves (route(8) sets RTF_STATIC, the kernel RTF_UP).
	fakeVPN := []Route{r("0.0.0.0/1", "link#22", "US", "utun4"), r("128.0.0.0/1", "link#22", "US", "utun4")}
	ourCapture := []Route{
		r("0.0.0.0/1", "link#30", "US2", "utun7"), r("128.0.0.0/1", "link#30", "US2", "utun7"),
		r("::/1", "link#30", "US2", "utun7"), r("8000::/1", "link#30", "US2", "utun7"),
	}
	for _, c := range []struct {
		name   string
		routes []Route
		ours   func(string) bool
		nc     []string
		want   []Conflict
	}{
		{"no VPN on this Mac (its utuns have scoped IPv6 defaults)", thisMac, nil, nil, nil},
		{"no VPN on the CI runner (utun0-3 without routes)", runner, nil, nil, nil},
		{"empty table", nil, nil, nil, nil},
		{"process utun with 0/1 + 128/1, like the spike's fake VPN", with(thisMac, fakeVPN...), nil, nil,
			[]Conflict{iface("utun4", "0.0.0.0/1", "128.0.0.0/1")}},
		{"full-tunnel VPN that took the unscoped default", with(runner, r("0.0.0.0/0", "10.8.0.1", "UGSc", "utun5")), nil, nil,
			[]Conflict{iface("utun5", "0.0.0.0/0")}},
		{"scoped IPv4 default on a utun (split VPN) serves bound sockets only", with(thisMac, r("0.0.0.0/0", "10.8.0.1", "UGScI", "utun5")), nil, nil, nil},
		{"scoped /1 routes are ignored too", with(thisMac, r("0.0.0.0/1", "link#22", "USI", "utun4")), nil, nil, nil},
		{"IPsec (IKEv2) default", with(runner, r("0.0.0.0/0", "link#9", "UCS", "ipsec0")), nil, nil,
			[]Conflict{iface("ipsec0", "0.0.0.0/0")}},
		{"PPP (L2TP/PPTP) default", with(runner, r("0.0.0.0/0", "10.10.0.1", "UGSc", "ppp0")), nil, nil,
			[]Conflict{iface("ppp0", "0.0.0.0/0")}},
		{"tuntaposx kext (tun0) with /1 routes", with(runner, r("0.0.0.0/1", "10.9.0.1", "UGSc", "tun0")), nil, nil,
			[]Conflict{iface("tun0", "0.0.0.0/1")}},
		{"our own utun is excluded", with(thisMac, ourCapture...), oursIs("utun7"), nil, nil},
		{"our own utun counts when ours says no", with(thisMac, ourCapture[:1]...), oursIs("utun9"), nil,
			[]Conflict{iface("utun7", "0.0.0.0/1")}},
		{"IPv6 /1 routes", with(thisMac, r("::/1", "link#22", "US", "utun4"), r("8000::/1", "link#22", "US", "utun4")), nil, nil,
			[]Conflict{iface("utun4", "::/1", "8000::/1")}},
		{"unscoped IPv6 default on a utun", with(runner, r("::/0", "fe80::1%utun3", "UGSc", "utun3")), nil, nil,
			[]Conflict{iface("utun3", "::/0")}},
		{"specific routes on a utun are a split tunnel, not all traffic", with(thisMac,
			r("10.0.0.0/8", "link#22", "US", "utun4"), r("0.0.0.0/2", "link#22", "US", "utun4")), nil, nil, nil},
		{"defaults and /1s on hardware are not a VPN", with(thisMac,
			r("0.0.0.0/1", "192.168.1.1", "UGS", "en0"), r("0.0.0.0/0", "192.168.2.1", "UGScI", "feth1")), nil, nil, nil},
		{"wgN does not exist on macOS and is not matched", with(thisMac, r("0.0.0.0/0", "10.7.0.1", "UGSc", "wg0")), nil, nil, nil},
		{"invalid destination is ignored", with(thisMac, Route{Iface: "utun9", Flags: unix.RTF_UP}), nil, nil, nil},
		{"connected scutil service", thisMac, nil, []string{"Work VPN"},
			[]Conflict{service("Work VPN")}},
		{"empty service name is ignored", thisMac, nil, []string{""}, nil},
		{"multiple conflicts in a fixed order", with(thisMac,
			r("::/1", "link#40", "US", "utun10"),
			r("8000::/1", "link#22", "US", "utun4"),
			r("0.0.0.0/1", "link#22", "US", "utun4"),
			r("0.0.0.0/0", "10.10.0.1", "UGSc", "ppp0"),
			r("::/1", "link#22", "US", "utun4"),
			r("0.0.0.0/0", "link#9", "UCS", "ipsec0"),
			r("0.0.0.0/1", "link#22", "US", "utun4"), // listed twice, reported once
		), oursIs("utun7"), []string{"Work VPN", "Home WireGuard", "Work VPN"},
			[]Conflict{
				service("Home WireGuard"), service("Work VPN"),
				iface("ipsec0", "0.0.0.0/0"),
				iface("ppp0", "0.0.0.0/0"),
				iface("utun4", "0.0.0.0/1", "::/1", "8000::/1"),
				iface("utun10", "::/1"),
			}},
	} {
		got := Conflicts(c.routes, c.ours, c.nc)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got  %+v\n want %+v", c.name, got, c.want)
		}
	}
}

func TestConflictsDoesNotModifyItsInput(t *testing.T) {
	nc := []string{"b", "a"}
	Conflicts(nil, nil, nc)
	if nc[0] != "b" {
		t.Errorf("ncConnected was sorted in place: %v", nc)
	}
}

func TestMessage(t *testing.T) {
	for _, c := range []struct {
		in   Conflict
		want string
	}{
		{iface("utun4", "0.0.0.0/1", "128.0.0.0/1", "::/1", "8000::/1"),
			"Another VPN (utun4) is routing all traffic. Turn it off to use system-wide merging."},
		{iface("utun4", "0.0.0.0/1", "128.0.0.0/1"),
			"Another VPN (utun4) is routing all IPv4 traffic. Turn it off to use system-wide merging."},
		{iface("utun12", "::/0"),
			"Another VPN (utun12) is routing all IPv6 traffic. Turn it off to use system-wide merging."},
		{iface("ipsec0", "0.0.0.0/0"),
			"An IPsec VPN (ipsec0) is routing all IPv4 traffic. Turn it off to use system-wide merging."},
		{iface("ppp0", "0.0.0.0/0"),
			"A PPP connection (ppp0) is routing all IPv4 traffic. Turn it off to use system-wide merging."},
		{iface("tap1"),
			"Another VPN (tap1) is routing all traffic. Turn it off to use system-wide merging."},
		{service("Work VPN"),
			"The VPN “Work VPN” is on. Turn it off to use system-wide merging."},
	} {
		if got := c.in.Message(); got != c.want {
			t.Errorf("%+v:\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestKindString(t *testing.T) {
	for k, want := range map[Kind]string{KindRoute: "route", KindService: "service", 0: "Kind(0)", 9: "Kind(9)"} {
		if got := k.String(); got != want {
			t.Errorf("Kind(%d).String() = %q, want %q", int(k), got, want)
		}
	}
}

func TestNaturalOrder(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"utun4", "utun10", -1}, {"utun10", "utun4", 1}, {"ipsec0", "utun0", -1}, {"utun4", "utun4", 0},
		{"utun", "utun0", -1}, {"utun04", "utun4", -1},
	} {
		if got := naturalCompare(c.a, c.b); got != c.want {
			t.Errorf("naturalCompare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// ncLine prints one service exactly as configd's scutil.tproj/nc.c (nc_print_VPN_service) does:
// SCPrint("%@ %@ %@ %@ %@ [%@%@%@]\n", enabled ? "*" : " ", status padded to 16 in "(...)", service ID,
// interface name padded to 18, name padded to 32 in quotes, type, ":" and subtype if any).
// copy_padded_string wraps, then CFStringPad()s to max(len(original), width), which pads with spaces
// or cuts (<CoreFoundation/CFString.h>).
func ncLine(enabled bool, status, id, ifname, name, typ, sub string) string {
	pad := func(s, pre, suf string, width int) string {
		p, n := pre+s+suf, max(len(s), width)
		if len(p) > n {
			return p[:n]
		}
		return p + strings.Repeat(" ", n-len(p))
	}
	mark, sep := " ", ""
	if enabled {
		mark = "*"
	}
	if sub != "" {
		sep = ":"
	}
	return fmt.Sprintf("%s %s %s %s %s [%s%s%s]", mark, pad(status, "(", ")", 16), id,
		pad(ifname, "", "", 18), pad(name, `"`, `"`, 32), typ, sep, sub)
}

// The header line, byte for byte as `scutil --nc list` prints it on this Mac (and as in the binary's strings).
const header = "Available network connection services in the current set (*=enabled):\n"

func TestParseNCList(t *testing.T) {
	const id1, id2, id3 = "5A3E8F30-1D2B-4C5A-9E8F-0123456789AB", "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D", "C0FFEE00-1111-4222-8333-444455556666"
	// The interface-name column is illustrative (the parser never reads it), but may contain spaces.
	wg := func(status string) string {
		return ncLine(true, status, id1, "WireGuard", "Home WireGuard", "VPN", "com.wireguard.macos")
	}
	l2tp := func(status string) string { return ncLine(true, status, id2, "L2TP", "Work VPN", "PPP", "L2TP") }
	ipsec := func(status, name string) string { return ncLine(true, status, id3, "Cisco IPSec", name, "IPSec", "") }
	name30 := "Thirty characters service name"                 // 30: fits, quotes intact
	name31 := "Thirty-one characters VPN name!"                // 31: CFStringPad cuts the closing quote
	name40 := "A forty character long VPN service name!!"[:40] // 40: cut to `"` + its first 39 characters

	for _, c := range []struct {
		name, in string
		want     []string
	}{
		{"empty output", "", nil},
		{"header only (this Mac, no services)", header, nil},
		{"disconnected", header + wg("Disconnected") + "\n" + l2tp("Disconnected") + "\n", nil},
		{"invalid and unknown are off", header + wg("Invalid") + "\n" + l2tp("Unknown") + "\n", nil},
		{"connected", header + wg("Disconnected") + "\n" + l2tp("Connected") + "\n", []string{"Work VPN"}},
		{"connecting counts", header + wg("Connecting") + "\n", []string{"Home WireGuard"}},
		{"disconnecting counts", header + l2tp("Disconnecting") + "\n", []string{"Work VPN"}},
		{"not enabled but connected", header + ncLine(false, "Connected", id2, "L2TP", "Old VPN", "PPP", "L2TP") + "\n", []string{"Old VPN"}},
		{"type without subtype", header + ipsec("Connected", "Office") + "\n", []string{"Office"}},
		{"output order kept", header + wg("Connected") + "\n" + ipsec("Disconnected", "Office") + "\n" + l2tp("Connecting") + "\n",
			[]string{"Home WireGuard", "Work VPN"}},
		{"30-character name", header + ipsec("Connected", name30) + "\n", []string{name30}},
		{"31-character name loses only its closing quote", header + ipsec("Connected", name31) + "\n", []string{name31}},
		{"40-character name is cut by one", header + ipsec("Connected", name40) + "\n", []string{name40[:39]}},
		{"brackets and quotes inside the name", header + ipsec("Connected", `Office "EU" [backup]`) + "\n", []string{`Office "EU" [backup]`}},
		{"odd spacing: tabs, CRLF, extra blanks", header +
			"\t*   (Connected)\t" + id1 + "\t VPN  (x)   \"Spaced  Name\"\t\t[VPN:x]  \r\n" +
			"  (  Connecting  )  " + id2 + " L2TP \"Second\" [PPP:L2TP]\r\n\r\n", []string{"Spaced  Name", "Second"}},
		{"no quoted name falls back to the service ID", header + "* (Connected)      " + id3 + " IPSec\n", []string{id3}},
		{"broken lines are skipped", header + "* (Connected\n* (Connected)\n* Connected " + id1 + " \"X\" [IPSec]\nrandom text\n", nil},
	} {
		if got := ParseNCList(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got  %q\n want %q\n input:\n%s", c.name, got, c.want, c.in)
		}
	}
}

func TestNCLineMatchesTheRealFormat(t *testing.T) {
	// Checks the fixture printer itself against the widths nc.c uses: "(Connected)" is 11 characters padded
	// to 16, "L2TP" 4 padded to 18, and the quoted name 10 padded to 32; one space between fields.
	got := ncLine(true, "Connected", "ID", "L2TP", "Work VPN", "PPP", "L2TP")
	const sp = " "
	want := "*" + sp + "(Connected)" + strings.Repeat(" ", 16-11) + sp + "ID" + sp +
		"L2TP" + strings.Repeat(" ", 18-4) + sp + `"Work VPN"` + strings.Repeat(" ", 32-10) + sp + "[PPP:L2TP]"
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

// Read-only: scutil --nc list needs no privileges and changes nothing.
func TestReadNCConnectedOnThisMac(t *testing.T) {
	names, err := ReadNCConnected(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("services on: %q", names)
}

func TestReadNCConnectedErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadNCConnected(ctx); err == nil {
		t.Error("cancelled context: no error")
	}
	old := scutil
	defer func() { scutil = old }()
	scutil = "/nonexistent/scutil"
	if _, err := ReadNCConnected(context.Background()); err == nil || !strings.Contains(err.Error(), "scutil --nc list") {
		t.Errorf("missing binary: err = %v", err)
	}
}

// Read-only smoke test on this machine's real routing table.
func TestReadRoutesOnThisMac(t *testing.T) {
	routes, err := ReadRoutes()
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) == 0 {
		t.Fatal("no routes read")
	}
	for _, c := range Conflicts(routes, nil, nil) {
		t.Logf("conflict on this machine: %s", c.Message())
	}
}
