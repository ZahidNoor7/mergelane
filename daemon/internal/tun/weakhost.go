package tun

// The pure parts of Windows' strong-host handling (tun_windows.go), here so they are tested on every
// platform: the PowerShell query, reading its answer, and the netsh arguments that put things back.

import (
	"fmt"
	"strconv"
	"strings"
)

// weakHost is one adapter family whose weak host send or forwarding is on.
type weakHost struct {
	family, index, weakHostSend, forwarding string // "ipv4", "14", "enabled", "disabled"
}

func (w weakHost) restoreLine() string {
	return fmt.Sprintf("%s %s weakhostsend=%s forwarding=%s", w.family, w.index, w.weakHostSend, w.forwarding)
}

// weakHostQuery asks Get-NetIPInterface for the given adapters' families with weak host send or
// forwarding on, one "<family> <index> <weakhostsend> <forwarding>" line each.
func weakHostQuery(indexes []string) string {
	return "Get-NetIPInterface -InterfaceIndex " + strings.Join(indexes, ",") + " -ErrorAction SilentlyContinue | " +
		"Where-Object { $_.WeakHostSend -eq 'Enabled' -or $_.Forwarding -eq 'Enabled' } | " +
		"ForEach-Object { '{0} {1} {2} {3}' -f $_.AddressFamily, $_.InterfaceIndex, $_.WeakHostSend, $_.Forwarding }"
}

// parseWeakHost reads weakHostQuery's output ("IPv4 14 Enabled Disabled" per line), keeping only
// well-formed IPv4 and IPv6 lines with a numeric index.
func parseWeakHost(out string) []weakHost {
	var found []weakHost
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 4 {
			continue
		}
		fam := strings.ToLower(f[0])
		if fam != "ipv4" && fam != "ipv6" {
			continue
		}
		if _, err := strconv.Atoi(f[1]); err != nil {
			continue
		}
		found = append(found, weakHost{fam, f[1], strings.ToLower(f[2]), strings.ToLower(f[3])})
	}
	return found
}

// putBackArgs turns the recorded lines ("ipv4 14 weakhostsend=enabled forwarding=disabled") into
// netsh arguments, skipping any line that isn't exactly what restoreLine writes.
func putBackArgs(lines []string) [][]string {
	var out [][]string
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) != 4 || (f[0] != "ipv4" && f[0] != "ipv6") {
			continue
		}
		if _, err := strconv.Atoi(f[1]); err != nil {
			continue
		}
		if !validSetting(f[2], "weakhostsend=") || !validSetting(f[3], "forwarding=") {
			continue
		}
		out = append(out, []string{"interface", f[0], "set", "interface", "interface=" + f[1], f[2], f[3], "store=active"})
	}
	return out
}

func validSetting(s, key string) bool {
	v, ok := strings.CutPrefix(s, key)
	return ok && (v == "enabled" || v == "disabled")
}
