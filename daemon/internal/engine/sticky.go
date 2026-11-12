package engine

import (
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/publicsuffix"
)

// Sticky keeps each site's flows on one link while system merge is on (ADR-0048). Each link has its
// own public address, and a site that sees one visitor arrive from several at once may sign them
// out, ask for a captcha, or break a call. So the first flow to a site is balanced as usual, and the
// site's later flows take the same link, for as long as it can carry them and the site keeps being
// used. Different sites still spread over every link.
//
// A site is the registrable domain (eTLD+1, from the Public Suffix List) of the TLS server name the
// flow asks for, so www.example.com and login.example.com are one site. A flow without a server name
// (plain HTTP, QUIC, anything else) belongs to the site last seen at its address, or else to the
// address alone.
type Sticky struct {
	on  atomic.Bool
	now func() time.Time

	mu    sync.Mutex
	sites map[string]*stickySite    // site → its link
	names map[netip.Addr]stickyName // address → the site last seen there
}

type stickySite struct {
	link string
	used time.Time
}

type stickyName struct {
	site string
	seen time.Time
}

const (
	// StickyIdle is how long a site keeps its link without a new flow.
	StickyIdle = 10 * time.Minute
	// stickyMax caps the sites (and the addresses) remembered; the least recently used go first.
	stickyMax = 4096
)

// NewSticky starts on or off.
func NewSticky(on bool) *Sticky {
	s := &Sticky{now: time.Now, sites: map[string]*stickySite{}, names: map[netip.Addr]stickyName{}}
	s.on.Store(on)
	return s
}

// On reports whether sites are kept on one link. A nil Sticky is off.
func (s *Sticky) On() bool { return s != nil && s.on.Load() }

// SetOn turns it on or off. Turning it off forgets every site, so turning it on again starts afresh.
func (s *Sticky) SetOn(on bool) {
	s.on.Store(on)
	if !on {
		s.mu.Lock()
		clear(s.sites)
		clear(s.names)
		s.mu.Unlock()
	}
}

// SiteOf names a server name's site: its registrable domain, or the name itself when the Public
// Suffix List gives none (a bare suffix, a single label).
func SiteOf(serverName string) string {
	if site, err := publicsuffix.EffectiveTLDPlusOne(serverName); err == nil {
		return site
	}
	return serverName
}

// Site names the site of a flow to dst that asked for serverName ("" when it named none), and
// remembers the address as that site's when it did.
func (s *Sticky) Site(dst netip.Addr, serverName string) string {
	dst = dst.Unmap()
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if serverName != "" {
		site := SiteOf(serverName)
		if dst.IsValid() {
			s.names[dst] = stickyName{site: site, seen: now}
			if len(s.names) > stickyMax {
				pruneOldest(s.names, func(n stickyName) time.Time { return n.seen })
			}
		}
		return site
	}
	if n, ok := s.names[dst]; ok && now.Sub(n.seen) < StickyIdle {
		return n.site
	}
	if !dst.IsValid() {
		return ""
	}
	return dst.String()
}

// Link is the link a site's flows take, or "" when the site has none yet or has been idle too long.
func (s *Sticky) Link(site string) string {
	if site == "" {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.sites[site]
	if !ok {
		return ""
	}
	if s.now().Sub(e.used) >= StickyIdle {
		delete(s.sites, site)
		return ""
	}
	return e.link
}

// acquire picks the link for a site's next flow and, in the same step, makes it the site's link: the
// site's link when it can carry the flow, otherwise whatever choose balances to. Holding the lock across
// the choice is what keeps a site's first burst together: a browser opens several connections to a new
// site at once, and without it each would be balanced before the first had claimed a link. choose is the
// scheduler's AcquireSticky, which never calls back here, so the two locks can't deadlock.
func (s *Sticky) acquire(site string, choose func(prefer string) *Slot) *Slot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	prefer := ""
	if e, ok := s.sites[site]; ok && now.Sub(e.used) < StickyIdle {
		prefer = e.link
	}
	sl := choose(prefer)
	if sl != nil && s.On() {
		s.sites[site] = &stickySite{link: sl.key, used: now}
		if len(s.sites) > stickyMax {
			pruneOldest(s.sites, func(e *stickySite) time.Time { return e.used })
		}
	}
	return sl
}

// Remember records that a site's flow went out over link: its next flows take the same one.
func (s *Sticky) Remember(site, link string) {
	if site == "" || link == "" || !s.On() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sites[site] = &stickySite{link: link, used: s.now()}
	if len(s.sites) > stickyMax {
		pruneOldest(s.sites, func(e *stickySite) time.Time { return e.used })
	}
}

// Sites is how many sites are kept on a link now (for status and tests).
func (s *Sticky) Sites() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sites)
}

// pruneOldest drops the least recently used tenth of m.
func pruneOldest[K comparable, V any](m map[K]V, when func(V) time.Time) {
	drop := len(m) / 10
	if drop < 1 {
		drop = 1
	}
	for ; drop > 0; drop-- {
		var oldest K
		var at time.Time
		first := true
		for k, v := range m {
			if t := when(v); first || t.Before(at) {
				oldest, at, first = k, t, false
			}
		}
		delete(m, oldest)
	}
}
