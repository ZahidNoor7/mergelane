package tun

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/checksum"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"

	"github.com/xjasonlyu/tun2socks/v2/core"
	"github.com/xjasonlyu/tun2socks/v2/core/adapter"

	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

var appAddr = netip.MustParseAddr("198.18.0.1")

type noTransport struct{}

func (noTransport) HandleTCP(c adapter.TCPConn) { c.Close() }
func (noTransport) HandleUDP(c adapter.UDPConn) { c.Close() }

// pingStack is the TUN's userland stack as tun.open builds it, on a channel endpoint instead of a utun:
// packets injected into ep are what an app sends into the TUN, packets read from ep what it gets back.
func pingStack(t *testing.T, icmp adapter.NetworkHandler) *channel.Endpoint {
	t.Helper()
	ep := channel.New(64, 1500, "")
	s, err := core.CreateStack(&core.Config{LinkEndpoint: ep, TransportHandler: noTransport{}, ICMPHandler: icmp})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close(); s.Wait(); ep.Close() })
	return ep
}

// sendPing injects an IPv4 ICMP message of type typ from the app to dst.
func sendPing(ep *channel.Endpoint, dst netip.Addr, typ header.ICMPv4Type, id, seq uint16, data string) {
	icmp := header.ICMPv4(make([]byte, header.ICMPv4MinimumSize+len(data)))
	icmp.SetType(typ)
	icmp.SetIdent(id)
	icmp.SetSequence(seq)
	copy(icmp.Payload(), data)
	icmp.SetChecksum(^checksum.Checksum(icmp, 0))

	pkt := make([]byte, header.IPv4MinimumSize+len(icmp))
	ip := header.IPv4(pkt)
	ip.Encode(&header.IPv4Fields{
		TotalLength: uint16(len(pkt)),
		TTL:         64,
		Protocol:    uint8(header.ICMPv4ProtocolNumber),
		SrcAddr:     tcpip.AddrFrom4(appAddr.As4()),
		DstAddr:     tcpip.AddrFrom4(dst.As4()),
	})
	ip.SetChecksum(^ip.CalculateChecksum())
	copy(pkt[header.IPv4MinimumSize:], icmp)
	ep.InjectInbound(ipv4.ProtocolNumber, stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(pkt)}))
}

// readPacket returns the next packet the stack sends to the app, or nil after wait.
func readPacket(ep *channel.Endpoint, wait time.Duration) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	pkt := ep.ReadContext(ctx)
	if pkt == nil {
		return nil
	}
	defer pkt.DecRef()
	v := pkt.ToView()
	defer v.Release()
	return append([]byte(nil), v.AsSlice()...)
}

type echoCall struct {
	dst netip.Addr
	msg []byte
}

// recorder is an echoFunc that records its calls and answers with answer(msg).
type recorder struct {
	mu     sync.Mutex
	calls  []echoCall
	answer func(msg []byte) ([]byte, error)
}

