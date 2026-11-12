package rib

import (
	"errors"
	"fmt"
)

// Read is not available on Windows yet. Reading the Windows routing table comes with System merge,
// milestone W5 in docs/WINDOWS-PLAN.md. Until then it fails, and the VPN guard, which reads the
// table through it, refuses to turn merging on.
func Read() ([]Route, error) {
	return nil, fmt.Errorf("reading the routing table on Windows: %w", errors.ErrUnsupported)
}
