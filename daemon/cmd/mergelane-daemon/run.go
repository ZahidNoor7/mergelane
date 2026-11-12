package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/control"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
	"github.com/ZahidNoor7/mergelane/daemon/internal/vpnguard"
)

// cmdRun is `mergelane-daemon run`: it parses the flags, then wires the daemon with the real,
// privileged steps.
func cmdRun(args []string) error {
	c, err := parseRunFlags(args)
	if err != nil {
		return err
	}
	return runDaemon(c, realRunDeps())
}

// runConfig is run's validated flags.
type runConfig struct {
	include    []string
	weights    map[string]float64
	rescan     time.Duration
	auto       bool // weight links by measured throughput; already off when -weight is given
	v6         engine.V6Mode
	mtu        int
	probes     []string
	logFile    string
	stateDir   string
	pprof      string
	allowedUID int
	socketPath string
}

// parseRunFlags turns run's arguments into a runConfig. It needs no privileges and changes nothing
// (a bad flag only prints flag's usage), so every flag error is caught before runDaemon starts.
func parseRunFlags(args []string) (runConfig, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var c engineFlags
	c.register(fs)
	allowedUID := fs.Int("allowed-uid", 0, "the user allowed to drive the daemon besides root")
	socketPath := fs.String("socket", api.SocketPath, "control socket path")
	if err := fs.Parse(args); err != nil {
		return runConfig{}, err
	}
	if c.mtu < 1280 || c.mtu > 65535 {
		return runConfig{}, fmt.Errorf("-mtu must be between 1280 and 65535, got %d", c.mtu)
	}
	// time.NewTicker panics on a non-positive interval, which would crash the daemon later.
	if c.rescan <= 0 {
		return runConfig{}, fmt.Errorf("-rescan must be positive, got %v", c.rescan)
	}
	v6, ok := engine.ParseV6Mode(c.ipv6)
	if !ok {
		return runConfig{}, fmt.Errorf(`-ipv6 must be auto, on or off, got %q`, c.ipv6)
	}
	return runConfig{
		include:    splitList(c.include),
		weights:    c.weights,
		rescan:     c.rescan,
		auto:       c.auto && len(c.weights) == 0,
		v6:         v6,
		mtu:        c.mtu,
		probes:     splitList(c.probes),
		logFile:    c.logFile,
		stateDir:   c.stateDir,
		pprof:      c.pprof,
		allowedUID: *allowedUID,
		socketPath: *socketPath,
	}, nil
}

// splitProbeTargets sorts -probe-targets by address family: a bracketed IPv6 literal
// ("[2001:db8::10]:80") is an IPv6 probe target, anything else (an IPv4 address or a host name)
// stays an IPv4 one, as before. A family left empty keeps its default targets (SetProbeTargets).
// Before this, an IPv6 target was dialled over tcp4 and failed every IPv4 probe.
func splitProbeTargets(targets []string) (v4, v6 []string) {
	for _, t := range targets {
		if host, _, err := net.SplitHostPort(t); err == nil {
			if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
				v6 = append(v6, t)
				continue
			}
		}
		v4 = append(v4, t)
	}
	return v4, v6
}

// runEngine is the scheduler as run drives it (engine.Scheduler).
type runEngine interface {
	control.Engine
	SetAuto(on bool)
	SetLimits(limits map[string]float64)
	RunProbes(stop <-chan struct{})
	Update(found []nics.Nic)
	Tick(dt time.Duration)
}

// runTunnel is the utun as run drives it (tun.Tun).
type runTunnel interface {
	control.Tunnel
	Warm() error
	Close()
}

// runServer is the control socket as run drives it (api.Server).
type runServer interface {
	Path() string
	Close() error
}

var (
	_ runEngine = (*engine.Scheduler)(nil)
	_ runTunnel = (*tun.Tun)(nil)
	_ runServer = (*api.Server)(nil)
)

