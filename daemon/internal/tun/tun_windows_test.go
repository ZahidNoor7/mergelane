package tun

import (
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	wun "golang.zx2c4.com/wireguard/tun"
)

// The adapter is Mergelane's own type with a fixed GUID, so Windows keeps one network profile for it.
func TestAdapterIdentity(t *testing.T) {
	if wun.WintunTunnelType != "Mergelane" {
		t.Errorf("WintunTunnelType = %q", wun.WintunTunnelType)
	}
	g, err := windows.GUIDFromString(adapterGUID)
	if err != nil || wun.WintunStaticRequestedGUID == nil || *wun.WintunStaticRequestedGUID != g {
		t.Errorf("requested GUID = %v, want %s (%v)", wun.WintunStaticRequestedGUID, adapterGUID, err)
	}
	if staleHook == nil {
		t.Error("staleHook is not set: a crashed run's strong-host changes would never be put back")
	}
}

// The tools run from System32, never from PATH.
func TestSystemToolIsInSystem32(t *testing.T) {
	for _, name := range []string{"route", "netsh"} {
		if got := strings.ToLower(systemTool(name)); !strings.HasSuffix(got, `\system32\`+name+".exe") {
			t.Errorf("systemTool(%q) = %q", name, got)
		}
	}
}

// Without administrator rights there is nothing to clean up, and cleanup must not fail or panic: the
// kit runs it as a normal user, where no adapter of ours exists.
func TestCleanupStaleWithNothingToDo(t *testing.T) {
	CleanupStale()
	restoreStrongHost()
}

// The capture routes, as route.exe takes them, are the shared /1 halves.
func TestRoutes4win(t *testing.T) {
	want := [][2]string{{"0.0.0.0", "128.0.0.0"}, {"128.0.0.0", "128.0.0.0"}}
	if !reflect.DeepEqual(routes4win, want) {
		t.Errorf("routes4win = %v, want %v", routes4win, want)
	}
}
