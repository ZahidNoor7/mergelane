package tun

import (
	"errors"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
)

// The scoped-default sync against a fake routing table: links that go away and come back (unplug,
// sleep and wake, a new interface index) without root and without touching the Mac's routes.

type fakeTable struct {
	mu     sync.Mutex
	routes []nics.DefaultRoute
	err    error
	addErr error // returned by every "add"
	cmds   []string
}

func (f *fakeTable) set(routes ...nics.DefaultRoute) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes = routes
}

func (f *fakeTable) read() ([]nics.DefaultRoute, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.routes), f.err
}

func (f *fakeTable) run(args ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, strings.Join(args, " "))
	if args[2] == "add" {
		return f.addErr
	}
	return nil
}

// takeCmds returns the route commands run since the last call, sorted (the sync walks maps).
func (f *fakeTable) takeCmds() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.cmds
	f.cmds = nil
	slices.Sort(out)
	return out
}

// fakeScoped installs a fake table and command runner, with capture "on" (a sync running).
func fakeScoped(t *testing.T) (*fakeTable, chan struct{}) {
	t.Helper()
	f := &fakeTable{}
	oldRead, oldRun := defaultRoutes, routeCmd
	defaultRoutes, routeCmd = f.read, f.run
	stop := make(chan struct{})
	scoped.mu.Lock()
	scoped.stop, scoped.added = stop, map[scopedKey]string{}
	scoped.mu.Unlock()
	t.Cleanup(func() {
		scoped.mu.Lock()
		scoped.stop, scoped.added = nil, nil
		scoped.mu.Unlock()
		defaultRoutes, routeCmd = oldRead, oldRun
	})
	return f, stop
}

// primary is an adapter's unscoped default: it is the primary service.
func primary(name string, index int, gw string) nics.DefaultRoute {
	return nics.DefaultRoute{Index: index, Name: name, GW: net.ParseIP(gw), V6: strings.Contains(gw, ":")}
}

// ourScoped is a scoped default carrying our marker; macosScoped one that macOS made.
func ourScoped(name string, index int, gw string) nics.DefaultRoute {
	r := primary(name, index, gw)
	r.Scoped, r.Marked = true, true
	return r
}

func macosScoped(name string, index int, gw string) nics.DefaultRoute {
	r := primary(name, index, gw)
	r.Scoped = true
	return r
}

func added() map[scopedKey]string {
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	out := map[scopedKey]string{}
	for k, v := range scoped.added {
		out[k] = v
	}
	return out
}

func sync1(t *testing.T, f *fakeTable, stop chan struct{}) []string {
	t.Helper()
	if err := syncScoped(stop); err != nil {
		t.Fatalf("syncScoped = %v", err)
	}
	return f.takeCmds()
}

func expectCmds(t *testing.T, got []string, want ...string) {
	t.Helper()
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("route commands =\n  %q\nwant\n  %q", got, want)
	}
}

const (
	addEn0  = "-q -n add -inet default 192.168.1.1 -ifscope en0 -proto2"
	delEn0  = "-q -n delete -inet default 192.168.1.1 -ifscope en0"
	addEn0b = "-q -n add -inet default 10.0.0.1 -ifscope en0 -proto2"
)

func TestScopedSyncReAddsTheDefaultOfALinkThatComesBack(t *testing.T) {
	f, stop := fakeScoped(t)
	en7 := macosScoped("en7", 19, "172.20.10.1") // a tether that is not primary: macOS's own route

	f.set(primary("en0", 11, "192.168.1.1"), en7)
	expectCmds(t, sync1(t, f, stop), addEn0)
	f.set(primary("en0", 11, "192.168.1.1"), ourScoped("en0", 11, "192.168.1.1"), en7)
	expectCmds(t, sync1(t, f, stop)) // in step: nothing to do

	// Unplugged (or asleep): its routes went with it. The other link is left alone.
	f.set(en7)
	expectCmds(t, sync1(t, f, stop))
	if len(added()) != 0 {
		t.Fatalf("a gone link is still tracked: %v", added())
	}

	// Back, with a new interface index: routes are keyed by name, so the scoped default comes back.
	f.set(primary("en0", 24, "192.168.1.1"), en7)
	expectCmds(t, sync1(t, f, stop), addEn0)
	if got := added(); got[scopedKey{"en0", false}] != "192.168.1.1" || len(got) != 1 {
		t.Fatalf("tracked %v", got)
	}
}

