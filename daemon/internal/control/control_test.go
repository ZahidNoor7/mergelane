package control

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
)

type fakeTunnel struct {
	mu       sync.Mutex
	on, offs int
	onErr    error
	name     string
}

func (t *fakeTunnel) On() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.onErr != nil {
		return t.onErr
	}
	t.on++
	return nil
}
func (t *fakeTunnel) Off()         { t.mu.Lock(); t.offs++; t.mu.Unlock() }
func (t *fakeTunnel) Name() string { return t.name }

type fakeEngine struct {
	mu     sync.Mutex // Resume reads the snapshot from its own goroutine
	snap   []engine.SlotStats
	limits map[string]float64
	events []engine.LinkEvent
	reads  int // Snapshot calls
}

func (e *fakeEngine) Snapshot() []engine.SlotStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reads++
	return e.snap
}

func (e *fakeEngine) setSnap(snap []engine.SlotStats) {
	e.mu.Lock()
	e.snap = snap
	e.mu.Unlock()
}

func (e *fakeEngine) Events() []engine.LinkEvent { return e.events }
func (e *fakeEngine) SetLimit(name string, mbps float64) {
	if mbps <= 0 {
		delete(e.limits, name)
		return
	}
	e.limits[name] = mbps
}
func (e *fakeEngine) Limits() map[string]float64 { return e.limits }

type fakeGuard struct {
	mu        sync.Mutex
	conflicts []string
	err       error
	sawOurs   []bool // ours("utun9") on each call
}

func (g *fakeGuard) check(_ context.Context, ours func(string) bool) ([]string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sawOurs = append(g.sawOurs, ours("utun9"))
	return g.conflicts, g.err
}

func (g *fakeGuard) set(conflicts []string, err error) {
	g.mu.Lock()
	g.conflicts, g.err = conflicts, err
	g.mu.Unlock()
}

var upLink = engine.SlotStats{Name: "en0", Index: 4, IP: "192.0.2.2", State: "up", State6: "-", Present: true}

func newController(t *testing.T) (*Controller, *fakeTunnel, *fakeEngine, *fakeGuard, *time.Time) {
	t.Helper()
	clock := time.Unix(1000, 0).UTC()
	tun := &fakeTunnel{name: "utun9"}
	eng := &fakeEngine{snap: []engine.SlotStats{upLink}, limits: map[string]float64{}}
	g := &fakeGuard{}
	c := New(Config{
		Version: "test", Tunnel: tun, Engine: eng, Guard: g.check,
		SaveLimits: func(map[string]float64) error { return nil },
		Now:        func() time.Time { return clock },
	})
	return c, tun, eng, g, &clock
}

func code(t *testing.T, err error) api.Code {
	t.Helper()
	var e *api.Error
	if !errors.As(err, &e) {
		t.Fatalf("want *api.Error, got %v", err)
	}
	return e.Code
}

func TestStartsOffWithTheStartReason(t *testing.T) {
	c := New(Config{Version: "v", Tunnel: &fakeTunnel{}, Engine: &fakeEngine{}, StartReason: ReasonCrash})
	st, _ := c.Status(context.Background())
	if st.State != api.StateOff || st.Reason != ReasonCrash || st.Version != "v" || st.Since.IsZero() {
		t.Fatalf("status = %+v", st)
	}
}

func TestEnableTurnsOnOnceAndClearsTheReason(t *testing.T) {
	c, tun, _, g, clock := newController(t)
	c.reason = ReasonCrash
	*clock = clock.Add(time.Minute)
	st, err := c.Enable(context.Background())
	if err != nil || st.State != api.StateOn || st.Reason != "" || !st.Since.Equal(*clock) {
		t.Fatalf("enable = %+v, %v", st, err)
	}
	if _, err := c.Enable(context.Background()); err != nil || tun.on != 1 {
		t.Fatalf("a second enable must do nothing: on=%d err=%v", tun.on, err)
	}
	if len(g.sawOurs) != 1 || !g.sawOurs[0] {
		t.Fatalf("the guard must be told the daemon's own utun: %v", g.sawOurs)
	}
}

