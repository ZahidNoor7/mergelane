package engine

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// stickyAt is a Sticky whose clock the test moves.
func stickyAt(on bool) (*Sticky, *time.Time) {
	clock := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	s := NewSticky(on)
	s.now = func() time.Time { return clock }
	return s, &clock
}

func TestSiteOfIsTheRegistrableDomain(t *testing.T) {
	cases := map[string]string{
		"www.example.com":       "example.com",
		"login.example.com":     "example.com",
		"example.com":           "example.com",
		"a.b.bbc.co.uk":         "bbc.co.uk",
		"user.github.io":        "user.github.io", // a public suffix of its own (the PSL's private section)
		"co.uk":                 "co.uk",          // a bare suffix: the name itself
		"localhost":             "localhost",
		"cdn.shop.example.com.": "cdn.shop.example.com.", // not cleaned here: the parser gives clean names
	}
	for name, want := range cases {
		if got := SiteOf(name); got != want {
			t.Errorf("SiteOf(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSiteLearnsAddressesFromServerNames(t *testing.T) {
	s, clock := stickyAt(true)
	addr := netip.MustParseAddr("203.0.113.7")
	if got := s.Site(addr, ""); got != "203.0.113.7" {
		t.Fatalf("an address never seen with a name is its own site, got %q", got)
	}
	if got := s.Site(netip.MustParseAddr("::ffff:203.0.113.7"), "www.example.com"); got != "example.com" {
		t.Fatalf("site = %q", got)
	}
	// QUIC or plain HTTP to the same address: the site seen there.
	if got := s.Site(addr, ""); got != "example.com" {
		t.Fatalf("site without a name = %q, want example.com", got)
	}
	*clock = clock.Add(StickyIdle)
	if got := s.Site(addr, ""); got != "203.0.113.7" {
		t.Fatalf("a name seen too long ago still counted: %q", got)
	}
	if got := s.Site(netip.Addr{}, ""); got != "" {
		t.Fatalf("no address and no name gave %q", got)
	}
	if got := s.Site(netip.Addr{}, "x.example.org"); got != "example.org" {
		t.Fatalf("a name without an address gave %q", got)
	}
}

func TestLinkIsKeptWhileTheSiteIsUsed(t *testing.T) {
	s, clock := stickyAt(true)
	if s.Link("example.com") != "" || s.Link("") != "" {
		t.Fatal("a site never seen has a link")
	}
	s.Remember("example.com", "en0")
	s.Remember("", "en0")
	s.Remember("example.org", "")
	if got := s.Link("example.com"); got != "en0" || s.Sites() != 1 {
		t.Fatalf("link = %q, sites = %d", got, s.Sites())
	}
	*clock = clock.Add(StickyIdle - time.Second)
	s.Remember("example.com", "en0") // a new flow keeps it fresh
	*clock = clock.Add(StickyIdle - time.Second)
	if got := s.Link("example.com"); got != "en0" {
		t.Fatalf("a site in use lost its link: %q", got)
	}
	*clock = clock.Add(StickyIdle)
	if got := s.Link("example.com"); got != "" || s.Sites() != 0 {
		t.Fatalf("an idle site kept its link: %q", got)
	}
}

func TestTurningStickyOffForgetsEverySite(t *testing.T) {
	s, _ := stickyAt(true)
	s.Remember("example.com", "en0")
	s.Site(netip.MustParseAddr("192.0.2.1"), "a.example.com")
	s.SetOn(false)
	if s.On() || s.Sites() != 0 || len(s.names) != 0 {
		t.Fatal("off kept what it knew")
	}
	s.Remember("example.com", "en0") // off: nothing is kept
	if s.Sites() != 0 {
		t.Fatal("remembered while off")
	}
	s.SetOn(true)
	if !s.On() {
		t.Fatal("not on again")
	}
	var none *Sticky
	if none.On() || none.Sites() != 0 {
		t.Fatal("a nil Sticky is on")
	}
}

func TestStickyForgetsTheLeastRecentlyUsedWhenFull(t *testing.T) {
	s, clock := stickyAt(true)
	for i := range stickyMax + 1 {
		*clock = clock.Add(time.Millisecond)
		site := fmt.Sprintf("site%d.example", i)
		s.Remember(site, "en0")
		s.Site(netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)}), "a."+site)
	}
	if s.Sites() > stickyMax || len(s.names) > stickyMax {
		t.Fatalf("kept %d sites and %d addresses, more than %d", s.Sites(), len(s.names), stickyMax)
	}
	if s.Link("site0.example") != "" {
		t.Fatal("the oldest site was kept")
	}
	if s.Link(fmt.Sprintf("site%d.example", stickyMax)) != "en0" {
		t.Fatal("the newest site was dropped")
	}
}

