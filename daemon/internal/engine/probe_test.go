package engine

import (
	"net"
	"slices"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// loopbackNic is a NIC bound to lo0 at 127.0.0.1, which needs no alias and no root.
func loopbackNic(t *testing.T) nics.Nic {
	t.Helper()
	lo, err := net.InterfaceByName("lo0")
	if err != nil {
		t.Skipf("no lo0: %v", err)
	}
	return nics.Nic{Name: "lo0", IP: net.ParseIP("127.0.0.1"), Index: lo.Index, Weight: 1}
}

// acceptingListener returns a TCP listener on 127.0.0.1 that accepts and closes connections.
func acceptingListener(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	return ln
}

// closedAddr returns a 127.0.0.1 address nothing listens on.
func closedAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func TestSetProbeTargetsKeepsCurrentOnEmpty(t *testing.T) {
	old := currentProbeTargets(Fam4)
	defer SetProbeTargets(Fam4, old)
	SetProbeTargets(Fam4, nil)
	if !slices.Equal(currentProbeTargets(Fam4), old) {
		t.Fatal("an empty list must keep the current targets")
	}
	SetProbeTargets(Fam4, []string{"127.0.0.1:1"})
	if got := currentProbeTargets(Fam4); !slices.Equal(got, []string{"127.0.0.1:1"}) {
		t.Fatalf("targets = %v", got)
	}
}

func TestProbeSucceedsIfAnyTargetAnswers(t *testing.T) {
	ln := acceptingListener(t)
	old := currentProbeTargets(Fam4)
	defer SetProbeTargets(Fam4, old)
	SetProbeTargets(Fam4, []string{closedAddr(t), ln.Addr().String()})
	s := NewScheduler([]nics.Nic{loopbackNic(t)})
	if !probe(s.slots[0], Fam4) {
		t.Fatal("one answering target must make the probe pass")
	}
}

func TestProbeFailsWithinOneTimeoutWhenNoTargetAnswers(t *testing.T) {
	old := currentProbeTargets(Fam4)
	defer SetProbeTargets(Fam4, old)
	SetProbeTargets(Fam4, []string{closedAddr(t), closedAddr(t)})
	s := NewScheduler([]nics.Nic{loopbackNic(t)})
	start := time.Now()
	if probe(s.slots[0], Fam4) {
		t.Fatal("no answering target must fail the probe")
	}
	if took := time.Since(start); took > probeTimeout+500*time.Millisecond {
		t.Fatalf("probe took %v; targets must be dialled in parallel", took)
	}
}

func TestProbeWithoutAnAddressFails(t *testing.T) {
	s := NewScheduler([]nics.Nic{loopbackNic(t)})
	if probe(s.slots[0], Fam6) {
		t.Fatal("a NIC without an IPv6 address cannot pass an IPv6 probe")
	}
}

func TestSuspectForcesAnImmediateProbe(t *testing.T) {
	clock := time.Unix(1000, 0)
	s := NewScheduler([]nics.Nic{nic("A", "10.0.0.1", 1)})
	s.now = func() time.Time { return clock }
	sl := s.slots[0]
	s.SetState(sl, Fam4, true)
	sl.lastProbe[Fam4] = clock
	if due := s.probeDue(); len(due) != 0 {
		t.Fatalf("a just-probed healthy link is not due, got %d jobs", len(due))
	}
	s.Suspect(sl, Fam4)
	due := s.probeDue()
	if len(due) != 1 || due[0].sl != sl || due[0].f != Fam4 {
		t.Fatalf("a suspected link must be probed at once, got %+v", due)
	}
	sl.probing[Fam4].Store(false)
}

func TestHealthyAndDownLinksAreProbedOnSchedule(t *testing.T) {
	clock := time.Unix(1000, 0)
	s := NewScheduler([]nics.Nic{nic("A", "10.0.0.1", 1), nic("B", "10.0.0.2", 1)})
	s.now = func() time.Time { return clock }
	up, down := s.slots[0], s.slots[1]
	s.SetState(up, Fam4, true)
	s.SetState(down, Fam4, false)
	up.lastProbe[Fam4], down.lastProbe[Fam4] = clock, clock

	clock = clock.Add(probeEveryDown)
	if due := s.probeDue(); len(due) != 1 || due[0].sl != down {
		t.Fatalf("after %v only the down link is due, got %+v", probeEveryDown, due)
	}
	down.probing[Fam4].Store(false)
	clock = clock.Add(probeEveryUp - probeEveryDown)
	if due := s.probeDue(); len(due) != 2 {
		t.Fatalf("after %v both links are due, got %d", probeEveryUp, len(due))
	}
}

// ADR-0008: a link that goes silent right after a probe started is noticed by the next one.
func TestProbeTimingMeetsTheFiveSecondTarget(t *testing.T) {
	if worst := probeEveryUp + probeTimeout + time.Second; worst > 5*time.Second {
		t.Fatalf("worst-case detection %v (interval + timeout + 1 s tick) exceeds 5 s", worst)
	}
}