func TestEnableIsRefusedWhileAVPNIsActive(t *testing.T) {
	c, tun, _, g, _ := newController(t)
	g.set([]string{"Another VPN (utun4) is routing all traffic."}, nil)
	st, err := c.Enable(context.Background())
	if code(t, err) != api.CodeVPNActive || st.State != api.StateOff || st.Reason != "Another VPN (utun4) is routing all traffic." {
		t.Fatalf("enable = %+v, %v", st, err)
	}
	if tun.on != 0 {
		t.Fatal("no route may be added while a VPN is active")
	}
}

func TestEnableReportsAGuardFailure(t *testing.T) {
	c, tun, _, g, _ := newController(t)
	g.set(nil, errors.New("rib unreadable"))
	if _, err := c.Enable(context.Background()); code(t, err) != api.CodeInternal || tun.on != 0 {
		t.Fatalf("err = %v, on = %d", err, tun.on)
	}
}

func TestEnableNeedsAUsableLink(t *testing.T) {
	c, tun, eng, _, _ := newController(t)
	eng.snap = []engine.SlotStats{
		{Name: "en0", State: "no internet", State6: "-", Present: true},
		{Name: "en5", State: "up", Present: false},
	}
	st, err := c.Enable(context.Background())
	if code(t, err) != api.CodeNoUsableLinks || st.Reason != ReasonNoLinks || tun.on != 0 {
		t.Fatalf("enable = %+v, %v", st, err)
	}
	eng.snap = []engine.SlotStats{{Name: "en0", State: "-", State6: "up", Present: true}}
	if _, err := c.Enable(context.Background()); err != nil {
		t.Fatalf("an IPv6-only link is usable: %v", err)
	}
}

func TestEnableReportsATunnelFailure(t *testing.T) {
	c, tun, _, _, _ := newController(t)
	tun.onErr = errors.New("route add failed")
	st, err := c.Enable(context.Background())
	if code(t, err) != api.CodeInternal || st.State != api.StateOff {
		t.Fatalf("enable = %+v, %v", st, err)
	}
}

func TestDisable(t *testing.T) {
	c, tun, _, _, _ := newController(t)
	if st, _ := c.Disable(context.Background(), api.DisableParams{}); st.State != api.StateOff || tun.offs != 0 {
		t.Fatalf("disabling while off must not touch routes: %+v offs=%d", st, tun.offs)
	}
	c.Enable(context.Background())
	st, err := c.Disable(context.Background(), api.DisableParams{Reason: "user"})
	if err != nil || st.State != api.StateOff || st.Reason != "user" || tun.offs != 1 {
		t.Fatalf("disable = %+v, %v, offs=%d", st, err, tun.offs)
	}
}

func TestCheckGuardTurnsMergingOffWhenAVPNAppears(t *testing.T) {
	c, tun, _, g, _ := newController(t)
	if c.CheckGuard(context.Background()) {
		t.Fatal("nothing to do while off")
	}
	c.Enable(context.Background())
	if c.CheckGuard(context.Background()) {
		t.Fatal("no conflict, no change")
	}
	g.set(nil, errors.New("transient"))
	if c.CheckGuard(context.Background()) {
		t.Fatal("a failed check must not turn merging off")
	}
	g.set([]string{"VPN \"Work\" is connected."}, nil)
	if !c.CheckGuard(context.Background()) {
		t.Fatal("a VPN appearing must turn merging off")
	}
	st, _ := c.Status(context.Background())
	if st.State != api.StateOff || st.Reason != "VPN \"Work\" is connected." || tun.offs != 1 {
		t.Fatalf("status = %+v offs=%d", st, tun.offs)
	}
}

