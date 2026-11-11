package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/control"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/routemark"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
)

func TestParseRunFlagsDefaults(t *testing.T) {
	c, err := parseRunFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := runConfig{
		weights: map[string]float64{}, rescan: 3 * time.Second, auto: true, v6: engine.V6Auto,
		mtu: tun.DefaultMTU, stateDir: state.DefaultDir(), socketPath: api.SocketPath,
	}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("defaults = %+v, want %+v", c, want)
	}
}

func TestParseRunFlagsReadsEveryFlag(t *testing.T) {
	c, err := parseRunFlags([]string{
		"-include", " en0, ,en5", "-weight", "en0=3", "-rescan", "5s", "-ipv6", "off", "-mtu", "1280",
		"-probe-targets", "127.0.0.1:1, 127.0.0.1:2", "-log", "/x/d.log", "-state-dir", "/x/state",
		"-pprof", "127.0.0.1:6060", "-allowed-uid", "501", "-socket", "/x/d.sock",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := runConfig{
		include: []string{"en0", "en5"}, weights: map[string]float64{"en0": 3}, rescan: 5 * time.Second,
		auto: false, // a fixed weight turns measured weights off
		v6:   engine.V6Off, mtu: 1280, probes: []string{"127.0.0.1:1", "127.0.0.1:2"},
		logFile: "/x/d.log", stateDir: "/x/state", pprof: "127.0.0.1:6060", allowedUID: 501, socketPath: "/x/d.sock",
	}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("config = %+v, want %+v", c, want)
	}
}

func TestParseRunFlagsAcceptsTheLimits(t *testing.T) {
	cases := []struct {
		args []string
		mtu  int
		v6   engine.V6Mode
		auto bool
	}{
		{[]string{"-mtu", "1280"}, 1280, engine.V6Auto, true},
		{[]string{"-mtu", "65535", "-ipv6", "on"}, 65535, engine.V6On, true},
		{[]string{"-ipv6", "auto", "-auto-weight=false"}, tun.DefaultMTU, engine.V6Auto, false},
	}
	for _, tc := range cases {
		c, err := parseRunFlags(tc.args)
		if err != nil || c.mtu != tc.mtu || c.v6 != tc.v6 || c.auto != tc.auto {
			t.Errorf("parseRunFlags(%v) = mtu %d v6 %d auto %t, %v", tc.args, c.mtu, c.v6, c.auto, err)
		}
	}
}

func TestParseRunFlagsRejectsBadValues(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"-nope"}, "not defined: -nope"},
		{[]string{"-mtu", "1279"}, "-mtu must be between 1280 and 65535, got 1279"},
		{[]string{"-mtu", "65536"}, "-mtu must be between 1280 and 65535, got 65536"},
		{[]string{"-rescan", "0"}, "-rescan must be positive, got 0s"},
		{[]string{"-rescan", "-1s"}, "-rescan must be positive, got -1s"},
		{[]string{"-mtu", "big"}, "invalid value"},
		{[]string{"-ipv6", "maybe"}, `-ipv6 must be auto, on or off, got "maybe"`},
		{[]string{"-weight", "en0"}, `want "Name=3"`},
		{[]string{"-rescan", "soon"}, "invalid value"},
		{[]string{"-allowed-uid", "me"}, "invalid value"},
	}
	for _, tc := range cases {
		if _, err := parseRunFlags(tc.args); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("parseRunFlags(%v) = %v, want an error containing %q", tc.args, err, tc.want)
		}
	}
}

// events records, in order, what the fakes were asked to do.
type events struct {
	mu   sync.Mutex
	list []string
}

func (e *events) add(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, s)
}

func (e *events) get() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.list)
}

// fakeEngine stands in for engine.Scheduler: every link it was built with is present, and up
// unless linkState says otherwise.
type fakeEngine struct {
	found      []nics.Nic
	probesDone chan struct{} // closed when RunProbes returns
	linkState  string        // SlotStats.State of every link; "" means "up"

	mu      sync.Mutex
	auto    bool
	setLims map[string]float64 // what SetLimits was given
	limits  map[string]float64
	updates [][]nics.Nic
	ticks   []time.Duration
}

