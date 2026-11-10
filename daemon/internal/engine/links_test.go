package engine

import (
	"net"
	"slices"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// Links that come back (M2.4): unplugged and plugged in again, asleep and awake, or re-created by
// the OS with a new interface index. These drive Update the way the daemon's re-scan does, with
// fake discovery results.

func nicAt(name, ip string, index int) nics.Nic {
	return nics.Nic{Name: name, Index: index, IP: net.ParseIP(ip), Weight: 1}
}

// clocked returns a scheduler whose clock the test moves.
func clocked(found ...nics.Nic) (*Scheduler, *time.Time) {
	clock := time.Date(2026, 11, 10, 9, 30, 0, 0, time.UTC)
	s := &Scheduler{now: func() time.Time { return clock }}
	s.Update(found)
	return s, &clock
}

type ev struct{ link, from, to, reason string }

func eventsOf(s *Scheduler) []ev {
	var out []ev
	for _, e := range s.Events() {
		out = append(out, ev{e.Link, e.From, e.To, e.Reason})
	}
	return out
}

func assertEvents(t *testing.T, s *Scheduler, want ...ev) {
	t.Helper()
	if got := eventsOf(s); !slices.Equal(got, want) {
		t.Fatalf("events =\n  %v\nwant\n  %v", got, want)
	}
}

func TestALinkThatComesBackIsCheckedAgainAtOnce(t *testing.T) {
	s, clock := clocked(nicAt("en7", "172.20.10.2", 19))
	sl := s.slots[0]
	s.SetState(sl, Fam4, true)
	busy := s.Acquire(nil) // a flow keeps the slot while the tether is unplugged
	if busy != sl {
		t.Fatal("the only link must take the flow")
	}

	// Unplugged: the re-scan no longer finds it, and the last probes failed.
	*clock = clock.Add(time.Second)
	s.Update(nil)
	s.SetState(sl, Fam4, false) // a probe in flight while it went away; a gone link shows no change
	s.Fail(sl, Fam4, time.Hour)
	if s.Acquire(nil) != nil {
		t.Fatal("a gone link must get no new flows")
	}
	if snap := s.Snapshot(); len(snap) != 1 || snap[0].Present {
		t.Fatalf("a busy gone link stays listed as not present: %+v", snap)
	}

	// Plugged in again: the OS gave it a new interface index.
	*clock = clock.Add(time.Second)
	sl.linkPrimed = true
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 23)})
	if sl.Index() != 23 {
		t.Fatalf("index = %d, want the new one", sl.Index())
	}
	if sl.state[Fam4] != stateUnknown || !sl.lastProbe[Fam4].IsZero() || !sl.downUntil[Fam4].IsZero() || sl.linkPrimed {
		t.Fatalf("a returned link must start over: state %v, last probe %v, cooldown %v, primed %t",
			sl.state[Fam4], sl.lastProbe[Fam4], sl.downUntil[Fam4], sl.linkPrimed)
	}
	if due := s.probeDue(); len(due) != 1 || due[0].sl != sl || due[0].f != Fam4 {
		t.Fatalf("a returned link must be probed at the next tick, got %+v", due)
	}
	sl.probing[Fam4].Store(false)
	// Unknown beats nothing: it takes flows again before its first probe lands, never an outage.
	if got := s.Acquire(nil); got != sl {
		t.Fatal("a returned link must take new flows")
	}
	if snap := s.Snapshot(); !snap[0].Present || snap[0].Index != 23 || snap[0].State != "checking" {
		t.Fatalf("snapshot = %+v", snap[0])
	}
	assertEvents(t, s,
		ev{"en7", StateGone, "checking", EventFound},
		ev{"en7", "checking", "up", EventProbeOK},
		ev{"en7", "up", StateGone, EventLost},
		ev{"en7", StateGone, "checking", EventReturned},
	)
}

