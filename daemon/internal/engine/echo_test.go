package engine

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// fakeEchoConn is a connected ICMP socket whose "network" answers with the packets in replies,
// one per Read, after the request has been written. With none left, Read waits for the deadline.
type fakeEchoConn struct {
	net.Conn // nil: only the methods below are used
	mu       sync.Mutex
	wrote    [][]byte
	replies  [][]byte
	sent     chan struct{}
	deadline time.Time
	closed   bool
	writeErr error
	// deadlineErr fails SetDeadline, as a socket closed under the relay would.
	deadlineErr error
}

func newFakeEchoConn(replies ...[]byte) *fakeEchoConn {
	return &fakeEchoConn{replies: replies, sent: make(chan struct{})}
}

func (c *fakeEchoConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writeErr != nil {
		return 0, c.writeErr
	}
	c.wrote = append(c.wrote, append([]byte(nil), p...))
	if len(c.wrote) == 1 {
		close(c.sent)
	}
	return len(p), nil
}

func (c *fakeEchoConn) Read(p []byte) (int, error) {
	<-c.sent
	c.mu.Lock()
	if len(c.replies) > 0 {
		r := c.replies[0]
		c.replies = c.replies[1:]
		c.mu.Unlock()
		return copy(p, r), nil
	}
	d := c.deadline
	c.mu.Unlock()
	for time.Now().Before(d) {
		time.Sleep(5 * time.Millisecond)
		c.mu.Lock()
		d = c.deadline
		c.mu.Unlock()
	}
	return 0, os.ErrDeadlineExceeded
}

func (c *fakeEchoConn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deadlineErr != nil {
		return c.deadlineErr
	}
	c.deadline = t
	return nil
}

func (c *fakeEchoConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

func (c *fakeEchoConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

type echoOpen struct {
	idx      int
	src, dst string
}

// useFakeEcho swaps openEcho for one that records each call and returns conns[name of the link's
// index] (or errs[index]); it restores the real one when the test ends.
func useFakeEcho(t *testing.T, conns map[int]*fakeEchoConn, errs map[int]error) *[]echoOpen {
	t.Helper()
	old := openEcho
	t.Cleanup(func() { openEcho = old })
	var mu sync.Mutex
	var calls []echoOpen
	openEcho = func(idx int, src, dst net.IP) (net.Conn, error) {
		mu.Lock()
		calls = append(calls, echoOpen{idx, src.String(), dst.String()})
		mu.Unlock()
		if err := errs[idx]; err != nil {
			return nil, err
		}
		if c := conns[idx]; c != nil {
			return c, nil
		}
		return nil, errors.New("no fake conn for this index")
	}
	return &calls
}

// echoMsg is an ICMP message of the given type with identifier id, sequence seq and data.
func echoMsg(typ byte, id, seq uint16, data string) []byte {
	m := []byte{typ, 0, 0, 0, byte(id >> 8), byte(id), byte(seq >> 8), byte(seq)}
	return append(m, data...)
}

func TestEchoSendsTheAppsMessageAndReturnsTheMatchingReply(t *testing.T) {
	want := echoMsg(icmpEchoReply, 0x1234, 7, "ping-data")
	c := newFakeEchoConn(
		echoMsg(icmpEchoRequest, 0x1234, 7, "ping-data"), // our own request, seen on a loopback
		echoMsg(icmpEchoReply, 0x9999, 7, "other"),       // another ping's reply
		echoMsg(icmpEchoReply, 0x1234, 6, "late"),        // an earlier reply of this ping
		[]byte{icmpEchoReply, 0, 0},                      // too short to be anything
		echoMsg(3, 0x1234, 7, ""),                        // an ICMP error
		want,
	)
	calls := useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	s := NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)})
	b := NewBalancer(s)

	msg := echoMsg(icmpEchoRequest, 0x1234, 7, "ping-data")
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	got, err := b.Echo(ctx, netip.MustParseAddr("1.1.1.1"), msg, "")
	if err != nil {
		t.Fatalf("Echo = %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("reply = %x, want %x", got, want)
	}
	if len(c.wrote) != 1 || string(c.wrote[0]) != string(msg) {
		t.Errorf("sent %x, want the app's message %x unchanged", c.wrote, msg)
	}
	if want := []echoOpen{{11, "192.168.1.23", "1.1.1.1"}}; len(*calls) != 1 || (*calls)[0] != want[0] {
		t.Errorf("opened %+v, want %+v (pinned to the link's index and address)", *calls, want)
	}
	if !c.isClosed() {
		t.Error("the socket was left open")
	}
	sl := s.slots[0]
	if sl.bytesOut[Fam4].Load() != int64(len(msg)) || sl.bytesIn[Fam4].Load() == 0 {
		t.Errorf("link counters out %d in %d; want the ping counted on its link", sl.bytesOut[Fam4].Load(), sl.bytesIn[Fam4].Load())
	}
	if sl.active.Load() != 0 {
		t.Errorf("a ping kept %d balancing slots", sl.active.Load())
	}
}

