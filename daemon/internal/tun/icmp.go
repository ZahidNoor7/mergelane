package tun

import (
	"context"
	"net/netip"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/checksum"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"

	"github.com/xjasonlyu/tun2socks/v2/core/adapter"

	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
)

// Mergelane: ping through the merged network gets the real answer.
//
// tun2socks' own ICMP handler (core/icmp.go) answers every IPv4 echo request itself, at once, for any
// address. So while system merge was on, `ping` said every host was up in under a millisecond, even
// a host that doesn't exist or with every link dead, and nothing ICMP ever left the Mac. icmpRelay
// takes its place: each echo request goes out through a link (engine.Balancer.Echo), and only a real
// reply is passed back. A ping with no reply gets none, as without Mergelane.

const (
	// echoWait is how long a relayed ping waits for its reply. ping's own default wait is 10 s for
	// the last packet only; most tools give up sooner, and a reply that late is reported lost anyway.
	echoWait = 5 * time.Second
	// echoInFlight bounds the pings being relayed at once. Each holds a socket and a goroutine until
	// its reply or echoWait; beyond this a request is dropped, as on a congested link.
	echoInFlight = 128
)

// icmpHandler returns the ping relay for the TUN's stack, or nil where the platform can't relay
// pings yet (Windows), which keeps tun2socks' own handler there.
func icmpHandler(b *engine.Balancer) adapter.NetworkHandler {
	if b == nil || !engine.EchoSupported() {
		return nil
	}
	return newICMPRelay(func(ctx context.Context, dst netip.Addr, msg []byte) ([]byte, error) {
		site := ""
		if b.Sticky.On() {
			site = b.Sticky.Site(dst, "")
		}
		return b.Echo(ctx, dst, msg, site)
	})
}

type echoFunc func(ctx context.Context, dst netip.Addr, msg []byte) ([]byte, error)

type icmpRelay struct {
	echo     echoFunc
	wait     time.Duration
	inFlight chan struct{}
}

func newICMPRelay(echo echoFunc) *icmpRelay {
	return &icmpRelay{echo: echo, wait: echoWait, inFlight: make(chan struct{}, echoInFlight)}
}

// HandlePacket takes every IPv4 echo request the stack receives. It returns true (handled, so
// tun2socks sends no reply of its own) for all of them, relayed or dropped, and false for any other
// ICMP, which tun2socks then handles as before.
func (r *icmpRelay) HandlePacket(p adapter.Packet) bool {
	pkt := p.Buffer() // tun2socks hands us a clone of its own
	defer pkt.DecRef()
	if pkt.NetworkProtocolNumber != ipv4.ProtocolNumber {
		return false
	}
	icmp := header.ICMPv4(pkt.TransportHeader().Slice())
	if len(icmp) < header.ICMPv4MinimumSize || icmp.Type() != header.ICMPv4Echo {
		return false
	}
	ip := header.IPv4(pkt.NetworkHeader().Slice())
	src, dst := ip.SourceAddress(), ip.DestinationAddress()
	to := netip.AddrFrom4(dst.As4())
	if pkt.NetworkPacketInfo.LocalAddressBroadcast || to.IsMulticast() || to.IsUnspecified() || dst == header.IPv4Broadcast {
		return true // nothing to relay to one host; and no made-up answer either
	}
	payload := stack.PayloadSince(pkt.TransportHeader())
	msg := append([]byte(nil), payload.AsSlice()...)
	payload.Release()

	select {
	case r.inFlight <- struct{}{}:
	default:
		return true // too many pings in flight: this one is lost
	}
	s, nic := p.Stack(), pkt.NICID
	go func() {
		defer func() { <-r.inFlight }()
		ctx, cancel := context.WithTimeout(context.Background(), r.wait)
		defer cancel()
		reply, err := r.echo(ctx, to, msg)
		if err != nil {
			return
		}
		writeEchoReply(s, nic, dst, src, reply)
	}()
	return true
}

// writeEchoReply sends reply into the TUN as from host to the app at app, as tun2socks' own handler
// sends its made-up one (core/icmp.go, handlePacket4). The checksum is set again in case reply
// isn't exactly what the host sent.
func writeEchoReply(s *stack.Stack, nic tcpip.NICID, host, app tcpip.Address, reply []byte) {
	if len(reply) < header.ICMPv4MinimumSize || header.ICMPv4(reply).Type() != header.ICMPv4EchoReply {
		return
	}
	r, err := s.FindRoute(nic, host, app, ipv4.ProtocolNumber, false /* multicastLoop */)
	if err != nil {
		return
	}
	defer r.Release()
	h := header.ICMPv4(reply)
	h.SetChecksum(0)
	h.SetChecksum(^checksum.Checksum(reply, 0))
	pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
		ReserveHeaderBytes: int(r.MaxHeaderLength()),
		Payload:            buffer.MakeWithData(reply),
	})
	defer pkt.DecRef()
	sent := s.Stats().ICMP.V4.PacketsSent
	if err := r.WritePacket(stack.NetworkHeaderParams{Protocol: header.ICMPv4ProtocolNumber, TTL: r.DefaultTTL()}, pkt); err != nil {
		sent.Dropped.Increment()
		return
	}
	sent.EchoReply.Increment()
}
