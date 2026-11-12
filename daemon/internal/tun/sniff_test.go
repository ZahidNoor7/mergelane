package tun

import (
	"context"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	M "github.com/xjasonlyu/tun2socks/v2/metadata"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"

	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

func TestTheStacksKeyAndTheDialersKeyAreTheSameFlow(t *testing.T) {
	id := stack.TransportEndpointID{
		LocalAddress:  tcpip.AddrFrom4([4]byte{93, 184, 215, 14}),
		LocalPort:     443,
		RemoteAddress: tcpip.AddrFrom4([4]byte{198, 18, 0, 1}),
		RemotePort:    51000,
	}
	m := &M.Metadata{
		Network: M.TCP,
		SrcIP:   netip.MustParseAddr("198.18.0.1"),
		SrcPort: 51000,
		DstIP:   netip.MustParseAddr("93.184.215.14"),
		DstPort: 443,
	}
	if keyOfEndpoint(id) != keyOfMetadata(m) {
		t.Fatalf("%v != %v", keyOfEndpoint(id), keyOfMetadata(m))
	}
	serverNames.Store(keyOfEndpoint(id), "www.example.com")
	if got := takeServerName(m); got != "www.example.com" {
		t.Fatalf("took %q", got)
	}
	if got := takeServerName(m); got != "" {
		t.Fatalf("a name was taken twice: %q", got)
	}
}

func TestReplayConnGivesBackWhatWasReadFirst(t *testing.T) {
	c := &replayConn{pending: []byte("hello, world")}
	buf := make([]byte, 5)
	var got []byte
	for len(c.pending) > 0 {
		n, err := c.Read(buf)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, buf[:n]...)
	}
	if string(got) != "hello, world" {
		t.Fatalf("replayed %q", got)
	}
}

func loopback(t *testing.T) nics.Nic {
	t.Helper()
	lo, err := net.InterfaceByName("lo0")
	if err != nil {
		t.Skipf("no lo0: %v", err)
	}
	return nics.Nic{Name: "lo0", IP: net.ParseIP("127.0.0.1"), Index: lo.Index, Weight: 1}
}

func TestTheProxyDialsEachFlowForItsSite(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(io.Discard, c); c.Close() }()
		}
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	s := engine.NewScheduler([]nics.Nic{loopback(t)})
	b := engine.NewBalancer(s)
	b.ConnectTimeout = 2 * time.Second
	b.Sticky = engine.NewSticky(true)
	p := tunProxy{b}
	m := &M.Metadata{
		Network: M.TCP,
		SrcIP:   netip.MustParseAddr("198.18.0.1"),
		SrcPort: 52000,
		DstIP:   netip.MustParseAddr("127.0.0.1"),
		DstPort: port,
	}
	serverNames.Store(keyOfMetadata(m), "www.example.com")
	c, err := p.DialContext(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if b.Sticky.Link("example.com") == "" {
		t.Fatal("the sniffed site wasn't kept on a link")
	}
	// QUIC to the same address belongs to the same site; other UDP isn't kept anywhere.
	if b.Sticky.Site(m.DstIP, "") != "example.com" {
		t.Fatal("the address wasn't learned")
	}
	quic := &M.Metadata{Network: M.UDP, SrcIP: m.SrcIP, SrcPort: 53000, DstIP: m.DstIP, DstPort: httpsPort}
	pc, err := p.DialUDP(quic)
	if err != nil {
		t.Fatal(err)
	}
	pc.Close()
	dns := &M.Metadata{Network: M.UDP, SrcIP: m.SrcIP, SrcPort: 53001, DstIP: netip.MustParseAddr("192.0.2.53"), DstPort: 53}
	pc, err = p.DialUDP(dns)
	if err != nil {
		t.Fatal(err)
	}
	pc.Close()
	if b.Sticky.Link("192.0.2.53") != "" {
		t.Fatal("DNS was kept on a link")
	}
	if b.Sticky.Sites() != 1 {
		t.Fatalf("%d sites kept, want 1", b.Sticky.Sites())
	}
	v6 := &M.Metadata{Network: M.UDP, SrcIP: netip.MustParseAddr("fd00::1"), SrcPort: 1, DstIP: netip.MustParseAddr("2001:db8::1"), DstPort: 443}
	if pc, err := p.DialUDP(v6); err == nil {
		pc.Close()
		t.Fatal("IPv6 UDP over an IPv4-only link succeeded")
	}

	// Off: the name is still taken (none is left behind), and nothing new is kept.
	b.Sticky.SetOn(false)
	m.SrcPort = 52001
	serverNames.Store(keyOfMetadata(m), "www.example.org")
	c, err = p.DialContext(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if takeServerName(m) != "" || b.Sticky.Sites() != 0 {
		t.Fatal("off still kept a site, or left its name behind")
	}
}
