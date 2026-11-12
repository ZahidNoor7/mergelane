package tun

import (
	"net/netip"
	"sync"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"

	M "github.com/xjasonlyu/tun2socks/v2/metadata"
)

// Sticky-per-site (ADR-0048) needs to know which site an HTTPS flow is for before it is dialed out.
// The userland stack completes the client's handshake itself, so the client's ClientHello is read
// first (engine.SniffServerName) and replayed to the real connection afterwards. tun2socks only hands
// the dialer the flow's addresses, so the name waits here, keyed by them, for tunProxy.DialContext.

// httpsPort is the only port read: elsewhere a server may speak first, and waiting would delay it.
const httpsPort = 443

// sniffWait is how long a client gets to send its ClientHello. The handshake is with this Mac's own
// stack, so a browser's arrives at once; waiting only happens to a client that sends nothing first.
const sniffWait = 300 * time.Millisecond

type flowKey struct{ src, dst netip.AddrPort }

// serverNames holds each sniffed flow's server name until its dial takes it.
var serverNames sync.Map // flowKey → string

func addrOf(a tcpip.Address) netip.Addr {
	ip, _ := netip.AddrFromSlice(a.AsSlice())
	return ip
}

// keyOfEndpoint is the flow's key as the stack sees it: the client is the remote end.
func keyOfEndpoint(id stack.TransportEndpointID) flowKey {
	return flowKey{
		src: netip.AddrPortFrom(addrOf(id.RemoteAddress), id.RemotePort),
		dst: netip.AddrPortFrom(addrOf(id.LocalAddress), id.LocalPort),
	}
}

// keyOfMetadata is the same flow's key as tun2socks hands it to the dialer.
func keyOfMetadata(m *M.Metadata) flowKey {
	return flowKey{src: netip.AddrPortFrom(m.SrcIP, m.SrcPort), dst: netip.AddrPortFrom(m.DstIP, m.DstPort)}
}

// takeServerName returns (and forgets) the server name sniffed for the flow, "" if there was none.
func takeServerName(m *M.Metadata) string {
	if v, ok := serverNames.LoadAndDelete(keyOfMetadata(m)); ok {
		return v.(string)
	}
	return ""
}

// replayConn gives back the bytes read while sniffing before reading on.
type replayConn struct {
	*tcpConn
	pending []byte
}

func (c *replayConn) Read(p []byte) (int, error) {
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	return c.tcpConn.Read(p)
}