// The adapter stayed, but its routes went (link down and up): the next sync puts ours back.
func TestScopedSyncReAddsARouteTheKernelRemoved(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), addEn0)
	f.set(primary("en0", 11, "192.168.1.1")) // ours vanished from the table
	expectCmds(t, sync1(t, f, stop), addEn0)
}

func TestScopedSyncReplacesOurRouteToAnOldRouter(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), addEn0)
	// Back on another network, while our route to the old router survived.
	f.set(primary("en0", 11, "10.0.0.1"), ourScoped("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), delEn0, addEn0b)
	if got := added()[scopedKey{"en0", false}]; got != "10.0.0.1" {
		t.Fatalf("tracked gateway %q", got)
	}
}

// #20 left our route to an adapter that stopped being primary, and the sync forgot it. When the
// adapter is primary again, the sync adopts the route instead of mistaking it for macOS's, so Off
// removes it and the next start does not report a crash.
func TestScopedSyncAdoptsOurForgottenRoute(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), addEn0)

	// en7 took over as primary: en0 keeps our scoped default as its only default (#20).
	f.set(ourScoped("en0", 11, "192.168.1.1"), primary("en7", 19, "172.20.10.1"))
	expectCmds(t, sync1(t, f, stop), "-q -n add -inet default 172.20.10.1 -ifscope en7 -proto2")
	if _, ok := added()[scopedKey{"en0", false}]; ok {
		t.Fatal("a route left to macOS (#20) is still tracked")
	}

	// en0 is primary again; our route is still there.
	f.set(primary("en0", 11, "192.168.1.1"), ourScoped("en0", 11, "192.168.1.1"),
		macosScoped("en7", 19, "172.20.10.1"))
	expectCmds(t, sync1(t, f, stop))
	if got := added()[scopedKey{"en0", false}]; got != "192.168.1.1" {
		t.Fatalf("our route was not adopted: %v", added())
	}
	stopScopedSync()
	expectCmds(t, f.takeCmds(), delEn0)
}