func TestWatchChecksUntilCancelled(t *testing.T) {
	c, tun, _, g, _ := newController(t)
	c.Enable(context.Background())
	g.set([]string{"conflict"}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Watch(ctx, time.Millisecond); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		tun.mu.Lock()
		offs := tun.offs
		tun.mu.Unlock()
		if offs == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Watch never turned merging off")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
}

func TestLinksAndStatsMapTheScheduler(t *testing.T) {
	c, _, eng, _, clock := newController(t)
	eng.snap = []engine.SlotStats{
		{Name: "en0", Index: 4, IP: "192.0.2.2", State: "up", State6: "-", Present: true, LimitMbps: 20,
			RateIn: 100, RateOut: 10, LinkIn: 200, LinkOut: 20, Active: 2, Total: 9, Weight: 0.5, Weight6: 0.8, Failed: 1},
		{Name: "en5", Index: 9, IP6: "2001:db8::2", State: "-", State6: "no internet", Present: true},
		{Name: "en7", Index: 11, IP: "198.51.100.2", State: "checking", State6: "-", Present: false},
	}
	links, _ := c.Links(context.Background())
	want := []api.Link{
		{Name: "en0", Index: 4, IPv4: "192.0.2.2", Up: true, State: api.LinkUp, LimitMbps: 20},
		{Name: "en5", Index: 9, IPv6: "2001:db8::2", Up: true, State: api.LinkDown},
		{Name: "en7", Index: 11, IPv4: "198.51.100.2", Up: false, State: api.LinkUnknown},
	}
	if len(links.Links) != len(want) {
		t.Fatalf("links = %+v", links)
	}
	for i := range want {
		if links.Links[i] != want[i] {
			t.Errorf("link %d = %+v, want %+v", i, links.Links[i], want[i])
		}
	}
	stats, _ := c.Stats(context.Background())
	s := stats.Links[0]
	if !stats.At.Equal(*clock) || s.RxBps != 100 || s.TxBps != 10 || s.LinkRxBps != 200 || s.LinkTxBps != 20 ||
		s.ActiveFlows != 2 || s.TotalFlows != 9 || s.Weight != 0.8 || s.Failed != 1 || len(stats.Links) != 3 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestSetLimit(t *testing.T) {
	c, _, eng, _, _ := newController(t)
	var saved map[string]float64
	c.cfg.SaveLimits = func(m map[string]float64) error { saved = m; return nil }
	res, err := c.SetLimit(context.Background(), api.SetLimitParams{Link: "en0", Mbps: 20})
	if err != nil || res != (api.SetLimitResult{Link: "en0", Mbps: 20}) || eng.limits["en0"] != 20 || saved["en0"] != 20 {
		t.Fatalf("setLimit = %+v, %v, limits %v saved %v", res, err, eng.limits, saved)
	}
	if _, err := c.SetLimit(context.Background(), api.SetLimitParams{Link: "en0", Mbps: -1}); code(t, err) != api.CodeBadRequest {
		t.Fatalf("a negative cap must be refused: %v", err)
	}
	c.cfg.SaveLimits = func(map[string]float64) error { return errors.New("disk full") }
	if _, err := c.SetLimit(context.Background(), api.SetLimitParams{Link: "en0", Mbps: 0}); code(t, err) != api.CodeInternal {
		t.Fatalf("a save failure must be reported: %v", err)
	}
	c.cfg.SaveLimits = nil
	if _, err := c.SetLimit(context.Background(), api.SetLimitParams{Link: "en1", Mbps: 5}); err != nil {
		t.Fatalf("no saver configured: %v", err)
	}
}

func TestShutdownTurnsMergingOff(t *testing.T) {
	c, tun, _, _, _ := newController(t)
	c.Enable(context.Background())
	c.Shutdown()
	if st, _ := c.Status(context.Background()); st.State != api.StateOff || tun.offs != 1 {
		t.Fatalf("status = %+v offs=%d", st, tun.offs)
	}
}

func TestOursIsFalseBeforeTheUtunExists(t *testing.T) {
	c, tun, _, _, _ := newController(t)
	tun.name = ""
	if c.ours("") || c.ours("utun9") {
		t.Fatal("no interface is ours before the utun exists")
	}
}
