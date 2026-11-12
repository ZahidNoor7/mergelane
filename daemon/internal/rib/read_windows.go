package rib

import (
	"fmt"
	"net/netip"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Read dumps the routing table with GetIpForwardTable2 (both families), naming each route's adapter
// with GetAdaptersAddresses. FromWindows (windows.go) does the rest.
func Read() ([]Route, error) {
	adapters, err := Adapters()
	if err != nil {
		return nil, err
	}
	var table *windows.MibIpForwardTable2
	if err := windows.GetIpForwardTable2(windows.AF_UNSPEC, &table); err != nil {
		return nil, fmt.Errorf("reading the routing table: %w", err)
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	rows := make([]WinRow, 0, table.NumEntries)
	for _, r := range table.Rows() {
		dst := SockaddrAddr(*(*[28]byte)(unsafe.Pointer(&r.DestinationPrefix.Prefix)))
		if !dst.IsValid() {
			continue
		}
		rows = append(rows, WinRow{
			Index:   r.InterfaceIndex,
			Dst:     netip.PrefixFrom(dst, int(r.DestinationPrefix.PrefixLength)),
			NextHop: SockaddrAddr(*(*[28]byte)(unsafe.Pointer(&r.NextHop))),
		})
	}
	return FromWindows(rows, adapters), nil
}

// Adapters lists every adapter by interface index (an adapter with both families appears under both of
// its indexes), up or not, with its alias and IANA type.
func Adapters() (map[uint32]Adapter, error) {
	const flags = windows.GAA_FLAG_SKIP_ANYCAST | windows.GAA_FLAG_SKIP_MULTICAST |
		windows.GAA_FLAG_SKIP_DNS_SERVER
	size := uint32(32 << 10)
	for range 4 {
		buf := make([]byte, size)
		aa := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0, aa, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("listing adapters: %w", err)
		}
		m := map[uint32]Adapter{}
		for a := aa; a != nil; a = a.Next {
			info := Adapter{
				Alias:  windows.UTF16PtrToString(a.FriendlyName),
				IfType: a.IfType,
				Up:     a.OperStatus == windows.IfOperStatusUp,
			}
			for _, idx := range []uint32{a.IfIndex, a.Ipv6IfIndex} {
				if idx != 0 {
					m[idx] = info
				}
			}
		}
		return m, nil
	}
	return nil, fmt.Errorf("listing adapters: %w", windows.ERROR_BUFFER_OVERFLOW)
}