func (r *recorder) echo(ctx context.Context, dst netip.Addr, msg []byte) ([]byte, error) {
	r.mu.Lock()
	r.calls = append(r.calls, echoCall{dst, msg})
	r.mu.Unlock()
	return r.answer(msg)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

// realReply is what a host sends back for msg: an echo reply with msg's identifier, sequence number
// and data.
func realReply(msg []byte) []byte {
	r := append([]byte(nil), msg...)
	r[0] = byte(header.ICMPv4EchoReply)
	return r
}

// The bug this replaces: tun2socks answered every ping itself, at once, for any address.
func TestUpstreamHandlerMadeUpPingReplies(t *testing.T) {
	ep := pingStack(t, nil)
	sendPing(ep, netip.MustParseAddr("203.0.113.9"), header.ICMPv4Echo, 1, 1, "x") // TEST-NET-3: nobody is there
	if readPacket(ep, 2*time.Second) == nil {
		t.Skip("this tun2socks no longer answers pings itself; icmpRelay may not be needed")
	}
}

func TestPingGetsTheRealReplyFromTheLink(t *testing.T) {
	rec := &recorder{answer: func(msg []byte) ([]byte, error) {
		r := realReply(msg)
		copy(r[header.ICMPv4MinimumSize:], "REAL") // the host's own data, to tell it from a made-up reply
		return r, nil
	}}
	ep := pingStack(t, newICMPRelay(rec.echo))
	dst := netip.MustParseAddr("1.1.1.1")
	sendPing(ep, dst, header.ICMPv4Echo, 0x1234, 7, "ping")

	pkt := readPacket(ep, 2*time.Second)
	if pkt == nil {
		t.Fatal("no reply reached the app")
	}
	ip := header.IPv4(pkt)
	if !ip.IsValid(len(pkt)) || ip.TransportProtocol() != header.ICMPv4ProtocolNumber {
		t.Fatalf("not an IPv4 ICMP packet: %x", pkt)
	}
	if got := ip.SourceAddress(); got != tcpip.AddrFrom4(dst.As4()) {
		t.Errorf("reply from %v, want %v", got, dst)
	}
	if got := ip.DestinationAddress(); got != tcpip.AddrFrom4(appAddr.As4()) {
		t.Errorf("reply to %v, want the app at %v", got, appAddr)
	}
	icmp := header.ICMPv4(ip.Payload())
	if icmp.Type() != header.ICMPv4EchoReply || icmp.Ident() != 0x1234 || icmp.Sequence() != 7 {
		t.Errorf("reply type %d ident %#x seq %d, want an echo reply to 0x1234/7", icmp.Type(), icmp.Ident(), icmp.Sequence())
	}
	if string(icmp.Payload()) != "REAL" {
		t.Errorf("reply data %q, want the host's", icmp.Payload())
	}
	if checksum.Checksum(icmp, 0) != 0xffff {
		t.Error("reply checksum is wrong")
	}
	if len(rec.calls) != 1 || rec.calls[0].dst != dst {
		t.Fatalf("relayed %+v, want one ping to %v", rec.calls, dst)
	}
	want := []byte{byte(header.ICMPv4Echo), 0}
	if m := rec.calls[0].msg; len(m) != header.ICMPv4MinimumSize+4 || m[0] != want[0] || m[1] != want[1] || string(m[8:]) != "ping" {
		t.Errorf("relayed message %x, want the app's echo request", m)
	}
}

func TestPingWithNoReplyGetsNone(t *testing.T) {
	rec := &recorder{answer: func([]byte) ([]byte, error) { return nil, errors.New("timed out") }}
	ep := pingStack(t, newICMPRelay(rec.echo))
	sendPing(ep, netip.MustParseAddr("203.0.113.9"), header.ICMPv4Echo, 1, 1, "x")
	if pkt := readPacket(ep, 500*time.Millisecond); pkt != nil {
		t.Fatalf("the app got %x for a ping nobody answered", pkt)
	}
	if rec.count() != 1 {
		t.Errorf("relayed %d pings, want 1", rec.count())
	}
}

// A reply that isn't an echo reply (a broken link layer, a bug) is never passed on.
func TestOnlyEchoRepliesArePassedBack(t *testing.T) {
	for name, answer := range map[string][]byte{
		"an echo request": {byte(header.ICMPv4Echo), 0, 0, 0, 0, 1, 0, 1},
		"too short":       {byte(header.ICMPv4EchoReply), 0, 0},
	} {
		t.Run(name, func(t *testing.T) {
			rec := &recorder{answer: func([]byte) ([]byte, error) { return answer, nil }}
			ep := pingStack(t, newICMPRelay(rec.echo))
			sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4Echo, 1, 1, "")
			if pkt := readPacket(ep, 300*time.Millisecond); pkt != nil {
				t.Errorf("passed back %x", pkt)
			}
		})
	}
}

func TestNonEchoICMPIsLeftToTheStack(t *testing.T) {
	rec := &recorder{answer: func(msg []byte) ([]byte, error) { return realReply(msg), nil }}
	relay := newICMPRelay(rec.echo)
	ep := pingStack(t, relay)
	sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4Timestamp, 1, 1, "")
	sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4EchoReply, 1, 1, "")
	readPacket(ep, 300*time.Millisecond)
	if rec.count() != 0 {
		t.Errorf("relayed %d messages that aren't echo requests", rec.count())
	}
}

func TestPingsToManyHostsAtOnceAreNotRelayed(t *testing.T) {
	rec := &recorder{answer: func(msg []byte) ([]byte, error) { return realReply(msg), nil }}
	ep := pingStack(t, newICMPRelay(rec.echo))
	for _, dst := range []string{"224.0.0.1", "239.255.255.250", "255.255.255.255"} {
		sendPing(ep, netip.MustParseAddr(dst), header.ICMPv4Echo, 1, 1, "")
	}
	if pkt := readPacket(ep, 300*time.Millisecond); pkt != nil {
		t.Errorf("the app got %x for a ping to a group", pkt)
	}
	if rec.count() != 0 {
		t.Errorf("relayed %d pings to groups", rec.count())
	}
}

// With echoInFlight pings already waiting, more are dropped rather than piling up sockets.
func TestPingsBeyondTheLimitAreDropped(t *testing.T) {
	release := make(chan struct{})
	var started atomic.Int32
	rec := &recorder{answer: func(msg []byte) ([]byte, error) {
		started.Add(1)
		<-release
		return nil, errors.New("timed out")
	}}
	relay := newICMPRelay(rec.echo)
	relay.inFlight = make(chan struct{}, 2)
	ep := pingStack(t, relay)
	for i := range 5 {
		sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4Echo, 1, uint16(i), "")
	}
	deadline := time.Now().Add(2 * time.Second)
	for started.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if n := started.Load(); n != 2 {
		t.Errorf("%d pings relayed at once, want the limit of 2", n)
	}
	close(release)
	// Once those end, the next ping is relayed again.
	deadline = time.Now().Add(2 * time.Second)
	for len(relay.inFlight) > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4Echo, 1, 9, "")
	for started.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if started.Load() != 3 {
		t.Errorf("after the limit freed up, %d pings relayed in all, want 3", started.Load())
	}
}