// runDeps are runDaemon's privileged and process-wide steps. cmdRun passes realRunDeps; tests pass
// fakes, so the wiring is testable without root.
type runDeps struct {
	isRoot        func() bool
	lock          func() bool      // the single-instance lock; false if another daemon holds it
	redirectLogs  func(f *os.File) // send logx, stdout and stderr to the -log file
	startPprof    func(addr string) error
	readRoutes    func() ([]rib.Route, error) // the routing table, to spot a crashed run's routes
	cleanup       func()                      // remove routes a previous run left behind
	discover      func(include []string, weights map[string]float64) ([]nics.Nic, error)
	newMerger     func(found []nics.Nic, v6 engine.V6Mode, mtu int, sticky *engine.Sticky) (runEngine, runTunnel)
	guard         control.Guard
	listen        func(path string, mode os.FileMode, authorize func(uint32) bool, h api.Handler) (runServer, error)
	signalContext func() (context.Context, context.CancelFunc) // done on SIGINT or SIGTERM
}

func realRunDeps() runDeps {
	return runDeps{
		isRoot: platform.IsAdmin,
		lock:   platform.SingleInstance,
		redirectLogs: func(f *os.File) {
			logx.SetOutput(f)
			platform.RedirectStd(f)
		},
		startPprof:    startPprof,
		readRoutes:    rib.Read,
		cleanup:       tun.CleanupStale,
		discover:      discoverLinks,
		newMerger:     newMerger,
		guard:         guardMessages(vpnguard.ReadRoutes, vpnguard.ReadNCConnected),
		listen:        listenAPI,
		signalContext: signalContext,
	}
}

func discoverLinks(include []string, weights map[string]float64) ([]nics.Nic, error) {
	found, _, err := nics.DiscoverNicsDetailed(include, weights)
	return found, err
}

// newMerger builds the scheduler over the discovered links and the utun that balances every flow
// across them, keeping sites on one link while sticky is on (ADR-0048). Nothing is opened yet: Warm
// creates the utun.
func newMerger(found []nics.Nic, v6 engine.V6Mode, mtu int, sticky *engine.Sticky) (runEngine, runTunnel) {
	sched := engine.NewScheduler(found)
	bal := engine.NewBalancer(sched)
	bal.SetV6Mode(v6)
	bal.Sticky = sticky
	t := tun.New(bal)
	t.MTU = mtu
	return sched, t
}

