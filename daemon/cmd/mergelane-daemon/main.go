// Command mergelane-daemon is Mergelane's root helper: it merges every internet link the Mac has,
// system-wide, and is driven by the app through the control socket (internal/api).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/control"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/launchd"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/routemark"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
	"github.com/ZahidNoor7/mergelane/daemon/internal/vpnguard"
)

const usage = `mergelane-daemon: merges every internet link the Mac has, system-wide.

  mergelane-daemon run --allowed-uid <uid>   serve the control socket, merging off until asked (root; launchd runs this)
  mergelane-daemon install --uid <uid> [--source <binary>]   install as a LaunchDaemon (root)
  mergelane-daemon uninstall                 remove the LaunchDaemon and its routes (root)
  mergelane-daemon cleanup                   remove routes left behind after a crash (root)
  mergelane-daemon status | on | off | links | stats | events
  mergelane-daemon limit <link> <Mbit/s>     cap a link (0 removes the cap)
  mergelane-daemon auto-resume on|off        turn merging back on by itself after a crash (off by default)
  mergelane-daemon sticky-sites on|off       keep each website on one network (on by default)
  mergelane-daemon list                      show detected links
  mergelane-daemon version
`

// Set at build time: -X main.version=...
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	os.Exit(dispatch(os.Args[1], os.Args[2:], os.Stdout, os.Stderr))
}

// notYet names the commands this platform can't run yet, with why. Windows fills it
// (notyet_windows.go): the system-wide helper comes there in milestone W5.
var notYet map[string]string

// dispatch runs one command and returns the process exit code.
func dispatch(cmd string, args []string, stdout, stderr io.Writer) int {
	if why, ok := notYet[cmd]; ok {
		fmt.Fprintln(stderr, "error:", why)
		return 1
	}
	var err error
	switch cmd {
	case "version":
		fmt.Fprintln(stdout, "mergelane-daemon", version)
	case "run":
		err = cmdRun(args)
	case "install":
		err = cmdInstall(args, stdout)
	case "uninstall":
		err = cmdUninstall(args, stdout)
	case "cleanup":
		err = cmdCleanup(stdout)
	case "list":
		err = cmdList(args, stdout)
	case "status", "on", "off", "links", "stats", "limit", "events", "auto-resume", "sticky-sites":
		err = cmdClient(cmd, args, stdout)
	default:
		fmt.Fprint(stderr, usage)
		return 2
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	return 0
}

// requireRoot fails unless isRoot (platform.IsAdmin) says this process runs as root.
func requireRoot(what string, isRoot func() bool) error {
	if !isRoot() {
		return fmt.Errorf("%s must run as root", what)
	}
	return nil
}

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

// engineFlags are the link-selection and tuning flags of run and list.
type engineFlags struct {
	include  string
	weights  weightFlags
	rescan   time.Duration
	auto     bool
	ipv6     string
	mtu      int
	probes   string
	logFile  string
	stateDir string
	pprof    string
}

func (c *engineFlags) register(fs *flag.FlagSet) {
	c.weights = weightFlags{}
	fs.StringVar(&c.include, "include", "", "comma-separated link names to use (default: all with internet)")
	fs.Var(c.weights, "weight", `fixed link weight, repeatable: -weight "en0=3"`)
	fs.DurationVar(&c.rescan, "rescan", 3*time.Second, "link re-scan interval")
	fs.BoolVar(&c.auto, "auto-weight", true, "weight links by measured throughput (off when -weight is given)")
	fs.StringVar(&c.ipv6, "ipv6", "auto", "auto: IPv6 only if every link has it; on: always; off: never")
	fs.IntVar(&c.mtu, "mtu", tun.DefaultMTU, "MTU of the utun (1280-65535)")
	fs.StringVar(&c.probes, "probe-targets", "", "comma-separated host:port reachability targets; bracketed IPv6 ones ([::1]:443) replace the IPv6 targets "+
		"(default 1.1.1.1:443,8.8.8.8:443 and [2606:4700:4700::1111]:443,[2001:4860:4860::8888]:443)")
	fs.StringVar(&c.logFile, "log", "", "write output to this file")
	fs.StringVar(&c.stateDir, "state-dir", state.DefaultDir(), "state directory (control socket)")
	fs.StringVar(&c.pprof, "pprof", "", "serve Go's profiler on this loopback address")
}

func (c *engineFlags) discover() ([]nics.Nic, []nics.Skip, error) {
	return nics.DiscoverNicsDetailed(splitList(c.include), c.weights)
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
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

func cmdList(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	var c engineFlags
	c.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	found, skipped, err := c.discover()
	if err != nil {
		return err
	}
	if len(found) == 0 {
		fmt.Fprintln(out, "No usable links found.")
	}
	for _, n := range found {
		fmt.Fprintf(out, "USE   %s  (index %d)\n", describeNic(n), n.Index)
	}
	for _, s := range skipped {
		fmt.Fprintf(out, "skip  %s: %s\n", s.Name, s.Reason)
	}
	return nil
}

// countLeftovers reports how many marked routes a previous run left behind: if any, it didn't shut
// down cleanly (ADR-0007).
func countLeftovers(read func() ([]rib.Route, error)) int {
	routes, err := read()
	if err != nil {
		return 0
	}
	return len(routemark.Leftovers(routes))
}

// guardMessages adapts the VPN guard to the controller.
func guardMessages(readRoutes func() ([]rib.Route, error), readNC func(context.Context) ([]string, error)) control.Guard {
	return func(ctx context.Context, ours func(string) bool) ([]string, error) {
		routes, err := readRoutes()
		if err != nil {
			return nil, err
		}
		services, err := readNC(ctx)
		if err != nil {
			return nil, err
		}
		var msgs []string
		for _, c := range vpnguard.Conflicts(routes, ours, services) {
			msgs = append(msgs, c.Message())
		}
		return msgs, nil
	}
}

// authorizer allows root and the console user the app installed the daemon for (ADR-0005).
func authorizer(allowed int) func(uint32) bool {
	return func(uid uint32) bool { return uid == 0 || (allowed > 0 && uid == uint32(allowed)) }
}

func cmdCleanup(out io.Writer) error {
	if err := requireRoot("cleanup", platform.IsAdmin); err != nil {
		return err
	}
	tun.CleanupStale()
	fmt.Fprintln(out, "done.")
	return nil
}

func cmdInstall(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	uid := fs.Int("uid", 0, "the console user's uid (the app passes its own)")
	source := fs.String("source", "", "binary to install (default: this one)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *source == "" {
		self, err := os.Executable()
		if err != nil {
			return err
		}
		*source = self
	}
	if err := launchd.Install(context.Background(), launchd.Options{Source: *source, UID: *uid}); err != nil {
		return err
	}
	fmt.Fprintln(out, "installed", launchd.Label)
	return nil
}

func cmdUninstall(_ []string, out io.Writer) error {
	res, err := launchd.Uninstall(context.Background(), launchd.Options{
		Cleanup: func(context.Context, []string) error { tun.CleanupStale(); return nil },
	})
	if err != nil {
		return err
	}
	if res.Hint != "" {
		fmt.Fprintln(out, res.Hint)
	}
	fmt.Fprintln(out, "uninstalled", launchd.Label)
	return nil
}

// cmdClient drives a running daemon through the control socket.
func cmdClient(cmd string, args []string, out io.Writer) error {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	socketPath := fs.String("socket", api.SocketPath, "control socket path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if cmd == "limit" && len(rest) != 2 {
		return fmt.Errorf("usage: mergelane-daemon limit <link> <Mbit/s>")
	}
	if cmd == "auto-resume" && (len(rest) != 1 || rest[0] != "on" && rest[0] != "off") {
		return fmt.Errorf("usage: mergelane-daemon auto-resume on|off")
	}
	if cmd == "sticky-sites" && (len(rest) != 1 || rest[0] != "on" && rest[0] != "off") {
		return fmt.Errorf("usage: mergelane-daemon sticky-sites on|off")
	}
	cl, err := api.Dial(*socketPath)
	if err != nil {
		return fmt.Errorf("mergelane-daemon isn't running or isn't reachable: %w", err)
	}
	defer cl.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	switch cmd {
	case "status":
		st, err := cl.Status(ctx)
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStatus(st))
	case "on":
		st, err := cl.Enable(ctx)
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStatus(st))
	case "off":
		st, err := cl.Disable(ctx, "")
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStatus(st))
	case "links":
		res, err := cl.Links(ctx)
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatLinks(res.Links))
	case "stats":
		res, err := cl.Stats(ctx)
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStats(res.Links))
	case "limit":
		mbps, err := engine.ParseLimit(rest[1])
		if err != nil {
			return err
		}
		res, err := cl.SetLimit(ctx, rest[0], mbps)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s: %s\n", res.Link, limitPhrase(res.Mbps))
	case "events":
		res, err := cl.Events(ctx)
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatEvents(res.Events))
	case "auto-resume":
		st, err := cl.SetAutoResume(ctx, rest[0] == "on")
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStatus(st))
	case "sticky-sites":
		st, err := cl.SetStickySites(ctx, rest[0] == "on")
		if err != nil {
			return err
		}
		fmt.Fprint(out, formatStatus(st))
	}
	return nil
}

