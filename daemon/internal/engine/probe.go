package engine

import (
	"net"
	"sync"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// Internet reachability probes: a TCP connect (no data sent) to a well-known anycast IP, bound to
// the NIC. SetProbeTargets replaces them, e.g. with the simulated network's server in tests.
var (
	probeTargetsMu sync.RWMutex
	probeTargets   = [2][]string{
		Fam4: {"1.1.1.1:443", "8.8.8.8:443"},
		Fam6: {"[2606:4700:4700::1111]:443", "[2001:4860:4860::8888]:443"},
	}
)

// Timing (docs/DECISIONS.md ADR-0008): new flows must avoid a link that went silent within 5 s.
// A healthy link is probed every 2 s; a probe dials every target at once and fails after 1.5 s; one
// failed probe moves the link to the "down" tier, so detection takes at most about 3.5 s. A down
// link is probed every second and rejoins on its first success. upstream: 15 s / 4 s / 2 s each.
const (
	probeTimeout   = 1500 * time.Millisecond
	probeEveryUp   = 2 * time.Second
	probeEveryDown = 1 * time.Second
)

// SetProbeTargets replaces the reachability probe targets ("host:port") for one address family.
// An empty list keeps the current targets.
func SetProbeTargets(f Family, targets []string) {
	if len(targets) == 0 {
		return
	}
	probeTargetsMu.Lock()
	defer probeTargetsMu.Unlock()
	probeTargets[f] = append([]string(nil), targets...)
}

func currentProbeTargets(f Family) []string {
	probeTargetsMu.RLock()
	defer probeTargetsMu.RUnlock()
	return probeTargets[f]
}

// probe reports whether any target answers through this NIC. The targets are dialled in parallel,
// so a dead link costs one probeTimeout, not one per target.
func probe(sl *Slot, f Family) bool {
	ip := sl.ip(f)
	if ip == nil {
		return false
	}
	network := "tcp4"
	if f == Fam6 {
		network = "tcp6"
	}
	targets := currentProbeTargets(f)
	results := make(chan bool, len(targets))
	for _, t := range targets {
		go func() {
			d := net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}, Control: nics.ForceEgress(sl.Index, f == Fam6), Timeout: probeTimeout}
			c, err := d.Dial(network, t)
			if err == nil {
				c.Close()
			}
			results <- err == nil
		}()
	}
	for range targets {
		if <-results {
			return true
		}
	}
	return false
}

// Suspect asks for an immediate probe of a NIC, e.g. after a connect through it timed out, so a
// link that went silent is noticed at the next probe tick rather than at its next scheduled one.
func (s *Scheduler) Suspect(sl *Slot, f Family) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sl.lastProbe[f] = time.Time{}
}

type probeJob struct {
	sl *Slot
	f  Family
}

// RunProbes checks every adapter's internet access per address family: new ones immediately,
// healthy ones occasionally, dead ones more often so they rejoin quickly. A tether with no data
// or a captive-portal Wi-Fi therefore never receives flows, and a recovered link is used again
// within seconds. Runs until stop is closed (nil = forever).
func (s *Scheduler) RunProbes(stop <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		for _, j := range s.probeDue() {
			go func() {
				defer j.sl.probing[j.f].Store(false)
				s.SetState(j.sl, j.f, probe(j.sl, j.f))
			}()
		}
	}
}

// probeDue returns the (slot, family) pairs that need a probe now and marks them in flight.
func (s *Scheduler) probeDue() []probeJob {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var due []probeJob
	for _, sl := range s.slots {
		if !sl.present {
			continue
		}
		for _, f := range []Family{Fam4, Fam6} {
			if sl.ip(f) == nil || sl.probing[f].Load() {
				continue
			}
			every := probeEveryUp
			switch sl.state[f] {
			case stateUnknown:
				every = 0
			case stateDown:
				every = probeEveryDown
			}
			if now.Sub(sl.lastProbe[f]) >= every {
				sl.lastProbe[f] = now
				sl.probing[f].Store(true)
				due = append(due, probeJob{sl, f})
			}
		}
	}
	return due
}
