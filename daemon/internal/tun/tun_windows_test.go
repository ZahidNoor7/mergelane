package tun

import (
	"errors"
	"net/netip"
	"testing"
)

// Until W5 nothing in this package may touch Windows networking.
func TestWindowsRefusesSystemMerge(t *testing.T) {
	if errUnsupported == nil {
		t.Fatal("errUnsupported is not set on Windows")
	}
	tn := New(nil)
	if err := tn.On(); !errors.Is(err, errUnsupported) {
		t.Errorf("On = %v, want %v", err, errUnsupported)
	}
	if tn.IsOn() || tn.Name() != "" {
		t.Errorf("after On: on %v, adapter %q; want off and none", tn.IsOn(), tn.Name())
	}
	if idx, err := configure("mergelane", DefaultMTU, netip.MustParsePrefix("198.18.0.1/24")); idx != 0 || !errors.Is(err, errUnsupported) {
		t.Errorf("configure = %d, %v; want 0, %v", idx, err, errUnsupported)
	}
	delRoutes(1)   // nothing to remove; must not panic
	CleanupStale() // finds no adapter of ours; must not panic
	tn.Off()
	tn.Close()
}
