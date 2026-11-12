package tun

import (
	"reflect"
	"strings"
	"testing"
)

func TestWeakHostQueryAsksForTheGivenAdaptersOnly(t *testing.T) {
	q := weakHostQuery([]string{"14", "22"})
	for _, want := range []string{"Get-NetIPInterface -InterfaceIndex 14,22 ", "$_.WeakHostSend -eq 'Enabled'",
		"$_.Forwarding -eq 'Enabled'", "'{0} {1} {2} {3}' -f $_.AddressFamily, $_.InterfaceIndex"} {
		if !strings.Contains(q, want) {
			t.Errorf("query lacks %q:\n%s", want, q)
		}
	}
}

func TestParseWeakHostKeepsWellFormedLines(t *testing.T) {
	out := "IPv4 14 Enabled Disabled\r\nIPv6 14 Disabled Enabled\r\n\r\nIPX 3 Enabled Enabled\r\nIPv4 x Enabled Enabled\r\nIPv4 9 Enabled\r\n"
	want := []weakHost{{"ipv4", "14", "enabled", "disabled"}, {"ipv6", "14", "disabled", "enabled"}}
	if got := parseWeakHost(out); !reflect.DeepEqual(got, want) {
		t.Errorf("parseWeakHost = %v, want %v", got, want)
	}
	if got := parseWeakHost(""); got != nil {
		t.Errorf("parseWeakHost(\"\") = %v, want nil", got)
	}
}

// What is recorded is exactly what putBackArgs accepts, and anything else in the file is ignored.
func TestPutBackRoundTrip(t *testing.T) {
	lines := []string{
		weakHost{"ipv4", "14", "enabled", "disabled"}.restoreLine(),
		weakHost{"ipv6", "7", "disabled", "enabled"}.restoreLine(),
		"ipv4 14 weakhostsend=maybe forwarding=disabled",
		"ipv4 14 forwarding=enabled weakhostsend=enabled",
		"ipv4 x weakhostsend=enabled forwarding=enabled",
		"ipx 1 weakhostsend=enabled forwarding=enabled",
		"",
	}
	want := [][]string{
		{"interface", "ipv4", "set", "interface", "interface=14", "weakhostsend=enabled", "forwarding=disabled", "store=active"},
		{"interface", "ipv6", "set", "interface", "interface=7", "weakhostsend=disabled", "forwarding=enabled", "store=active"},
	}
	if got := putBackArgs(lines); !reflect.DeepEqual(got, want) {
		t.Errorf("putBackArgs = %v, want %v", got, want)
	}
}