func newFakeEngine(found []nics.Nic) *fakeEngine {
	return &fakeEngine{found: found, probesDone: make(chan struct{}), limits: map[string]float64{}}
}

func (e *fakeEngine) Snapshot() []engine.SlotStats {
	state := e.linkState
	if state == "" {
		state = "up"
	}
	var out []engine.SlotStats
	for _, n := range e.found {
		out = append(out, engine.SlotStats{Name: n.Name, Index: n.Index, Present: true, State: state, State6: "-"})
	}
	return out
}

// fakeEventAt is when fakeEngine's one link event happened.
var fakeEventAt = time.Date(2026, 11, 10, 9, 30, 0, 0, time.UTC)

func (e *fakeEngine) Events() []engine.LinkEvent {
	var out []engine.LinkEvent
	for _, n := range e.found {
		out = append(out, engine.LinkEvent{At: fakeEventAt, Link: n.Name, From: engine.StateGone, To: "checking", Reason: engine.EventFound})
	}
	return out
}

func (e *fakeEngine) SetLimit(name string, mbitPerSec float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if mbitPerSec <= 0 {
		delete(e.limits, name)
		return
	}
	e.limits[name] = mbitPerSec
}

func (e *fakeEngine) Limits() map[string]float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]float64, len(e.limits))
	for k, v := range e.limits {
		out[k] = v
	}
	return out
}

func (e *fakeEngine) SetAuto(on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.auto = on
}

func (e *fakeEngine) SetLimits(limits map[string]float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.setLims = limits
}

func (e *fakeEngine) RunProbes(stop <-chan struct{}) {
	<-stop
	close(e.probesDone)
}

func (e *fakeEngine) Update(found []nics.Nic) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.updates = append(e.updates, found)
}

func (e *fakeEngine) Tick(dt time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ticks = append(e.ticks, dt)
}

func (e *fakeEngine) counts() (updates, ticks int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.updates), len(e.ticks)
}

// fakeTunnel stands in for tun.Tun: no utun, no routes.
type fakeTunnel struct {
	ev      *events
	warmErr error
}

func (f *fakeTunnel) Warm() error  { f.ev.add("warm"); return f.warmErr }
func (f *fakeTunnel) On() error    { f.ev.add("on"); return nil }
func (f *fakeTunnel) Off()         { f.ev.add("off") }
func (f *fakeTunnel) Close()       { f.ev.add("close") }
func (f *fakeTunnel) Name() string { return "utun9" }

// recServer records when the real control socket is closed.
type recServer struct {
	runServer
	ev *events
}

func (s recServer) Close() error {
	s.ev.add("server close")
	return s.runServer.Close()
}