func TestEchoWithoutAReplyFailsAtTheDeadline(t *testing.T) {
	c := newFakeEchoConn(echoMsg(icmpEchoReply, 1, 2, "not ours"))
	useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))

	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := b.Echo(ctx, netip.MustParseAddr("203.0.113.9"), echoMsg(icmpEchoRequest, 1, 1, "x"), "")
	if err == nil {
		t.Fatal("Echo with no reply succeeded")
	}
	if since := time.Since(start); since > 2*time.Second {
		t.Errorf("Echo took %v; it should give up at the context's deadline", since)
	}
	if !c.isClosed() {
		t.Error("the socket was left open")
	}
}

// A ping whose context is cancelled before its deadline stops waiting at once.
func TestEchoStopsWhenItsContextIsCancelled(t *testing.T) {
	c := newFakeEchoConn()
	useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))

	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	time.AfterFunc(100*time.Millisecond, cancel)
	start := time.Now()
	_, err := b.Echo(ctx, netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, "x"), "")
	if !errors.Is(err, context.Canceled) {
		t.Errorf("Echo = %v, want context.Canceled", err)
	}
	if since := time.Since(start); since > 5*time.Second {
		t.Errorf("Echo took %v after its context was cancelled", since)
	}
}

// Without a deadline on its context, Echo still gives up by itself.
func TestEchoWithoutADeadlineStillEnds(t *testing.T) {
	c := newFakeEchoConn(echoMsg(icmpEchoReply, 1, 1, "x"))
	useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	if _, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, "x"), ""); err != nil {
		t.Fatalf("Echo = %v", err)
	}
	if c.deadline.IsZero() {
		t.Error("no deadline was set on the socket")
	}
}

func TestEchoMovesToAnotherLinkWhenOneIsDown(t *testing.T) {
	good := newFakeEchoConn(echoMsg(icmpEchoReply, 5, 5, ""))
	calls := useFakeEcho(t, map[int]*fakeEchoConn{12: good}, map[int]error{11: syscall.ENETDOWN})
	s := NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11), nicAt("en7", "172.20.10.2", 12)})
	b := NewBalancer(s)
	// en0 first, whatever the tie-breaking: en7 is busy.
	s.slots[1].active.Add(5)
	s.slots[1].actF[Fam4].Add(5)

	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if _, err := b.Echo(ctx, netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 5, 5, ""), ""); err != nil {
		t.Fatalf("Echo = %v", err)
	}
	if len(*calls) != 2 || (*calls)[0].idx != 11 || (*calls)[1].idx != 12 {
		t.Fatalf("opened %+v, want en0 (index 11) then en7 (index 12)", *calls)
	}
	if snap := s.Snapshot(); snap[0].Failed != 1 || snap[1].Failed != 0 {
		t.Errorf("failures en0 %d en7 %d after en0's ENETDOWN; want en0 sidelined once", snap[0].Failed, snap[1].Failed)
	}
}

func TestEchoReportsTheLastErrorWhenNoLinkWorks(t *testing.T) {
	useFakeEcho(t, nil, map[int]error{11: syscall.EACCES})
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	_, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, ""), "")
	if !errors.Is(err, syscall.EACCES) {
		t.Errorf("Echo = %v, want the open error", err)
	}

	b = NewBalancer(NewScheduler(nil))
	if _, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, ""), ""); err == nil {
		t.Error("Echo with no links succeeded")
	}
}

