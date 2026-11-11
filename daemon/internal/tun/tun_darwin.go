package tun

import (
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/routemark"
)

const openHint = "needs root"

// macOS only accepts "utun" or "utunN" as a TUN name; "utun" lets the kernel pick the number.
func init() {
	openName = "utun"
	staleHook = cleanupMarked
	keepDevice = true
}

// configure gives the new utun its addresses and capture routes, and returns its index.
// ponytail: shells out to ifconfig/route (once per on/off); PF_ROUTE messages if that ever matters.
//
// Mergelane: every route added here and in syncScoped carries route(8)'s -proto2 (RTF_PROTO2), via
// routemark, so cleanup can tell our routes from everyone else's (ADR-0006).
func configure(name string, _ int, ip4 netip.Prefix) (int, error) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return 0, fmt.Errorf("adapter %q did not appear: %w", name, err)
	}
	// Before the capture routes: pinned sockets need these the moment the /1 routes exist.
	if err := startScopedSync(); err != nil {
		return ifc.Index, err
	}
	addr := ip4.Addr().String()
	if err := run("/sbin/ifconfig", name, "inet", addr, addr, "up"); err != nil {
		return ifc.Index, err
	}
	for _, dst := range routes4 {
		if err := run("/sbin/route", routemark.AddArgs(routemark.Capture(netip.MustParsePrefix(dst), name))...); err != nil {
			return ifc.Index, err
		}
	}
	// IPv6 is best-effort: if it can't be set up, IPv4 still works and IPv6 stays on its normal path.
	if err := run("/sbin/ifconfig", name, "inet6", tunIP6, "prefixlen", "64", "alias"); err != nil {
		logx.Printf("warning: IPv6 not captured: %v\n", err)
		return ifc.Index, nil
	}
	for _, dst := range routes6 {
		if err := run("/sbin/route", routemark.AddArgs(routemark.Capture(netip.MustParsePrefix(dst), name))...); err != nil {
			logx.Printf("warning: IPv6 route %s: %v\n", dst, err)
		}
	}
	return ifc.Index, nil
}

// delRoutes removes the capturing routes. Closing the utun removes them anyway, but deleting
// them first stops capture before the stack goes away.
//
// Mergelane: XNU's RTM_DELETE finds the entry by destination and netmask only, whatever interface
// holds it, so upstream's unconditional "route delete 0.0.0.0/1 -interface utunN" would also remove
// another VPN's 0/1 that had replaced ours. Only the capture routes the table shows on our utun are
// deleted now. If the table cannot be read, it falls back to upstream's deletes, so capture never
// outlives Off.
func delRoutes(idx int) {
	defer stopScopedSync()
	ifc, err := net.InterfaceByIndex(idx)
	if err != nil {
		return // adapter already gone, and its routes with it
	}
	var capture []routemark.Route
	for _, dst := range routes4 {
		capture = append(capture, routemark.Capture(netip.MustParsePrefix(dst), ifc.Name))
	}
	for _, dst := range routes6 {
		capture = append(capture, routemark.Capture(netip.MustParsePrefix(dst), ifc.Name))
	}
	if table, err := rib.Read(); err == nil {
		capture = routemark.Installed(table, capture)
	}
	for _, r := range capture {
		run("/sbin/route", routemark.DeleteArgs(r)...)
	}
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return cmdError(name, args, err, out)
	}
	return nil
}

// Our own sockets are bound to an adapter (IP_BOUND_IF), and the kernel then looks routes up
// among that adapter's scoped routes. macOS only keeps a scoped default for non-primary services;
// the primary one has just an unscoped default, which the bound lookup falls back to until the
// more specific /1 capture routes shadow it ("no route to host", network dead). So every adapter
// with a default route also gets a scoped one, kept in step with gateway changes.
var realName = regexp.MustCompile(`^(en|feth)\d+$`)

// Seams for tests: the default routes the sync reads, and the route(8) commands it runs.
var (
	defaultRoutes = nics.DefaultRoutes
	routeCmd      = func(args ...string) error { return run("/sbin/route", args...) }
)

type scopedKey struct {
	name string
	v6   bool
}

var scoped struct {
	mu    sync.Mutex
	added map[scopedKey]string // scoped defaults we added, with their gateway
	stop  chan struct{}        // non-nil while capture is on
}

// scopedEvery is how often the scoped defaults are brought in step with the table (a var for tests).
var scopedEvery = 3 * time.Second

// scopedArgs builds "-q -n <verb> -inet[6] default <gw>[%<name>] -ifscope <name>" as before; adds now
// also carry -proto2 (routemark), so cleanup can find them after a crash.
func scopedArgs(verb string, k scopedKey, gw string) []string {
	r := routemark.ScopedDefault(k.v6, gw, k.name)
	if verb == "add" {
		return routemark.AddArgs(r)
	}
	return routemark.DeleteArgs(r)
}