// syncBuffer collects logx output.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// harness runs runDaemon with fakes for every privileged step and the real control API on a
// temporary socket. Tests change its fields before calling runDaemon.
type harness struct {
	cfg  runConfig
	deps runDeps
	ev   *events
	eng  *fakeEngine
	tun  *fakeTunnel
	logs *syncBuffer

	root, locked bool
	routes       []rib.Route
	routesErr    error
	links        []nics.Nic
	linkState    string // what the fake scheduler reports for every link; "" means "up"
	discoverErr  error
	conflicts    []string

	redirected []string // the -log files the logs were sent to
	pprofAddr  string
	mergerArgs []any

	discoverMu   sync.Mutex // rescans call discover from another goroutine
	discoverArgs [][]string

	ready chan struct{}      // closed once the control socket is listening
	stop  context.CancelFunc // stands in for SIGTERM
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	sockDir, err := os.MkdirTemp("/tmp", "mld") // sun_path is 104 bytes on macOS
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })

	logs := &syncBuffer{}
	logx.SetOutput(logs)
	t.Cleanup(func() { logx.SetOutput(os.Stdout) })

	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)

	h := &harness{
		cfg: runConfig{
			include: []string{"en0"}, weights: map[string]float64{}, rescan: time.Hour, auto: true,
			v6: engine.V6Off, mtu: 1500, stateDir: filepath.Join(t.TempDir(), "state"),
			allowedUID: os.Getuid(), socketPath: filepath.Join(sockDir, "s"),
		},
		ev: &events{}, logs: logs, root: true, locked: true,
		links: []nics.Nic{{Name: "en0", Index: 4, IP: net.ParseIP("192.0.2.2"), Weight: 1}},
		ready: make(chan struct{}), stop: stop,
	}
	h.tun = &fakeTunnel{ev: h.ev}
	h.deps = runDeps{
		isRoot: func() bool { return h.root },
		lock:   func() bool { return h.locked },
		redirectLogs: func(f *os.File) {
			h.redirected = append(h.redirected, f.Name())
			f.Close()
		},
		startPprof: func(addr string) error { h.pprofAddr = addr; return nil },
		readRoutes: func() ([]rib.Route, error) { h.ev.add("read routes"); return h.routes, h.routesErr },
		cleanup:    func() { h.ev.add("cleanup") },
		discover: func(include []string, weights map[string]float64) ([]nics.Nic, error) {
			h.discoverMu.Lock()
			defer h.discoverMu.Unlock()
			h.discoverArgs = append(h.discoverArgs, include)
			if !reflect.DeepEqual(weights, h.cfg.weights) {
				return nil, errors.New("discover got the wrong weights")
			}
			return h.links, h.discoverErr
		},
		newMerger: func(found []nics.Nic, v6 engine.V6Mode, mtu int) (runEngine, runTunnel) {
			h.mergerArgs = []any{found, v6, mtu}
			h.eng = newFakeEngine(found)
			h.eng.linkState = h.linkState
			return h.eng, h.tun
		},
		guard: func(context.Context, func(string) bool) ([]string, error) { return h.conflicts, nil },
		listen: func(path string, mode os.FileMode, authorize func(uint32) bool, hd api.Handler) (runServer, error) {
			srv, err := listenAPI(path, mode, authorize, hd)
			if err != nil {
				return nil, err
			}
			h.ev.add("listen")
			close(h.ready)
			return recServer{srv, h.ev}, nil
		},
		signalContext: func() (context.Context, context.CancelFunc) { return context.WithCancel(ctx) },
	}
	return h
}

// start runs the daemon until the control socket is up and returns where runDaemon's result goes.
func (h *harness) start(t *testing.T) <-chan error {
	t.Helper()
	errc, done := make(chan error, 1), make(chan struct{})
	go func() { errc <- runDaemon(h.cfg, h.deps); close(done) }()
	t.Cleanup(func() { // if the test stopped early, don't let the daemon outlive it
		h.stop()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
		}
	})
	select {
	case <-h.ready:
	case err := <-errc:
		t.Fatalf("runDaemon returned before listening: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the control socket never came up")
	}
	return errc
}

// shutdown sends the stand-in SIGTERM and waits for runDaemon to return cleanly.
func (h *harness) shutdown(t *testing.T, errc <-chan error) {
	t.Helper()
	h.stop()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("runDaemon = %v after shutdown", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runDaemon didn't return after the shutdown signal")
	}
	select {
	case <-h.eng.probesDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the probes kept running after shutdown")
	}
}

func (h *harness) dial(t *testing.T) *api.Client {
	t.Helper()
	cl, err := api.Dial(h.cfg.socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cl.Close() })
	return cl
}

