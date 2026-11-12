package nics

import (
	"context"
	"net"
	"syscall"
	"testing"
)

func TestPhysicalIfType(t *testing.T) {
	for typ, want := range map[uint32]bool{
		6: true, 62: true, 69: true, 117: true, // Ethernet
		71:  true,            // Wi-Fi
		243: true, 244: true, // mobile broadband
		24: false,                        // software loopback
		23: false, 53: false, 131: false, // PPP, proprietary virtual (most VPNs), tunnel
		0: false,
	} {
		if got := physicalIfType(typ); got != want {
			t.Errorf("physicalIfType(%d) = %v, want %v", typ, got, want)
		}
	}
}

// loopback is the index of Windows' loopback interface, which every Windows has.
func loopback(t *testing.T) int {
	t.Helper()
	ifs, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagLoopback != 0 {
			return ifc.Index
		}
	}
	t.Skip("no loopback interface")
	return 0
}

// adapterInfos reads this laptop's adapters (read only). Loopback is never treated as a network.
func TestAdapterInfosOnThisPC(t *testing.T) {
	m, err := adapterInfos()
	if err != nil {
		t.Fatal(err)
	}
	if len(m) == 0 {
		t.Fatal("no adapter is up")
	}
	if info, ok := m[loopback(t)]; ok && info.virtual == "" {
		t.Errorf("loopback counts as hardware: %+v", info)
	}
	for idx, info := range m {
		t.Logf("adapter %d: %q v4=%v v6=%v virtual=%q", idx, info.desc, info.v4, info.v6, info.virtual)
	}
	// What the daemon would use, and what it skips, with the reasons.
	found, skipped, err := DiscoverNicsDetailed(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range found {
		t.Logf("would use %s (index %d)", n.Name, n.Index)
	}
	for _, s := range skipped {
		t.Logf("skips %+v", s)
	}
}

func TestOctets(t *testing.T) {
	if _, _, ok := Octets(0); ok {
		t.Error("Octets(0) = ok")
	}
	if _, _, ok := Octets(loopback(t)); !ok {
		t.Error("Octets(loopback) failed")
	}
}

// ForceEgress sets IP_UNICAST_IF (network byte order) and IPV6_UNICAST_IF (host byte order);
// reading either back gives the index in host byte order (Microsoft Learn, IPPROTO_IP and
// IPPROTO_IPV6 socket options).
func TestForceEgress(t *testing.T) {
	if ForceEgress(0, false) != nil {
		t.Error("ForceEgress(0) is not nil")
	}
	idx := loopback(t)
	for _, c := range []struct {
		network, addr string
		v6            bool
		level         int
	}{
		{"udp4", "127.0.0.1:0", false, syscall.IPPROTO_IP},
		{"udp6", "[::1]:0", true, syscall.IPPROTO_IPV6},
	} {
		lc := net.ListenConfig{Control: ForceEgress(idx, c.v6)}
		pc, err := lc.ListenPacket(context.Background(), c.network, c.addr)
		if err != nil {
			t.Errorf("%s: %v", c.network, err)
			continue
		}
		raw, err := pc.(*net.UDPConn).SyscallConn()
		if err != nil {
			t.Fatal(err)
		}
		var got int
		var gerr error
		raw.Control(func(fd uintptr) { got, gerr = syscall.GetsockoptInt(syscall.Handle(fd), c.level, ipUnicastIf) })
		pc.Close()
		if gerr != nil || got != idx {
			t.Errorf("%s: option reads %d, %v; want %d", c.network, got, gerr, idx)
		}
	}
}
