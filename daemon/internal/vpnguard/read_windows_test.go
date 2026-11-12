package vpnguard

import (
	"context"
	"testing"
)

// On a real Windows PC (the test kit) both reads work, and the guard can judge what they found.
func TestReadsOnWindows(t *testing.T) {
	routes, err := ReadRoutes()
	if err != nil {
		t.Fatalf("ReadRoutes: %v", err)
	}
	services, err := ReadNCConnected(context.Background())
	if err != nil {
		t.Fatalf("ReadNCConnected: %v", err)
	}
	for _, c := range Conflicts(routes, func(string) bool { return false }, services) {
		t.Logf("this PC has a VPN on: %s", c.Message())
	}
}