func ctxT(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func assertEvents(t *testing.T, h *harness, want ...string) {
	t.Helper()
	if got := h.ev.get(); !slices.Equal(got, want) {
		t.Fatalf("events = %q, want %q", got, want)
	}
}

func TestRunDaemonServesUntilStopped(t *testing.T) {
	h := newHarness(t)
	h.cfg.rescan = 5 * time.Millisecond
	if err := state.SaveLimits(h.cfg.stateDir, map[string]float64{"en0": 20}); err != nil {
		t.Fatal(err)
	}
	errc := h.start(t)

	// The wiring: flags reach discovery and the merger, saved caps reach the scheduler.
	if want := []any{h.links, engine.V6Off, 1500}; !reflect.DeepEqual(h.mergerArgs, want) {
		t.Errorf("newMerger(%v), want %v", h.mergerArgs, want)
	}
	h.eng.mu.Lock()
	auto, setLims := h.eng.auto, h.eng.setLims
	h.eng.mu.Unlock()
	if !auto || !reflect.DeepEqual(setLims, map[string]float64{"en0": 20}) {
		t.Errorf("scheduler auto = %t, limits = %v", auto, setLims)
	}
	if fi, err := os.Stat(h.cfg.socketPath); err != nil || fi.Mode().Perm() != 0o666 {
		t.Errorf("socket = %v, %v; want mode 0666 (ADR-0005)", fi, err)
	}
	// Re-scans feed the scheduler the links discovery finds with the same flags.
	deadline := time.Now().Add(5 * time.Second)
	for updates, _ := h.eng.counts(); updates == 0; updates, _ = h.eng.counts() {
		if time.Now().After(deadline) {
			t.Fatal("no re-scan reached the scheduler")
		}
		time.Sleep(2 * time.Millisecond)
	}
	h.eng.mu.Lock()
	update := h.eng.updates[0]
	h.eng.mu.Unlock()
	if !reflect.DeepEqual(update, h.links) {
		t.Errorf("re-scan Update(%v), want %v", update, h.links)
	}
	h.discoverMu.Lock()
	for _, include := range h.discoverArgs {
		if !slices.Equal(include, []string{"en0"}) {
			t.Errorf("discover include = %v, want [en0]", include)
		}
	}
	h.discoverMu.Unlock()

	// The CLI drives the daemon through the real control socket.
	sock := []string{"-socket", h.cfg.socketPath}
	steps := []struct {
		cmd  string
		args []string
		want string
	}{
		{"status", nil, "system merge: off (daemon dev, protocol 1)\n"},
		{"on", nil, "system merge: on (daemon dev, protocol 1)\n"},
		{"status", nil, "system merge: on (daemon dev, protocol 1)\n"},
		{"off", nil, "system merge: off (daemon dev, protocol 1)\n"},
		{"links", nil, "en0      index 4   up       up=true  v4                 v6 \n"},
		{"stats", nil, "en0      merged down     0.0"},
		{"limit", []string{"en0", "5"}, "en0: 5 Mbit/s\n"},
	}
	for _, st := range steps {
		code, out, errOut := run(st.cmd, append(slices.Clone(sock), st.args...)...)
		if code != 0 || !strings.HasPrefix(out, st.want) {
			t.Fatalf("%s %v = %d, out %q, err %q; want %q", st.cmd, st.args, code, out, errOut, st.want)
		}
	}
	if saved, err := state.LoadLimits(h.cfg.stateDir); err != nil || saved["en0"] != 5 {
		t.Fatalf("saved caps = %v, %v; want en0 at 5", saved, err)
	}

	h.shutdown(t, errc)
	// Merging was already off, so shutting down only closes the socket, then the utun.
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "on", "off", "server close", "close")
	if _, err := os.Stat(h.cfg.socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the socket outlived the daemon: %v", err)
	}
	logs := h.logs.String()
	for _, want := range []string{"listening on " + h.cfg.socketPath + " (merging off)", "mergelane-daemon stopped"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs %q lack %q", logs, want)
		}
	}
}

func TestRunDaemonTurnsMergingOffBeforeExiting(t *testing.T) {
	h := newHarness(t)
	errc := h.start(t)
	if st, err := h.dial(t).Enable(ctxT(t)); err != nil || st.State != api.StateOn {
		t.Fatalf("enable = %+v, %v", st, err)
	}
	h.shutdown(t, errc)
	// Shutdown removes the routes first, then the socket goes, then the utun.
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "on", "off", "server close", "close")
}