func TestAnIdleLinkThatComesBackIsReturnedNotNew(t *testing.T) {
	s, _ := clocked(nicAt("en0", "192.168.1.23", 11), nicAt("en7", "172.20.10.2", 19))
	en0 := s.slots[0]
	s.SetState(en0, Fam4, true)
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 19)}) // en0 asleep or unplugged, and idle: dropped
	if len(s.Snapshot()) != 1 {
		t.Fatalf("an idle gone link is dropped: %+v", s.Snapshot())
	}
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 19), nicAt("en0", "192.168.1.23", 11)})
	snap := s.Snapshot()
	if len(snap) != 2 || snap[1].Name != "en0" || snap[1].State != "checking" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if due := s.probeDue(); len(due) != 2 {
		t.Fatalf("both unprobed links are due, got %d", len(due))
	}
	assertEvents(t, s,
		ev{"en0", StateGone, "checking", EventFound},
		ev{"en7", StateGone, "checking", EventFound},
		ev{"en0", "checking", "up", EventProbeOK},
		ev{"en0", "up", StateGone, EventLost},
		ev{"en0", StateGone, "checking", EventReturned},
	)
}

// Faster than a re-scan: the adapter went and came back between two scans, with a new index.
func TestANewIndexBetweenScansIsAReturn(t *testing.T) {
	s, _ := clocked(nicAt("en7", "172.20.10.2", 19))
	sl := s.slots[0]
	s.SetState(sl, Fam4, true)
	sl.peak[Fam4] = 1e6
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 21)})
	if sl.Index() != 21 || sl.state[Fam4] != stateUnknown || sl.peak[Fam4] != 1e6 {
		t.Fatalf("index %d, state %v, peak %v; want the new index, re-checked, the same address's estimate kept",
			sl.Index(), sl.state[Fam4], sl.peak[Fam4])
	}
	// Same index and address again: nothing changes.
	s.SetState(sl, Fam4, true)
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 21)})
	if sl.state[Fam4] != stateUp {
		t.Fatal("an unchanged link must keep its probe result")
	}
	assertEvents(t, s,
		ev{"en7", StateGone, "checking", EventFound},
		ev{"en7", "checking", "up", EventProbeOK},
		ev{"en7", "up", "checking", EventReturned},
		ev{"en7", "checking", "up", EventProbeOK},
	)
}

func TestANewAddressIsRecordedAsAnAddressChange(t *testing.T) {
	s, _ := clocked(nicAt("en0", "192.168.1.23", 11))
	s.SetState(s.slots[0], Fam4, true)
	s.Update([]nics.Nic{nicAt("en0", "10.0.0.7", 11)}) // joined another Wi-Fi
	if got := s.slots[0].ip(Fam4).String(); got != "10.0.0.7" {
		t.Fatalf("address = %s", got)
	}
	assertEvents(t, s,
		ev{"en0", StateGone, "checking", EventFound},
		ev{"en0", "checking", "up", EventProbeOK},
		ev{"en0", "up", "checking", EventAddress},
	)
}

func TestAProbeFromBeforeTheReturnIsIgnored(t *testing.T) {
	s, _ := clocked(nicAt("en7", "172.20.10.2", 19))
	sl := s.slots[0]
	stale := s.probeDue() // probing starts, then the link vanishes and comes back meanwhile
	if len(stale) != 1 {
		t.Fatalf("due = %+v", stale)
	}
	s.Update([]nics.Nic{nicAt("en7", "172.20.10.2", 22)})
	s.probeDone(stale[0], false) // it failed against the old index
	if sl.state[Fam4] != stateUnknown {
		t.Fatalf("a stale probe result was kept: %v", sl.state[Fam4])
	}
	sl.probing[Fam4].Store(false)
	fresh := s.probeDue()
	if len(fresh) != 1 {
		t.Fatalf("the returned link must be probed again, due = %+v", fresh)
	}
	s.probeDone(fresh[0], true)
	if sl.state[Fam4] != stateUp {
		t.Fatalf("the fresh probe result was dropped: %v", sl.state[Fam4])
	}
}

func TestEventsFollowTheStateLinksShows(t *testing.T) {
	dual := nicAt("en0", "192.168.1.23", 11)
	dual.IP6 = net.ParseIP("2001:db8::23")
	v6only := nics.Nic{Name: "en5", Index: 17, IP6: net.ParseIP("2001:db8::5"), Weight: 1}
	s, _ := clocked(dual, v6only)
	en0, en5 := s.slots[0], s.slots[1]
	s.SetState(en0, Fam6, false) // en0 shows its IPv4 state: no event
	s.SetState(en5, Fam6, true)  // en5 has only IPv6: its IPv6 state shows
	s.SetState(en0, Fam4, false)
	s.SetState(en0, Fam4, false) // no change, no event
	assertEvents(t, s,
		ev{"en0", StateGone, "checking", EventFound},
		ev{"en5", StateGone, "checking", EventFound},
		ev{"en5", "checking", "up", EventProbeOK},
		ev{"en0", "checking", "no internet", EventProbeFailed},
	)
}