func startScopedSync() error {
	stop := make(chan struct{})
	scoped.mu.Lock()
	scoped.stop, scoped.added = stop, map[scopedKey]string{}
	scoped.mu.Unlock()
	if err := syncScoped(stop); err != nil {
		stopScopedSync()
		return fmt.Errorf("scoped routes: %w", err)
	}
	every := scopedEvery
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if err := syncScoped(stop); err != nil {
					logx.Printf("warning: scoped routes: %v\n", err)
				}
			}
		}
	}()
	return nil
}

func stopScopedSync() {
	routes, _ := defaultRoutes()
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	if scoped.stop != nil {
		close(scoped.stop)
		scoped.stop = nil
	}
	primary := map[scopedKey]bool{}
	for _, r := range routes {
		if !r.Scoped && r.GW != nil {
			primary[scopedKey{r.Name, r.V6}] = true
		}
	}
	for k, gw := range scoped.added {
		// Only where the adapter is still primary: on one that stopped being primary since the last
		// sync, macOS needs this route as its own scoped default (see syncScoped).
		if routes == nil || primary[k] {
			routeCmd(scopedArgs("delete", k, gw)...)
		}
	}
	scoped.added = nil
}

// syncScoped gives every primary en/feth adapter a scoped default via its gateway, and keeps it there.
//
// Mergelane (M2.4, links that come back): the table's scoped defaults are told apart by our marker
// (DefaultRoute.Marked, ADR-0006) instead of being taken all for macOS's:
//   - macOS's own scoped default (unmarked) is left alone, as upstream did.
//   - Ours with the right gateway is adopted even when this sync had forgotten it: after #20 left it
//     to a non-primary adapter that is primary again, or on an adapter that went away and came back
//     while the route survived. Unadopted, Off would leave it behind, and the next start would report
//     a crash that never happened.
//   - Ours with another gateway is replaced: the adapter came back on another network, and pinned
//     sockets would otherwise keep sending to the old router.
//   - An adapter that came back with no scoped default (the kernel removed ours with the old interface,
//     whatever its index was) gets one again at the next sync.
//
// An adapter whose only default is scoped is not primary; macOS owns that route (or ours stands in for
// it, #20) and the sync does nothing there.
func syncScoped(stop chan struct{}) error {
	routes, err := defaultRoutes()
	if err != nil {
		return err
	}
	want := map[scopedKey]string{} // primary adapters, by the gateway of their unscoped default
	theirs := map[scopedKey]bool{} // scoped defaults someone else made (macOS)
	mine := map[scopedKey]string{} // scoped defaults carrying our marker, by gateway
	for _, r := range routes {
		if !realName.MatchString(r.Name) {
			continue
		}
		k := scopedKey{r.Name, r.V6}
		switch {
		case r.Scoped && r.Marked && r.GW != nil:
			mine[k] = r.GW.String()
		case r.Scoped:
			theirs[k] = true
		case r.GW != nil:
			want[k] = r.GW.String()
		}
	}
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	if scoped.stop != stop {
		return nil // capture was switched off meanwhile
	}
	var first error
	for k, gw := range want {
		have, present := mine[k]
		switch {
		case theirs[k]:
			delete(scoped.added, k)
			continue // macOS keeps its own scoped default here
		case present && have == gw:
			scoped.added[k] = gw
			continue
		case present:
			routeCmd(scopedArgs("delete", k, have)...)
		}
		delete(scoped.added, k)
		if err := routeCmd(scopedArgs("add", k, gw)...); err != nil && !strings.Contains(err.Error(), "File exists") {
			if first == nil {
				first = err
			}
			continue
		}
		scoped.added[k] = gw
	}
	for k := range scoped.added {
		if _, ok := want[k]; !ok {
			// No longer the primary service (a tether took over): macOS now wants a scoped default
			// there itself, and ours, already in its place, made its own add fail. Leave the route to
			// macOS; deleting it would leave the adapter with no default route until it reconnects (#20).
			// Or the adapter is gone, and its routes with it.
			delete(scoped.added, k)
		}
	}
	return first
}

// cleanupMarked removes routes a crashed run left behind: the scoped defaults (they survive kill -9,
// while the capture routes die with the utun), and the capture routes of an adapter that is still
// there, as when `mergelane-daemon cleanup` runs beside a live daemon.
//
// Mergelane: upstream's cleanupScoped deleted any scoped default on a primary adapter that repeated
// its unscoped one, taking it to be ours because macOS makes none there; that could also remove a route
// the user or another program added (ADR-0006). Now only routes carrying our -proto2 marker go
// (routemark.Leftovers), and upstream's rule still holds that a scoped default on an adapter that is
// no longer primary is left to macOS (#20).
func cleanupMarked() {
	routes, err := rib.Read()
	if err != nil {
		logx.Printf("warning: cleanup: %v\n", err)
		return
	}
	for _, args := range routemark.CleanupCommands(routemark.Leftovers(routes)) {
		if err := run("/sbin/route", args...); err != nil {
			logx.Printf("warning: cleanup: %v\n", err)
		}
	}
}
