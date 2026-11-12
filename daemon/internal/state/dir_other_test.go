//go:build !windows

package state

import "testing"

func TestNoWindowsDirElsewhere(t *testing.T) {
	if got := windowsDir(); got != "" {
		t.Errorf("windowsDir() = %q off Windows", got)
	}
}