func TestEventsKeepTheLastFifty(t *testing.T) {
	s, clock := clocked(nicAt("en0", "192.168.1.23", 11))
	sl := s.slots[0]
	for i := range MaxLinkEvents + 10 {
		*clock = clock.Add(time.Second)
		s.SetState(sl, Fam4, i%2 == 0)
	}
	got := s.Events()
	if len(got) != MaxLinkEvents {
		t.Fatalf("%d events kept, want %d", len(got), MaxLinkEvents)
	}
	for i := 1; i < len(got); i++ {
		if !got[i].At.After(got[i-1].At) {
			t.Fatalf("events are not oldest first at %d: %v then %v", i, got[i-1].At, got[i].At)
		}
	}
	// The newest is the last state set: i = MaxLinkEvents+9 is odd, so down.
	if last := got[len(got)-1]; last.To != "no internet" || last.Reason != EventProbeFailed {
		t.Fatalf("newest event = %+v", last)
	}
	// Events hands out a copy.
	got[0].Link = "changed"
	if s.Events()[0].Link != "en0" {
		t.Fatal("Events returned the scheduler's own slice")
	}
}

func TestRunProbesRecordsResults(t *testing.T) {
	ln := acceptingListener(t)
	old := currentProbeTargets(Fam4)
	defer SetProbeTargets(Fam4, old)
	SetProbeTargets(Fam4, []string{ln.Addr().String()})
	s := NewScheduler([]nics.Nic{loopbackNic(t)})
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { s.RunProbes(stop); close(done) }()
	deadline := time.Now().Add(10 * time.Second)
	for s.Snapshot()[0].State != "up" {
		if time.Now().After(deadline) {
			close(stop)
			t.Fatalf("the probe never passed: %+v", s.Snapshot())
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunProbes kept running after stop")
	}
	if evs := s.Events(); len(evs) != 2 || evs[1].Reason != EventProbeOK {
		t.Fatalf("events = %+v", evs)
	}
}

// Every pinned dial reads the slot's current index, so flows follow an adapter that came back with
// a new one. Loopback only: lo0 at 127.0.0.1 needs no alias and no root.
func TestPinnedDialsUseTheCurrentIndex(t *testing.T) {
	lo := loopbackNic(t)
	ln := acceptingListener(t)
	port := ln.Addr().(*net.TCPAddr).Port
	s := NewScheduler([]nics.Nic{lo})
	b := NewBalancer(s)
	b.ConnectTimeout = 2 * time.Second
	ctx := t.Context()

	c, err := b.DialPinned(ctx, "127.0.0.1", port)
	if err != nil {
		t.Fatalf("pinned dial over lo0 = %v", err)
	}
	c.Close()
	pc, err := b.ListenUDP(ctx, Fam4)
	if err != nil {
		t.Fatalf("pinned UDP over lo0 = %v", err)
	}
	pc.Close()

	// The adapter "comes back" under an index no interface has: binding to it must fail, which shows
	// the dial used the new index rather than a copy taken earlier.
	gone := lo
	gone.Index = 1 << 20
	s.Update([]nics.Nic{gone})
	if c, err := b.DialPinned(ctx, "127.0.0.1", port); err == nil {
		c.Close()
		t.Fatal("a dial pinned to a missing interface index succeeded")
	}
	if pc, err := b.ListenUDP(ctx, Fam4); err == nil {
		pc.Close()
		t.Fatal("a UDP socket pinned to a missing interface index succeeded")
	}

	s.Update([]nics.Nic{lo})
	s.Fail(s.slots[0], Fam4, 0) // the failed dials sidelined it; a probe would clear that
	if c, err := b.DialPinned(ctx, "127.0.0.1", port); err != nil {
		t.Fatalf("after the index came back: %v", err)
	} else {
		c.Close()
	}
}
