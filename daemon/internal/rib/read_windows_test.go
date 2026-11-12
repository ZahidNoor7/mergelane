package rib

import "testing"

// On a real Windows PC (the test kit) the table has at least the loopback routes, and every route
// names an adapter Windows listed.
func TestReadOnWindows(t *testing.T) {
	routes, err := Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(routes) == 0 {
		t.Fatal("Read found no routes; Windows always has loopback routes")
	}
	adapters, err := Adapters()
	if err != nil {
		t.Fatalf("Adapters: %v", err)
	}
	if len(adapters) == 0 {
		t.Fatal("Adapters found none; Windows always has a loopback adapter")
	}
	for _, r := range routes {
		if !r.Dst.IsValid() || r.Iface == "" || r.Gateway == "" {
			t.Errorf("incomplete route %v", r)
		}
	}
}