func TestEchoReportsAFailedSend(t *testing.T) {
	c := newFakeEchoConn()
	c.writeErr = syscall.EHOSTUNREACH
	useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	if _, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, ""), ""); !errors.Is(err, syscall.EHOSTUNREACH) {
		t.Errorf("Echo = %v, want the send error", err)
	}
}

func TestEchoSendsNothingOnASocketWithoutDeadlines(t *testing.T) {
	c := newFakeEchoConn()
	c.deadlineErr = net.ErrClosed
	useFakeEcho(t, map[int]*fakeEchoConn{11: c}, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	if _, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, ""), ""); !errors.Is(err, net.ErrClosed) {
		t.Errorf("Echo = %v, want the deadline error", err)
	}
	if len(c.wrote) != 0 {
		t.Error("a ping was sent on a socket that could not be given a deadline: it could wait forever")
	}
	if !c.isClosed() {
		t.Error("the socket was left open")
	}
}

func TestEchoRefusesWhatIsNotAnIPv4EchoRequest(t *testing.T) {
	calls := useFakeEcho(t, nil, nil)
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	for _, c := range []struct {
		name string
		dst  string
		msg  []byte
	}{
		{"IPv6 destination", "2001:db8::1", echoMsg(icmpEchoRequest, 1, 1, "")},
		{"echo reply", "1.1.1.1", echoMsg(icmpEchoReply, 1, 1, "")},
		{"too short", "1.1.1.1", []byte{icmpEchoRequest, 0, 0, 0}},
	} {
		if _, err := b.Echo(t.Context(), netip.MustParseAddr(c.dst), c.msg, ""); !errors.Is(err, errNotEcho) {
			t.Errorf("%s: Echo = %v, want errNotEcho", c.name, err)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("opened %d sockets for messages that aren't echo requests", len(*calls))
	}
}

func TestEchoWhereThePlatformCannot(t *testing.T) {
	old := openEcho
	defer func() { openEcho = old }()
	openEcho = nil
	if EchoSupported() {
		t.Error("EchoSupported with no opener")
	}
	b := NewBalancer(NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11)}))
	if _, err := b.Echo(t.Context(), netip.MustParseAddr("1.1.1.1"), echoMsg(icmpEchoRequest, 1, 1, ""), ""); err != ErrEchoUnsupported {
		t.Errorf("Echo = %v, want ErrEchoUnsupported", err)
	}
}

// While sticky-per-site is on, a site's pings go over its link and teach it one.
func TestEchoKeepsASiteOnItsLink(t *testing.T) {
	en0 := newFakeEchoConn(echoMsg(icmpEchoReply, 1, 1, ""), echoMsg(icmpEchoReply, 1, 2, ""))
	en7 := newFakeEchoConn(echoMsg(icmpEchoReply, 1, 1, ""), echoMsg(icmpEchoReply, 1, 2, ""))
	calls := useFakeEcho(t, map[int]*fakeEchoConn{11: en0, 12: en7}, nil)
	s := NewScheduler([]nics.Nic{nicAt("en0", "192.168.1.23", 11), nicAt("en7", "172.20.10.2", 12)})
	b := NewBalancer(s)
	b.Sticky = NewSticky(true)
	dst := netip.MustParseAddr("1.1.1.1")
	site := b.Sticky.Site(dst, "")

	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if _, err := b.Echo(ctx, dst, echoMsg(icmpEchoRequest, 1, 1, ""), site); err != nil {
		t.Fatalf("first Echo = %v", err)
	}
	first := (*calls)[0].idx
	link := b.Sticky.Link(site)
	if link == "" {
		t.Fatal("the site's link was not remembered")
	}
	// Load the link the site is on: a balanced pick would now take the other one.
	for _, sl := range s.slots {
		if sl.Index() == first {
			sl.active.Add(5)
			sl.actF[Fam4].Add(5)
		}
	}
	// Each fake conn answers seq 1 then seq 2; a second open of the same link reuses it.
	if _, err := b.Echo(ctx, dst, echoMsg(icmpEchoRequest, 1, 2, ""), site); err != nil {
		t.Fatalf("second Echo = %v", err)
	}
	if second := (*calls)[1].idx; second != first {
		t.Errorf("second ping went over index %d, want the site's link (index %d)", second, first)
	}
}