func TestScopedSyncLeavesMacOSRoutesAlone(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), addEn0)
	// macOS made its own scoped default for the primary adapter after all: ours can't be there too.
	f.set(primary("en0", 11, "192.168.1.1"), macosScoped("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop))
	if len(added()) != 0 {
		t.Fatalf("macOS's route is tracked as ours: %v", added())
	}
	// Even with another gateway: deleting by destination and scope would remove macOS's route.
	f.set(primary("en0", 11, "10.0.0.1"), macosScoped("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop))
	stopScopedSync()
	expectCmds(t, f.takeCmds())
}

// A link whose only default is scoped is not the primary service: there is nothing to add.
func TestScopedSyncIgnoresLinksWithOnlyAScopedDefault(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(
		macosScoped("en7", 19, "172.20.10.1"),
		ourScoped("en8", 21, "192.168.42.129"), // #20: ours, standing in for macOS's
		macosScoped("feth10", 30, "fe80::1"),
	)
	expectCmds(t, sync1(t, f, stop))
	if len(added()) != 0 {
		t.Fatalf("tracked %v", added())
	}
	stopScopedSync()
	expectCmds(t, f.takeCmds()) // and Off leaves them all
}

func TestScopedSyncSkipsVirtualAdaptersAndGatewaylessDefaults(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(
		primary("utun4", 25, "10.8.0.1"),
		primary("bridge100", 26, "192.168.2.1"),
		nics.DefaultRoute{Index: 11, Name: "en0"},                             // a link#N default
		nics.DefaultRoute{Index: 11, Name: "en0", Scoped: true, Marked: true}, // gatewayless: not ours to manage
	)
	expectCmds(t, sync1(t, f, stop))
}

func TestScopedSyncIPv6(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "fe80::1"))
	expectCmds(t, sync1(t, f, stop), "-q -n add -inet6 default fe80::1%en0 -ifscope en0 -proto2")
	f.set(primary("en0", 11, "fe80::1"), ourScoped("en0", 11, "fe80::1"))
	expectCmds(t, sync1(t, f, stop))
}

func TestScopedSyncErrors(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	f.addErr = errors.New("route: writing to routing socket: File exists")
	expectCmds(t, sync1(t, f, stop), addEn0)
	if added()[scopedKey{"en0", false}] != "192.168.1.1" {
		t.Fatal(`"File exists" means the route is there: it must be tracked`)
	}

	f2, stop2 := fakeScoped(t)
	f2.set(primary("en0", 11, "192.168.1.1"), primary("en5", 17, "192.168.3.1"))
	f2.addErr = errors.New("route: not permitted")
	if err := syncScoped(stop2); err == nil || !strings.Contains(err.Error(), "not permitted") {
		t.Fatalf("syncScoped = %v, want the add's error", err)
	}
	if len(f2.takeCmds()) != 2 || len(added()) != 0 {
		t.Fatalf("a failed add is tracked: %v", added())
	}

	f2.err = errors.New("sysctl")
	if err := syncScoped(stop2); err == nil || err.Error() != "sysctl" {
		t.Fatalf("syncScoped = %v, want the table's error", err)
	}

	// Capture went off between reading the table and taking the lock: nothing is changed.
	f2.err, f2.addErr = nil, nil
	if err := syncScoped(make(chan struct{})); err != nil || len(f2.takeCmds()) != 0 {
		t.Fatal("a sync for a capture that ended changed routes")
	}
}

func TestScopedSyncStartsAndStops(t *testing.T) {
	f, _ := fakeScoped(t)
	scoped.mu.Lock()
	scoped.stop, scoped.added = nil, nil
	scoped.mu.Unlock()
	old := scopedEvery
	scopedEvery = time.Millisecond
	t.Cleanup(func() { scopedEvery = old })

	f.set(primary("en0", 11, "192.168.1.1"))
	if err := startScopedSync(); err != nil {
		t.Fatal(err)
	}
	expectCmds(t, f.takeCmds(), addEn0)

	// The ticker keeps the route in place: unplugged, then back.
	f.set()
	time.Sleep(20 * time.Millisecond)
	f.set(primary("en0", 11, "192.168.1.1"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		if cmds := f.takeCmds(); slices.Contains(cmds, addEn0) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the periodic sync never re-added the route")
		}
		time.Sleep(time.Millisecond)
	}
	// A failing periodic sync is logged and retried, not fatal.
	f.mu.Lock()
	f.err = errors.New("sysctl")
	f.mu.Unlock()
	time.Sleep(10 * time.Millisecond)
	f.mu.Lock()
	f.err = nil
	f.routes = []nics.DefaultRoute{primary("en0", 11, "192.168.1.1"), ourScoped("en0", 11, "192.168.1.1")}
	f.mu.Unlock()

	stopScopedSync()
	cmds := f.takeCmds()
	if !slices.Contains(cmds, delEn0) {
		t.Fatalf("stopping must delete our route on the primary adapter, got %q", cmds)
	}
	scoped.mu.Lock()
	stopped := scoped.stop == nil && scoped.added == nil
	scoped.mu.Unlock()
	if !stopped {
		t.Fatal("the sync is still marked running")
	}
}

func TestStartScopedSyncFailsWhenTheTableCantBeRead(t *testing.T) {
	f, _ := fakeScoped(t)
	f.err = errors.New("sysctl")
	err := startScopedSync()
	if err == nil || !strings.Contains(err.Error(), "scoped routes: sysctl") {
		t.Fatalf("startScopedSync = %v", err)
	}
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	if scoped.stop != nil {
		t.Fatal("a failed start left the sync running")
	}
}

// Off with an unreadable table still removes every route it added (it cannot tell which adapters
// are still primary).
func TestStopScopedSyncWithoutATable(t *testing.T) {
	f, stop := fakeScoped(t)
	f.set(primary("en0", 11, "192.168.1.1"))
	expectCmds(t, sync1(t, f, stop), addEn0)
	f.err = errors.New("sysctl")
	stopScopedSync()
	expectCmds(t, f.takeCmds(), delEn0)
}
