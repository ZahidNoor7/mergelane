package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
)

const usage = `mergelane-daemon: merges every internet link the Mac has, system-wide.

  mergelane-daemon run        system-wide merging until stopped (root)
  mergelane-daemon off        turn a running instance off
  mergelane-daemon status     show whether it is on, and per-link load
  mergelane-daemon limit <link> <Mbit/s>   cap a link (0 or unlimited removes the cap)
  mergelane-daemon limit      list the saved speed limits
  mergelane-daemon list       show detected links
  mergelane-daemon cleanup    remove routes left behind after a crash (root)
  mergelane-daemon version

Flags for run: -include "en0,en5"  -weight "en0=3"  -auto-weight=false  -stats 5s
`

type weightFlags map[string]float64

func (w weightFlags) String() string { return "" }
func (w weightFlags) Set(v string) error {
	i := strings.LastIndex(v, "=")
	if i < 1 {
		return fmt.Errorf(`want "Name=3", got %q`, v)
	}
	n, err := strconv.ParseFloat(v[i+1:], 64)
	if err != nil || n <= 0 {
		return fmt.Errorf("weight must be > 0 in %q", v)
	}
	w[v[:i]] = n
	return nil
}

type common struct {
	include  string
	weights  weightFlags
	rescan   time.Duration
	stats    time.Duration
	auto     bool
	logFile  string
	stateDir string
	ipv6     string
	mtu      int
	pprof    string
}

func (c *common) register(fs *flag.FlagSet) {
	c.weights = weightFlags{}
	fs.StringVar(&c.include, "include", "", "comma-separated adapter names to use (default: all non-virtual)")
	fs.Var(c.weights, "weight", `fixed adapter weight, repeatable: -weight "Wi-Fi=3"`)
	fs.DurationVar(&c.rescan, "rescan", 3*time.Second, "adapter re-scan interval")
	fs.DurationVar(&c.stats, "stats", 5*time.Second, "stats print interval (0 = off)")
	fs.BoolVar(&c.auto, "auto-weight", true, "weight adapters by measured throughput (off when -weight is given)")
	fs.StringVar(&c.ipv6, "ipv6", "auto", "auto: IPv6 only if every adapter has it (else apps use IPv4 on all adapters); on: always; off: never")
	fs.IntVar(&c.mtu, "mtu", tun.DefaultMTU, "MTU of the virtual adapter (1280-65535); larger means fewer packets and less CPU")
	fs.StringVar(&c.pprof, "pprof", "", "serve Go's profiler on this loopback address, e.g. 127.0.0.1:6060")
	fs.StringVar(&c.logFile, "log", "", "write output to this file instead of the console")
	fs.StringVar(&c.stateDir, "state-dir", state.DefaultDir(), "where status/off marker files live")
}

func (c *common) nicsDetailed() ([]nics.Nic, []nics.Skip, error) {
	var inc []string
	for _, s := range strings.Split(c.include, ",") {
		if s = strings.TrimSpace(s); s != "" {
			inc = append(inc, s)
		}
	}
	return nics.DiscoverNicsDetailed(inc, c.weights)
}

func (c *common) nics() ([]nics.Nic, error) {
	nics, _, err := c.nicsDetailed()
	return nics, err
}

