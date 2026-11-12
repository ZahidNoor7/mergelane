package rib

import (
	"errors"
	"testing"
)

func TestReadIsNotAvailableOnWindowsYet(t *testing.T) {
	routes, err := Read()
	if routes != nil || !errors.Is(err, errors.ErrUnsupported) {
		t.Errorf("Read = %v, %v; want nil, ErrUnsupported", routes, err)
	}
}