func formatStatus(st api.Status) string {
	s := fmt.Sprintf("system merge: %s (daemon %s, protocol %d)\n", st.State, st.Version, st.Protocol)
	if st.Reason != "" {
		s += "reason: " + st.Reason + "\n"
	}
	if st.AutoResume {
		s += "auto-resume after a crash: on\n"
	}
	if st.StickySites {
		s += "each site kept on one network: on\n"
	}
	return s
}

func formatEvents(events []api.LinkEvent) string {
	if len(events) == 0 {
		return "No link changes since the daemon started.\n"
	}
	var sb strings.Builder
	for _, e := range events {
		fmt.Fprintf(&sb, "%s  %-8s %-7s -> %-7s  %s\n", e.At.Local().Format(time.DateTime), e.Link, e.From, e.To, e.Reason)
	}
	return sb.String()
}

func formatLinks(links []api.Link) string {
	var sb strings.Builder
	for _, l := range links {
		fmt.Fprintf(&sb, "%-8s index %-3d %-8s up=%-5t v4 %-15s v6 %s", l.Name, l.Index, l.State, l.Up, l.IPv4, l.IPv6)
		if l.LimitMbps > 0 {
			sb.WriteString("  limit " + limitPhrase(l.LimitMbps))
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

func formatStats(links []api.LinkStats) string {
	var sb strings.Builder
	for _, l := range links {
		fmt.Fprintf(&sb, "%-8s merged down %7.1f up %6.1f Mbit/s  link down %7.1f up %6.1f  flows %d/%d  weight %.2f  failed %d\n",
			l.Name, l.RxBps*8/1e6, l.TxBps*8/1e6, l.LinkRxBps*8/1e6, l.LinkTxBps*8/1e6, l.ActiveFlows, l.TotalFlows, l.Weight, l.Failed)
	}
	return sb.String()
}

func limitPhrase(mbitPerSec float64) string {
	if mbitPerSec <= 0 {
		return "unlimited"
	}
	return strconv.FormatFloat(mbitPerSec, 'f', -1, 64) + " Mbit/s"
}