func TestRunDaemonStartReason(t *testing.T) {
	ours := routemark.Capture(netip.MustParsePrefix("0.0.0.0/1"), "utun7")
	ours.Flags |= rib.FlagProto2 | rib.FlagStatic
	theirs := rib.Route{Dst: netip.MustParsePrefix("128.0.0.0/1"), Iface: "utun4", Flags: rib.FlagStatic}
	cases := []struct {
		name   string
		routes []rib.Route
		err    error
		reason string
	}{
		{"leftover routes mean a crash", []rib.Route{ours, theirs}, nil, control.ReasonCrash},
		{"a clean table is a clean start", []rib.Route{theirs}, nil, ""},
		{"an unreadable table counts as clean", nil, errors.New("no rib"), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.routes, h.routesErr = tc.routes, tc.err
			errc := h.start(t)
			st, err := h.dial(t).Status(ctxT(t))
			if err != nil || st.State != api.StateOff || st.Reason != tc.reason {
				t.Fatalf("status = %+v, %v; want off, reason %q", st, err, tc.reason)
			}
			h.shutdown(t, errc)
			// The routes are counted before cleanup removes them, and cleanup runs every time (ADR-0007).
			assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
			if crashed := strings.Contains(h.logs.String(), "previous run left routes behind"); crashed != (tc.reason != "") {
				t.Errorf("crash logged = %t, logs %q", crashed, h.logs.String())
			}
		})
	}
}

func TestRunDaemonAuthorizesOnlyRootAndTheAllowedUser(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, which is always allowed")
	}
	h := newHarness(t)
	h.cfg.allowedUID = 0 // nobody but root
	errc := h.start(t)
	_, err := h.dial(t).Status(ctxT(t))
	if e := api.AsError(err); e == nil || e.Code != api.CodeNotAuthorized {
		t.Fatalf("status from an unlisted user = %v, want NOT_AUTHORIZED", err)
	}
	// Every CLI command reports the refusal.
	for _, args := range [][]string{{"status"}, {"on"}, {"off"}, {"links"}, {"stats"}, {"limit", "en0", "5"},
		{"events"}, {"auto-resume", "on"}} {
		code, _, errOut := run(args[0], append([]string{"-socket", h.cfg.socketPath}, args[1:]...)...)
		if code != 1 || !strings.Contains(errOut, "NOT_AUTHORIZED") {
			t.Errorf("%v = %d %q, want NOT_AUTHORIZED", args, code, errOut)
		}
	}
	h.shutdown(t, errc)
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
}

func TestCmdRunRefusesWithoutRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: this would start the real daemon")
	}
	code, _, errOut := run("run", "-state-dir", t.TempDir(), "-socket", "/tmp/mergelane-no-such-socket")
	if code != 1 || !strings.Contains(errOut, "run must run as root") {
		t.Fatalf("run as a normal user = %d %q", code, errOut)
	}
	if code, _, errOut := run("run", "-mtu", "1"); code != 1 || !strings.Contains(errOut, "-mtu must be between") {
		t.Fatalf("run -mtu 1 = %d %q", code, errOut)
	}
}

func TestRunDaemonRefusesWhileAnotherVPNIsUp(t *testing.T) {
	h := newHarness(t)
	h.conflicts = []string{"Another VPN (utun4) is routing all IPv4 traffic."}
	errc := h.start(t)
	_, err := h.dial(t).Enable(ctxT(t))
	if e := api.AsError(err); e == nil || e.Code != api.CodeVPNActive {
		t.Fatalf("enable = %v, want VPN_ACTIVE", err)
	}
	h.shutdown(t, errc)
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
}

