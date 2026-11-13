package engine

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"
)

// ICMPv4 types the relay reads (RFC 792).
const (
	icmpEchoReply   = 0
	icmpEchoRequest = 8
	icmpHeaderLen   = 8
)

// ErrEchoUnsupported is returned by Echo where the platform has no pinned ICMP socket yet.
var ErrEchoUnsupported = errors.New("relaying ping is not supported on this platform")

var errNotEcho = errors.New("not an IPv4 echo request")

// openEcho opens an ICMP socket pinned to the adapter with index idx and source address src, and
// connected to dst, the way DialSite pins a TCP flow. Reads return ICMP messages without the IP
// header. A platform that has one sets it in init (echo_darwin.go); nil means ErrEchoUnsupported.
var openEcho func(idx int, src, dst net.IP) (net.Conn, error)

// EchoSupported tells whether Echo can work on this platform.
func EchoSupported() bool { return openEcho != nil }

// Echo relays one ping (an ICMP echo request) through a link and returns the real reply.
//
// msg is the app's whole ICMP message, sent unchanged, so the reply carries the app's own identifier,
// sequence number and data (ping times its replies from that data). The link is picked like a UDP
// flow's: balanced, or the site's link while sticky-per-site is on and site is set. A link that
// can't open the socket is skipped, and sidelined if the error says it is down. Echo waits until
// the reply with the same identifier and sequence number arrives or ctx ends; with no reply, it
// returns an error and the app sees its ping lost, as it would without Mergelane.
func (b *Balancer) Echo(ctx context.Context, dst netip.Addr, msg []byte, site string) ([]byte, error) {
	if openEcho == nil {
		return nil, ErrEchoUnsupported
	}
	if !dst.Is4() || len(msg) < icmpHeaderLen || msg[0] != icmpEchoRequest {
		return nil, errNotEcho
	}
	sticky := site != "" && b.Sticky.On()
	tried := map[string]struct{}{}
	var lastErr error = errors.New("no usable network adapter")
	for {
		var sl *Slot
		if sticky {
			sl = b.Sticky.acquire(site, func(prefer string) *Slot { return b.S.AcquireSticky(Fam4, tried, prefer) })
		} else {
			sl = b.S.AcquireFor(Fam4, tried)
		}
		if sl == nil {
			return nil, lastErr
		}
		tried[sl.key] = struct{}{}
		c, err := openEcho(sl.Index(), sl.ip(Fam4), dst.AsSlice())
		b.S.ReleaseFor(sl, Fam4) // a ping holds no balancing slot, like a UDP socket
		if err != nil {
			if classify(err).linkDown {
				b.S.Fail(sl, Fam4, b.FailCooldown)
			}
			lastErr = err
			continue
		}
		if sticky {
			b.Sticky.Remember(site, sl.key)
		}
		defer c.Close()
		return exchangeEcho(ctx, c, sl, msg)
	}
}

// exchangeEcho sends msg on c and returns the first echo reply that matches its identifier and
// sequence number. Anything else that arrives (another ping's reply, an ICMP error) is skipped.
func exchangeEcho(ctx context.Context, c net.Conn, sl *Slot, msg []byte) ([]byte, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}
	if err := c.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { c.SetDeadline(time.Now()) })
	defer stop()

	sl.throttlePacket(false, len(msg))
	n, err := c.Write(msg)
	sl.bytesOut[Fam4].Add(int64(n))
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 64<<10)
	for {
		n, err := c.Read(buf)
		if n > 0 {
			sl.bytesIn[Fam4].Add(int64(n))
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		if n >= icmpHeaderLen && buf[0] == icmpEchoReply && buf[1] == 0 && string(buf[4:8]) == string(msg[4:8]) {
			return append([]byte(nil), buf[:n]...), nil
		}
	}
}