func TestAcquireStickyKeepsTheSiteOnItsLink(t *testing.T) {
	s, clock := clocked(nic("A", "10.0.0.1", 1), nic("B", "10.0.0.2", 1))
	a, b := s.slots[0], s.slots[1]
	s.SetState(a, Fam4, true)
	s.SetState(b, Fam4, true)
	// A is busier, but the site stays on it.
	for range 5 {
		if got := s.AcquireSticky(Fam4, nil, a.Key()); got != a {
			t.Fatalf("picked %s, want the site's link A", got.Name)
		}
	}
	// Without a preference the usual balance applies: B is idle.
	if got := s.AcquireSticky(Fam4, nil, ""); got != b {
		t.Fatalf("picked %s, want the idle B", got.Name)
	}
	if got := s.AcquireSticky(Fam4, nil, "gone"); got == nil {
		t.Fatal("an unknown link gave no pick")
	}
	// Skipped (a failover), or in a failure cooldown while another is up: balanced instead.
	if got := s.AcquireSticky(Fam4, map[string]struct{}{a.Key(): {}}, a.Key()); got != b {
		t.Fatalf("a skipped link was picked: %s", got.Name)
	}
	s.Fail(a, Fam4, time.Minute)
	if got := s.AcquireSticky(Fam4, nil, a.Key()); got != b {
		t.Fatalf("a link in cooldown kept its site: %s", got.Name)
	}
	// Not probed yet counts as able: it stays.
	*clock = clock.Add(2 * time.Minute)
	s.mu.Lock()
	a.state[Fam4] = stateUnknown
	s.mu.Unlock()
	if got := s.AcquireSticky(Fam4, nil, a.Key()); got != a {
		t.Fatalf("an unprobed link lost its site to %s", got.Name)
	}
	// When every link looks dead, the site's own is as good as any.
	s.SetState(a, Fam4, false)
	s.SetState(b, Fam4, false)
	if got := s.AcquireSticky(Fam4, nil, a.Key()); got != a {
		t.Fatalf("with every link down, picked %s", got.Name)
	}
	// A link without an address of the family can't keep it.
	if got := s.AcquireSticky(Fam6, nil, a.Key()); got != nil {
		t.Fatalf("IPv6 picked %s on IPv4-only links", got.Name)
	}
}

// A browser opens several connections to a new site at once. They must all land on one link: the
// first one's choice is the site's before the others choose (found on the owner's Mac, M3.8).
func TestASitesFirstBurstStaysTogether(t *testing.T) {
	s := NewScheduler([]nics.Nic{nic("A", "10.0.0.1", 1), nic("B", "10.0.0.2", 1), nic("C", "10.0.0.3", 1)})
	for _, sl := range s.slots {
		s.SetState(sl, Fam4, true)
	}
	sticky := NewSticky(true)
	const burst = 32
	got := make(chan *Slot, burst)
	start := make(chan struct{})
	for range burst {
		go func() {
			<-start
			got <- sticky.acquire("example.com", func(prefer string) *Slot { return s.AcquireSticky(Fam4, nil, prefer) })
		}()
	}
	close(start)
	first := <-got
	for range burst - 1 {
		if sl := <-got; sl != first {
			t.Fatalf("the burst split: %s and %s", first.Name, sl.Name)
		}
	}
	if sticky.Link("example.com") != first.Key() {
		t.Fatal("the site's link isn't the burst's")
	}
	// Off: acquire still picks, but keeps nothing.
	sticky.SetOn(false)
	if sl := sticky.acquire("example.org", func(string) *Slot { return s.AcquireFor(Fam4, nil) }); sl == nil || sticky.Sites() != 0 {
		t.Fatal("off kept a site, or picked nothing")
	}
	// No link at all: nothing kept.
	sticky.SetOn(true)
	if sl := sticky.acquire("example.net", func(string) *Slot { return nil }); sl != nil || sticky.Link("example.net") != "" {
		t.Fatal("a site was kept without a link")
	}
}

func TestDialSiteFailsOverAndMovesTheSite(t *testing.T) {
	lo := loopbackNic(t)
	ln := acceptingListener(t)
	port := ln.Addr().(*net.TCPAddr).Port
	s := NewScheduler([]nics.Nic{nic("bad", "203.0.113.9", 1), lo})
	bad, good := s.slots[0], s.slots[1]
	s.SetState(bad, Fam4, true)
	s.SetState(good, Fam4, true)
	b := NewBalancer(s)
	b.ConnectTimeout = 2 * time.Second
	b.Sticky = NewSticky(true)
	ctx := context.Background()

	// The site was on "bad", which can't bind its address any more: the dial fails over to lo0, and
	// the site moves with it.
	b.Sticky.Remember("example.com", bad.Key())
	c, err := b.DialPinnedSite(ctx, "127.0.0.1", port, "example.com")
	if err != nil {
		t.Fatalf("dial = %v", err)
	}
	c.Close()
	if got := b.Sticky.Link("example.com"); got != good.Key() {
		t.Fatalf("the site is on %q, want %q", got, good.Key())
	}
	// Its next flows, and its QUIC, stay there.
	for range 3 {
		c, err := b.DialPinnedSite(ctx, "127.0.0.1", port, "example.com")
		if err != nil {
			t.Fatal(err)
		}
		if got := c.(*slotConn).sl; got != good {
			t.Fatalf("a later flow went over %s", got.Name)
		}
		c.Close()
	}
	pc, err := b.ListenUDPSite(ctx, Fam4, "example.com")
	if err != nil {
		t.Fatalf("UDP = %v", err)
	}
	if got := pc.(*slotPacketConn).sl; got != good {
		t.Fatalf("the site's UDP went over %s", got.Name)
	}
	pc.Close()

	// Another site's UDP is remembered too; off, nothing is.
	pc, err = b.ListenUDPSite(ctx, Fam4, "example.org")
	if err != nil {
		t.Fatal(err)
	}
	pc.Close()
	if b.Sticky.Link("example.org") == "" {
		t.Fatal("a site's first UDP socket wasn't remembered")
	}
	b.Sticky.SetOn(false)
	c, err = b.DialPinnedSite(ctx, "127.0.0.1", port, "example.net")
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	b.Sticky.SetOn(true)
	if b.Sticky.Link("example.net") != "" {
		t.Fatal("a site was remembered while sticky was off")
	}
}