func TestRelayGivesUpAtItsWait(t *testing.T) {
	gotDeadline := make(chan time.Duration, 1)
	relay := newICMPRelay(func(ctx context.Context, _ netip.Addr, _ []byte) ([]byte, error) {
		d, _ := ctx.Deadline()
		gotDeadline <- time.Until(d)
		return nil, errors.New("timed out")
	})
	relay.wait = 250 * time.Millisecond
	ep := pingStack(t, relay)
	sendPing(ep, netip.MustParseAddr("1.1.1.1"), header.ICMPv4Echo, 1, 1, "")
	select {
	case d := <-gotDeadline:
		if d <= 0 || d > 250*time.Millisecond {
			t.Errorf("relay deadline in %v, want within its 250ms wait", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the ping was never relayed")
	}
}

type fakePacket struct {
	s   *stack.Stack
	pkt *stack.PacketBuffer
}

func (p fakePacket) Stack() *stack.Stack           { return p.s }
func (p fakePacket) ID() stack.TransportEndpointID { return stack.TransportEndpointID{} }
func (p fakePacket) Buffer() *stack.PacketBuffer   { return p.pkt }

// tun2socks only gives the relay ICMPv4, but anything else it is handed goes back untouched.
func TestRelayLeavesOtherProtocolsAlone(t *testing.T) {
	rec := &recorder{answer: func(msg []byte) ([]byte, error) { return realReply(msg), nil }}
	pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData([]byte{128, 0, 0, 0, 0, 1, 0, 1})})
	pkt.NetworkProtocolNumber = header.IPv6ProtocolNumber
	if newICMPRelay(rec.echo).HandlePacket(fakePacket{pkt: pkt}) {
		t.Error("an ICMPv6 packet was taken as handled")
	}
	if rec.count() != 0 {
		t.Error("an ICMPv6 packet was relayed")
	}
}

// A reply that arrives after the TUN went away, or can't be written, is dropped and counted.
func TestLateRepliesAreDropped(t *testing.T) {
	ep := channel.New(1, 1500, "")
	s, err := core.CreateStack(&core.Config{LinkEndpoint: ep, TransportHandler: noTransport{}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close(); s.Wait() }()
	var nic tcpip.NICID
	for id := range s.NICInfo() {
		nic = id
	}
	host, app := tcpip.AddrFrom4([4]byte{1, 1, 1, 1}), tcpip.AddrFrom4(appAddr.As4())
	reply := realReply([]byte{byte(header.ICMPv4Echo), 0, 0, 0, 0, 1, 0, 1})
	sent := s.Stats().ICMP.V4.PacketsSent

	writeEchoReply(s, nic+7, host, app, reply) // no such NIC: no route
	if sent.EchoReply.Value() != 0 || sent.Dropped.Value() != 0 {
		t.Errorf("with no route: replies %d dropped %d, want nothing sent", sent.EchoReply.Value(), sent.Dropped.Value())
	}

	ep.Close() // the TUN closed while the ping was out
	writeEchoReply(s, nic, host, app, reply)
	if sent.EchoReply.Value() != 0 || sent.Dropped.Value() != 1 {
		t.Errorf("into a closed TUN: replies %d dropped %d, want one dropped", sent.EchoReply.Value(), sent.Dropped.Value())
	}
}

// icmpHandler plugs Balancer.Echo in where the platform can relay pings, and leaves tun2socks'
// handler where it can't (a nil interface, not a typed nil, or tun2socks would call it).
func TestICMPHandlerFollowsThePlatform(t *testing.T) {
	if h := icmpHandler(nil); h != nil {
		t.Errorf("icmpHandler(nil) = %v, want nil", h)
	}
	b := engine.NewBalancer(engine.NewScheduler([]nics.Nic{{Name: "en0", Index: 1 << 20, IP: []byte{192, 0, 2, 1}, Weight: 1}}))
	b.Sticky = engine.NewSticky(true)
	h := icmpHandler(b)
	if !engine.EchoSupported() {
		if h != nil {
			t.Errorf("icmpHandler = %v on a platform without ping relay, want nil", h)
		}
		return
	}
	relay, ok := h.(*icmpRelay)
	if !ok {
		t.Fatalf("icmpHandler = %T, want *icmpRelay", h)
	}
	// The link's index doesn't exist, so the balancer's ping fails; what matters is that it was asked.
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	msg := []byte{byte(header.ICMPv4Echo), 0, 0, 0, 0, 1, 0, 1}
	if _, err := relay.echo(ctx, netip.MustParseAddr("192.0.2.9"), msg); err == nil {
		t.Error("a ping over a missing adapter succeeded")
	}
	if b.Sticky.Sites() == 0 {
		t.Error("with sticky-per-site on, the ping's site was not looked up")
	}
}