func TestRunDaemonIgnoresBrokenSavedLimits(t *testing.T) {
	h := newHarness(t)
	if err := state.Prepare(h.cfg.stateDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.LimitsPath(h.cfg.stateDir), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	errc := h.start(t)
	h.shutdown(t, errc)
	if h.eng.setLims != nil {
		t.Errorf("SetLimits(%v) from a broken file", h.eng.setLims)
	}
	if !strings.Contains(h.logs.String(), "warning: ") || !strings.Contains(h.logs.String(), "(ignored)") {
		t.Errorf("logs %q lack the warning", h.logs.String())
	}
}

func TestRunDaemonFailures(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name    string
		setup   func(t *testing.T, h *harness)
		want    string
		events  []string
		started bool // the probes had started, so the failure must stop them
	}{
		{
			name:  "not root",
			setup: func(_ *testing.T, h *harness) { h.root = false },
			want:  "run must run as root",
		},
		{
			name:  "another daemon holds the lock",
			setup: func(_ *testing.T, h *harness) { h.locked = false },
			want:  "mergelane-daemon is already running",
		},
		{
			name: "the log file can't be opened",
			setup: func(t *testing.T, h *harness) {
				h.cfg.logFile = filepath.Join(t.TempDir(), "missing", "d.log")
			},
			want: "no such file or directory",
		},
		{
			name: "pprof refuses the address",
			setup: func(_ *testing.T, h *harness) {
				h.deps.startPprof = startPprof // the real one: it refuses before listening
				h.cfg.pprof = "0.0.0.0:6060"
			},
			want: "-pprof must be a loopback address",
		},
		{
			name: "the state directory can't be made",
			setup: func(t *testing.T, h *harness) {
				file := filepath.Join(t.TempDir(), "file")
				if err := os.WriteFile(file, nil, 0o644); err != nil {
					t.Fatal(err)
				}
				h.cfg.stateDir = filepath.Join(file, "state")
			},
			want: "not a directory",
		},
		{
			name:   "discovery fails",
			setup:  func(_ *testing.T, h *harness) { h.discoverErr = boom },
			want:   "boom",
			events: []string{"read routes", "cleanup"},
		},
		{
			name:   "the utun can't be created",
			setup:  func(_ *testing.T, h *harness) { h.tun.warmErr = errors.New("open TUN: denied") },
			want:   "open TUN: denied",
			events: []string{"read routes", "cleanup", "warm"}, // nothing to close: Warm made nothing
		},
		{
			name: "the control socket can't be created",
			setup: func(_ *testing.T, h *harness) {
				h.cfg.socketPath = "/tmp/" + strings.Repeat("x", 120)
			},
			want:    "longer than",
			events:  []string{"read routes", "cleanup", "warm", "close"},
			started: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.setup(t, h)
			err := runDaemon(h.cfg, h.deps)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("runDaemon = %v, want an error containing %q", err, tc.want)
			}
			assertEvents(t, h, tc.events...)
			if tc.started {
				select {
				case <-h.eng.probesDone:
				case <-time.After(5 * time.Second):
					t.Fatal("the probes kept running after a failed start")
				}
			}
		})
	}
}

func TestRunDaemonSendsLogsToTheLogFileThenStartsPprof(t *testing.T) {
	h := newHarness(t)
	h.cfg.logFile = filepath.Join(t.TempDir(), "d.log")
	h.cfg.pprof = "127.0.0.1:6060"
	h.discoverErr = errors.New("stop here")
	if err := runDaemon(h.cfg, h.deps); err == nil || err.Error() != "stop here" {
		t.Fatalf("runDaemon = %v", err)
	}
	if !slices.Equal(h.redirected, []string{h.cfg.logFile}) || h.pprofAddr != "127.0.0.1:6060" {
		t.Fatalf("logs went to %v, pprof on %q", h.redirected, h.pprofAddr)
	}
	if _, err := os.Stat(h.cfg.logFile); err != nil {
		t.Fatal(err)
	}
}

