package nics

import (
	"testing"

	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
)

// DefaultRoutes reads the same table as rib.Read (one sysctl, no root). Each default route it lists
// must agree with rib.Read about its scope and our marker, which the scoped sync relies on to tell its
// routes from macOS's (ADR-0006, M2.4).
func TestDefaultRoutesAgreeWithTheTable(t *testing.T) {
	routes, err := DefaultRoutes()
	if err != nil {
		t.Fatal(err)
	}
	table, err := rib.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) == 0 {
		t.Skip("this Mac has no default route")
	}
	for _, r := range routes {
		matched := false
		for _, e := range table {
			if e.Dst.Bits() != 0 || e.Iface != r.Name || e.Scoped() != r.Scoped || e.Dst.Addr().Is6() != r.V6 {
				continue
			}
			matched = true
			if marked := e.Flags&rib.FlagProto2 != 0; marked != r.Marked {
				t.Errorf("%+v: Marked = %t, the table says %t (%s)", r, r.Marked, marked, e)
			}
		}
		if !matched {
			t.Errorf("default route %+v is not in the table", r)
		}
	}
}