func listenAPI(path string, mode os.FileMode, authorize func(uint32) bool, h api.Handler) (runServer, error) {
	srv, err := api.Listen(path, mode, authorize, h)
	if err != nil {
		return nil, err
	}
	return srv, nil
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// resumeWait is how long auto-resume waits, after a crash, for a link to pass its internet probe.
// A var for tests.
var resumeWait = 10 * time.Second

// runDaemon serves the control socket, merging off, until SIGINT or SIGTERM, then turns merging off
// and removes the utun. After a crash it turns merging back on by itself if the user allowed it
// (auto-resume, the ADR-0007 follow-up).
func runDaemon(c runConfig, d runDeps) error {
	if err := requireRoot("run", d.isRoot); err != nil {
		return err
	}
	if !d.lock() {
		return fmt.Errorf("mergelane-daemon is already running")
	}
	if c.logFile != "" {
		f, err := os.OpenFile(c.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		d.redirectLogs(f)
	}
	if c.pprof != "" {
		if err := d.startPprof(c.pprof); err != nil {
			return err
		}
	}
	if err := state.Prepare(c.stateDir); err != nil {
		return err
	}
	probes4, probes6 := splitProbeTargets(c.probes)
	engine.SetProbeTargets(engine.Fam4, probes4)
	engine.SetProbeTargets(engine.Fam6, probes6)

	// Start clean, and say so if the last run didn't get to (ADR-0007). A run that died while merging
	// was on leaves marked routes behind, or at least never marked its exit clean while the user
	// wanted merging on (a power loss takes the routes with it). After a clean exit, leftover routes
	// are not a crash: Off can leave one on purpose (#20, routemark.Leftovers), and the adapter may be
	// primary again by now.
	prefs, err := state.LoadPrefs(c.stateDir)
	if err != nil {
		logx.Printf("warning: %v (ignored)\n", err)
	}
	leftovers := countLeftovers(d.readRoutes) > 0
	if leftovers {
		logx.Printf("previous run left routes behind; cleaning up\n")
	}
	crashed := !prefs.CleanExit && (leftovers || prefs.WantOn)
	if crashed && !leftovers {
		logx.Printf("previous run stopped unexpectedly while merging was wanted on\n")
	}
	startReason := ""
	if crashed {
		startReason = control.ReasonCrash
	}
	d.cleanup()
	store := state.NewPrefsStore(c.stateDir, prefs)
	if err := store.Update(func(p *state.Prefs) { p.CleanExit = false }); err != nil {
		logx.Printf("warning: saving prefs: %v\n", err)
	}

	found, err := d.discover(c.include, c.weights)
	if err != nil {
		return err
	}
	sticky := engine.NewSticky(prefs.StickySites)
	sched, t := d.newMerger(found, c.v6, c.mtu, sticky)
	sched.SetAuto(c.auto)
	if limits, err := state.LoadLimits(c.stateDir); err == nil {
		sched.SetLimits(limits)
	} else {
		logx.Printf("warning: %v (ignored)\n", err)
	}
	// Create the utun now, so turning merging on and off only touches routes (upstream: tray.go).
	if err := t.Warm(); err != nil {
		return err
	}
	defer t.Close()

	ctx, cancel := d.signalContext()
	defer cancel()
	go sched.RunProbes(ctx.Done())
	rediscover := func() ([]nics.Nic, error) { return d.discover(c.include, c.weights) }
	go rescanLinks(ctx, c.rescan, time.Second, rediscover, sched)

	ctl := control.New(control.Config{
		Version:     version,
		Tunnel:      t,
		Engine:      sched,
		Guard:       d.guard,
		SaveLimits:  func(m map[string]float64) error { return state.SaveLimits(c.stateDir, m) },
		StartReason: startReason,
		Prefs: control.Prefs{
			AutoResume: prefs.AutoResume, WantOn: prefs.WantOn, StickySites: prefs.StickySites,
		},
		SavePrefs: func(p control.Prefs) error {
			return store.Update(func(s *state.Prefs) {
				s.AutoResume, s.WantOn, s.StickySites = p.AutoResume, p.WantOn, p.StickySites
			})
		},
		ApplySticky: sticky.SetOn,
	})
	go ctl.Watch(ctx, time.Second)
	srv, err := d.listen(c.socketPath, 0o666, authorizer(c.allowedUID), ctl)
	if err != nil {
		return err
	}
	logx.Printf("mergelane-daemon %s listening on %s (merging off)\n", version, srv.Path())
	resumed := make(chan struct{})
	if crashed && prefs.AutoResume {
		logx.Printf("auto-resume is on: merging turns back on once a link is up\n")
		wait := resumeWait
		go func() {
			defer close(resumed)
			if ctl.Resume(ctx, wait) {
				logx.Printf("merging turned back on after the restart\n")
			} else if st, _ := ctl.Status(ctx); ctx.Err() == nil && st.State == api.StateOff {
				logx.Printf("auto-resume: %s\n", st.Reason)
			}
		}()
	} else {
		close(resumed)
	}
	<-ctx.Done()
	ctl.Shutdown()
	<-resumed
	srv.Close()
	if err := store.Update(func(p *state.Prefs) { p.CleanExit = true }); err != nil {
		logx.Printf("warning: saving prefs: %v\n", err)
	}
	logx.Printf("mergelane-daemon stopped\n")
	return nil
}

// rescanLinks re-discovers the links every rescan and feeds the scheduler's clock every tick, until
// ctx ends. A failed discovery keeps the links the scheduler already has.
func rescanLinks(ctx context.Context, rescan, tick time.Duration,
	discover func() ([]nics.Nic, error), sched runEngine) {
	rescanT := time.NewTicker(rescan)
	tickT := time.NewTicker(tick)
	defer rescanT.Stop()
	defer tickT.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-rescanT.C:
			if ns, err := discover(); err == nil {
				sched.Update(ns)
			}
		case now := <-tickT.C:
			sched.Tick(now.Sub(last))
			last = now
		}
	}
}