func TestRunDaemonWithoutAFlagSkipsItsStep(t *testing.T) {
	h := newHarness(t)
	h.deps.redirectLogs = func(*os.File) { t.Error("no -log, but the logs were redirected") }
	h.deps.startPprof = func(string) error { t.Error("no -pprof, but pprof started"); return nil }
	h.discoverErr = errors.New("stop here")
	if err := runDaemon(h.cfg, h.deps); err == nil {
		t.Fatal("runDaemon must fail")
	}
}

func TestRescanLinks(t *testing.T) {
	links := []nics.Nic{{Name: "en5", Index: 9}}
	waitFor := func(t *testing.T, e *fakeEngine, ok func(updates, ticks int) bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok(e.counts()) {
			if time.Now().After(deadline) {
				u, k := e.counts()
				t.Fatalf("updates %d, ticks %d", u, k)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	startLoop := func(discover func() ([]nics.Nic, error)) (*fakeEngine, context.CancelFunc, chan struct{}) {
		e := newFakeEngine(nil)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { rescanLinks(ctx, 3*time.Millisecond, 3*time.Millisecond, discover, e); close(done) }()
		return e, cancel, done
	}
	stop := func(t *testing.T, cancel context.CancelFunc, done chan struct{}) {
		t.Helper()
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("rescanLinks kept running after its context ended")
		}
	}

	t.Run("new links reach the scheduler, and so does the clock", func(t *testing.T) {
		e, cancel, done := startLoop(func() ([]nics.Nic, error) { return links, nil })
		waitFor(t, e, func(u, k int) bool { return u >= 2 && k >= 2 })
		stop(t, cancel, done)
		e.mu.Lock()
		defer e.mu.Unlock()
		if !reflect.DeepEqual(e.updates[0], links) {
			t.Errorf("Update(%v), want %v", e.updates[0], links)
		}
		for _, dt := range e.ticks {
			if dt <= 0 {
				t.Errorf("Tick(%v), want the time since the last tick", dt)
			}
		}
	})
	t.Run("a failed scan keeps the links the scheduler has", func(t *testing.T) {
		var mu sync.Mutex
		scans := 0
		e, cancel, done := startLoop(func() ([]nics.Nic, error) {
			mu.Lock()
			defer mu.Unlock()
			scans++
			return nil, errors.New("sysctl")
		})
		waitFor(t, e, func(_, k int) bool { mu.Lock(); defer mu.Unlock(); return scans >= 2 && k >= 1 })
		stop(t, cancel, done)
		if u, _ := e.counts(); u != 0 {
			t.Fatalf("%d updates after failed scans", u)
		}
	})
}

func TestRealRunDeps(t *testing.T) {
	d := realRunDeps()
	if d.isRoot == nil || d.lock == nil || d.redirectLogs == nil || d.startPprof == nil || d.readRoutes == nil ||
		d.cleanup == nil || d.discover == nil || d.newMerger == nil || d.guard == nil || d.listen == nil ||
		d.signalContext == nil {
		t.Fatalf("a real step is missing: %+v", d)
	}

	links := []nics.Nic{{Name: "en0", Index: 4, IP: net.ParseIP("192.0.2.2"), Weight: 1}}
	sched, tunnel := newMerger(links, engine.V6On, 1500)
	tt, ok := tunnel.(*tun.Tun)
	if !ok || tt.MTU != 1500 || tt.B.V6Mode() != engine.V6On || tt.B.S != sched || tt.Name() != "" {
		t.Fatalf("newMerger tunnel = %+v", tunnel)
	}
	if snap := sched.Snapshot(); len(snap) != 1 || snap[0].Name != "en0" {
		t.Fatalf("newMerger scheduler = %+v", snap)
	}

	if _, err := discoverLinks([]string{"lo0"}, nil); err != nil {
		t.Fatalf("discoverLinks = %v", err)
	}

	ctx, cancel := signalContext()
	if ctx.Err() != nil {
		t.Fatal("the signal context starts done")
	}
	cancel()
	if ctx.Err() == nil {
		t.Fatal("cancel must end the signal context")
	}
}