// setup opens the log file (if any) and the state dir.
func (c *common) setup() error {
	// Without admin (`socks`) there may be no state dir to make, e.g. the root-owned one on macOS.
	if err := state.Prepare(c.stateDir); err != nil && platform.IsAdmin() {
		return err
	}
	if c.logFile != "" {
		f, err := os.OpenFile(c.logFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		logx.SetOutput(f)
		platform.RedirectStd(f)
	}
	return nil
}

// boot discovers adapters and starts the background loops: re-scan, 1s throughput sampling
// (which also drives auto-weights and the status file), and periodic stats printing.
func (c *common) boot(mode func() string) (*engine.Scheduler, *engine.Balancer, error) {
	if c.mtu < 1280 || c.mtu > 65535 {
		return nil, nil, fmt.Errorf("-mtu must be between 1280 and 65535, got %d", c.mtu)
	}
	if c.pprof != "" {
		if err := startPprof(c.pprof); err != nil {
			return nil, nil, err
		}
	}
	nics, err := c.nics()
	if err != nil {
		return nil, nil, err
	}
	if len(nics) == 0 {
		return nil, nil, fmt.Errorf("no usable IPv4 links found (try: mergelane-daemon list)")
	}
	sched := engine.NewScheduler(nics)
	sched.SetAuto(c.auto && len(c.weights) == 0)
	if limits, err := state.LoadLimits(c.stateDir); err != nil {
		logx.Printf("warning: %v (ignored)\n", err) // a bad limits file must not stop merging
	} else {
		sched.SetLimits(limits)
	}
	for _, n := range nics {
		logx.Printf("  + %s\n", describeNic(n))
	}
	if len(nics) == 1 {
		logx.Printf("  note: only one adapter found, nothing to aggregate yet\n")
	}

	bal := engine.NewBalancer(sched)
	v6, ok := engine.ParseV6Mode(c.ipv6)
	if !ok {
		return nil, nil, fmt.Errorf(`-ipv6 must be auto, on or off, got %q`, c.ipv6)
	}
	bal.SetV6Mode(v6)

	since := time.Now()
	go sched.RunProbes(nil)
	go func() {
		for range time.Tick(c.rescan) {
			if ns, err := c.nics(); err == nil {
				sched.Update(ns)
			}
		}
	}()
	go func() {
		last := time.Now()
		for now := range time.Tick(time.Second) {
			sched.Tick(now.Sub(last))
			last = now
			if mode != nil {
				if m := mode(); m != "" {
					state.Write(c.stateDir, state.Status{PID: os.Getpid(), Mode: m, V6: bal.V6State(), Since: since, Updated: now, NICs: sched.Snapshot()})
				}
			}
		}
	}()
	if c.stats > 0 {
		go func() {
			for range time.Tick(c.stats) {
				logx.Printf("--- %s\n%s", time.Now().Format("15:04:05"), formatNICs(sched.Snapshot()))
			}
		}()
	}
	return sched, bal, nil
}

func describeNic(n nics.Nic) string {
	s := n.Name
	if n.IP != nil {
		s += "  v4 " + n.IP.String()
	}
	if n.IP6 != nil {
		s += "  v6 " + n.IP6.String()
	}
	return s
}

func formatNICs(snap []engine.SlotStats) string {
	var sb strings.Builder
	for _, s := range snap {
		gone := ""
		if !s.Present {
			gone = " (gone)"
		}
		// "link" is the interface's total traffic by any app; "via mergelane" is the part the daemon
		// relayed. Apps that bind to interfaces directly (like Mergelane's downloader) only show in "link".
		lim := ""
		if s.LimitMbps > 0 {
			lim = "  limit " + limitPhrase(s.LimitMbps)
		}
		fmt.Fprintf(&sb, "%-14s v4 %-11s v6 %-11s link down %6.1f up %5.1f Mbit/s  via mergelane %6.1f  active %3d  total %5d  w %.2f/%.2f  failed %d%s%s\n",
			s.Name, s.State, s.State6, s.LinkIn*8/1e6, s.LinkOut*8/1e6, (s.RateIn+s.RateOut)*8/1e6, s.Active, s.Total, s.Weight, s.Weight6, s.Failed, lim, gone)
	}
	return sb.String()
}

// Set at build time: -X main.version=...
var version = "dev"

func main() {
	var cmd string
	var args []string
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args = os.Args[1], os.Args[2:]
	switch cmd {
	case "version":
		fmt.Println("mergelane-daemon", version)
	case "run":
		cmdRun(args)
	case "off":
		cmdControl(cmd, args)
	case "status":
		cmdStatus(args)
	case "limit":
		cmdLimit(args)
	case "list":
		cmdList(args)
	case "cleanup":
		cmdCleanup()
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func requireRoot(what string) {
	if !platform.IsAdmin() {
		die(fmt.Errorf("%s must run as root", what))
	}
}

func cmdList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	var c common
	c.register(fs)
	fs.Parse(args)
	nics, skipped, err := c.nicsDetailed()
	if err != nil {
		die(err)
	}
	if len(nics) == 0 {
		fmt.Println("No usable adapters found.")
	}
	for _, n := range nics {
		fmt.Printf("USE   %s  (index %d)\n", describeNic(n), n.Index)
	}
	for _, s := range skipped {
		fmt.Printf("skip  %s: %s\n", s.Name, s.Reason)
	}
}

func cmdRun(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	var c common
	c.register(fs)
	crashAfter := fs.Duration("crash-after", 0, "test only: exit abruptly (no cleanup) after this long")
	runFor := fs.Duration("for", 0, "turn off automatically after this long (0 = until stopped)")
	fs.Parse(args)

	requireRoot("run")
	if !platform.SingleInstance() {
		fmt.Println("mergelane-daemon is already running (`mergelane-daemon off` turns it off).")
		return
	}
	if err := c.setup(); err != nil {
		die(err)
	}
	state.TakeMarker(c.stateDir, "off") // drop a stale marker

	sched, bal, err := c.boot(func() string { return "system-wide" })
	if err != nil {
		logx.Printf("error: %v\n", err)
		os.Exit(1)
	}
	t := tun.New(bal)
	t.MTU = c.mtu
	if err := t.On(); err != nil {
		logx.Printf("error: %v\n", err)
		os.Exit(1)
	}
	logx.Printf("mergelane-daemon is ON: all IPv4 traffic is balanced across the links above. Ctrl+C or `mergelane-daemon off` to stop.\n")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	var crash, timeUp <-chan time.Time
	if *crashAfter > 0 {
		crash = time.After(*crashAfter)
	}
	if *runFor > 0 {
		timeUp = time.After(*runFor)
	}
	poll := time.NewTicker(300 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case <-sig:
		case <-timeUp:
		case <-crash:
			os.Exit(3) // simulates a crash: no teardown runs
		case <-poll.C:
			if req, ok := state.TakeLimit(c.stateDir); ok {
				sched.SetLimit(req.Adapter, req.Mbps)
				if err := state.SaveLimits(c.stateDir, sched.Limits()); err != nil {
					logx.Printf("warning: saving speed limits: %v\n", err)
				}
			}
			if !state.TakeMarker(c.stateDir, "off") && !state.TakeMarker(c.stateDir, "quit") {
				continue
			}
		}
		break
	}
	t.Close()
	state.Clear(c.stateDir)
	logx.Printf("mergelane-daemon is OFF.\n")
}

// cmdControl implements `off` against a running instance.
func cmdControl(name string, args []string) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	dir := fs.String("state-dir", state.DefaultDir(), "state directory")
	fs.Parse(args)
	if !platform.InstanceRunning() {
		if name == "off" || name == "quit" {
			fmt.Println("mergelane-daemon is not running (already off).")
			return
		}
		die(fmt.Errorf("mergelane-daemon is not running"))
	}
	_, wasOn := state.Read(*dir)
	if err := state.SendMarker(*dir, name); err != nil {
		die(err)
	}
	want := name == "on"
	for i := 0; i < 60; i++ {
		time.Sleep(150 * time.Millisecond)
		_, on := state.Read(*dir)
		switch {
		case name == "on" && on == want:
			fmt.Println("mergelane-daemon is ON.")
			return
		case name != "on" && !on:
			fmt.Println("mergelane-daemon is OFF.")
			return
		}
	}
	_ = wasOn
	die(fmt.Errorf("sent %q but it did not take effect", name))
}

func cmdStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	dir := fs.String("state-dir", state.DefaultDir(), "state directory")
	fs.Parse(args)
	st, on := state.Read(*dir)
	if !on {
		fmt.Println("mergelane-daemon is OFF.")
		return
	}
	fmt.Printf("mergelane-daemon is ON (%s, pid %d, up %s)\nIPv6: %s\n%s", st.Mode, st.PID, time.Since(st.Since).Truncate(time.Second), st.V6, formatNICs(st.NICs))
}

// cmdLimit lists the saved caps, or sets one. A running instance gets the change through a marker
// file and saves it; with nothing running, limits.json is updated directly so the next start picks
// it up.
func cmdLimit(args []string) {
	fs := flag.NewFlagSet("limit", flag.ExitOnError)
	dir := fs.String("state-dir", state.DefaultDir(), "state directory")
	fs.Parse(args)
	rest := fs.Args()

	if len(rest) == 0 {
		limits, err := state.LoadLimits(*dir)
		if err != nil {
			die(err)
		}
		if len(limits) == 0 {
			fmt.Println("No speed limits set.")
			return
		}
		names := make([]string, 0, len(limits))
		for name := range limits {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			fmt.Printf("%-14s %s\n", name, limitPhrase(limits[name]))
		}
		return
	}
	if len(rest) != 2 {
		fmt.Fprintln(os.Stderr, "usage: mergelane-daemon limit <link> <Mbit/s>   (0, off or unlimited removes the cap)")
		os.Exit(2)
	}
	name := strings.TrimSpace(rest[0])
	mbitPerSec, err := engine.ParseLimit(rest[1])
	if err != nil {
		die(err)
	}
	live, err := limitApply(*dir, name, mbitPerSec, platform.InstanceRunning(), limitWait)
	if err != nil {
		die(err)
	}
	if live {
		fmt.Printf("%s: %s.\n", name, limitPhrase(mbitPerSec))
	} else {
		fmt.Printf("%s: %s. It takes effect the next time mergelane-daemon starts.\n", name, limitPhrase(mbitPerSec))
	}
}

