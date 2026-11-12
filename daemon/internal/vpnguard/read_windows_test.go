package vpnguard

import (
	"context"
	"errors"
	"testing"
)

// The guard refuses when it can't read: on Windows both reads fail until W5.
func TestReadsAreNotAvailableOnWindowsYet(t *testing.T) {
	if routes, err := ReadRoutes(); routes != nil || !errors.Is(err, errors.ErrUnsupported) {
		t.Errorf("ReadRoutes = %v, %v; want nil, ErrUnsupported", routes, err)
	}
	if names, err := ReadNCConnected(context.Background()); names != nil || !errors.Is(err, errors.ErrUnsupported) {
		t.Errorf("ReadNCConnected = %v, %v; want nil, ErrUnsupported", names, err)
	}
}