// limitWait is how long `mergelane-daemon limit` waits for a running instance to apply and save the cap.
var limitWait = 4 * time.Second

// limitApply saves a cap. With a running instance the request goes through ctl/ and the instance
// applies it and saves limits.json; with nothing running this writes limits.json itself, so the
// next start picks it up. It reports whether a running instance applied it.
func limitApply(dir, name string, mbitPerSec float64, running bool, wait time.Duration) (live bool, err error) {
	if !running {
		limits, err := state.LoadLimits(dir)
		if err != nil {
			return false, err
		}
		if mbitPerSec <= 0 {
			delete(limits, name)
		} else {
			limits[name] = mbitPerSec
		}
		return false, state.SaveLimits(dir, limits)
	}
	if err := state.SendLimit(dir, state.LimitRequest{Adapter: name, Mbps: mbitPerSec}); err != nil {
		return true, err
	}
	// The instance applies it within a second and saves limits.json; wait for that as proof.
	deadline := time.Now().Add(wait)
	for {
		if limits, err := state.LoadLimits(dir); err == nil {
			got, set := limits[name]
			if (mbitPerSec <= 0 && !set) || (set && got == mbitPerSec) {
				return true, nil
			}
		}
		if time.Now().After(deadline) {
			return true, fmt.Errorf("sent the limit, but the running instance did not apply it")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func limitPhrase(mbitPerSec float64) string {
	if mbitPerSec <= 0 {
		return "unlimited"
	}
	return strconv.FormatFloat(mbitPerSec, 'f', -1, 64) + " Mbit/s"
}

func cmdCleanup() {
	requireRoot("cleanup")
	tun.CleanupStale()
	fmt.Println("done.")
}
