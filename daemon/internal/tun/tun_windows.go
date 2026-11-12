package tun

// Windows: a Wintun adapter, its capture routes and their cleanup, re-imported from Net Merge
// (github.com/rohit267/net-merge, internal/tun/tun_windows.go at 2b333a3, MIT, docs/UPSTREAM.md) in
// milestone W5 (ADR-0059). Changes: Mergelane's adapter type and GUID, the tools run by their full
// System32 path, the strong-host record kept in the daemon's state folder (so `cleanup`, run by an
// administrator, finds what the service wrote), and the pure parts split out so the kit can test them.

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	wun "golang.zx2c4.com/wireguard/tun"

	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
)

const openHint = "needs administrator rights and wintun.dll next to mergelane-daemon.exe"

// adapterGUID is the Wintun adapter's fixed GUID: it keeps one Windows network profile instead of a
// new "Unidentified network" each time the adapter is made. Mergelane's own, not Net Merge's.
const adapterGUID = "{99bf0b1f-d39d-424b-9be5-78005a42be1e}"

// routes4win are routes4 as `route` wants them: destination and mask ("0.0.0.0", "128.0.0.0").
var routes4win = func() (out [][2]string) {
	for _, r := range routes4 {
		p := netip.MustParsePrefix(r)
		out = append(out, [2]string{p.Addr().String(), net.IP(net.CIDRMask(p.Bits(), 32)).String()})
	}
	return out
}()

func init() {
	staleHook = restoreStrongHost
	wun.WintunTunnelType = "Mergelane"
	if g, err := windows.GUIDFromString(adapterGUID); err == nil {
		wun.WintunStaticRequestedGUID = &g
	}
}

// configure gives the new adapter its addresses, MTU and routes, and returns its index.
func configure(name string, mtu int, ip4 netip.Prefix) (int, error) {
	ifc, err := waitIface(name, 5*time.Second)
	if err != nil {
		return 0, err
	}
	idx := strconv.Itoa(ifc.Index)
	addr, mask := ip4.Addr().String(), net.IP(net.CIDRMask(ip4.Bits(), 32)).String()
	// By index: netsh can know the adapter a moment before it knows its name.
	setAddr := func() error {
		return run("netsh", "interface", "ipv4", "set", "address", "name="+idx, "source=static",
			"address="+addr, "mask="+mask, "store=active")
	}
	err = setAddr()
	// Windows now and then refuses or drops an address set the moment the adapter appears, and
	// without it nothing routed into the adapter can be sent (all traffic dies), so make sure it stuck.
	for try := 1; !hasAddr(ifc, addr); try++ {
		if try > 20 {
			if err == nil {
				err = fmt.Errorf("adapter %q did not keep its address %s", name, addr)
			}
			return ifc.Index, err
		}
		if try%4 == 0 {
			err = setAddr()
		}
		time.Sleep(250 * time.Millisecond)
	}
	// Before the capture routes: our pinned sockets must keep working the moment they exist.
	startStrongHost(ifc.Index)
	// Windows gives Wintun adapters an MTU of 65535. Match the stack's MTU, so Windows sizes TCP
	// segments to it and fragments bigger UDP datagrams instead of sending packets the stack drops.
	mtuArg := "mtu=" + strconv.Itoa(mtu)
	if e := run("netsh", "interface", "ipv4", "set", "subinterface", "interface="+idx, mtuArg, "store=active"); e != nil {
		logx.Printf("warning: could not set IPv4 MTU: %v\n", e)
	}
	// `route add` without -p: the routes last only until the next restart, whatever happens to us.
	for _, dst := range routes4win {
		if err = run("route", "add", dst[0], "mask", dst[1], "0.0.0.0", "metric", "1", "if", idx); err != nil {
			return ifc.Index, err
		}
	}
	// IPv6 is best-effort: if it can't be set up, IPv4 still works and IPv6 stays on its normal path.
	if e := run("netsh", "interface", "ipv6", "add", "address", "interface="+idx, "address="+tunIP6+"/64", "store=active"); e != nil {
		logx.Printf("warning: IPv6 not captured: %v\n", e)
	} else {
		if e := run("netsh", "interface", "ipv6", "set", "subinterface", "interface="+idx, mtuArg, "store=active"); e != nil {
			logx.Printf("warning: could not set IPv6 MTU: %v\n", e)
		}
		for _, p := range routes6 {
			if e := run("netsh", "interface", "ipv6", "add", "route", "prefix="+p, "interface="+idx, "metric=1", "store=active"); e != nil {
				logx.Printf("warning: IPv6 route %s: %v\n", p, e)
			}
		}
	}
	return ifc.Index, nil
}

func delRoutes(idx int) {
	defer stopStrongHost()
	for _, dst := range routes4win {
		run("route", "delete", dst[0], "mask", dst[1], "0.0.0.0", "if", strconv.Itoa(idx))
	}
	for _, p := range routes6 {
		run("netsh", "interface", "ipv6", "delete", "route", "prefix="+p, "interface="+strconv.Itoa(idx), "store=active")
	}
}

// run runs a Windows tool by its full path in System32 (systemTool), so the service never finds one
// through PATH, with no console window.
func run(name string, args ...string) error {
	cmd := exec.Command(systemTool(name), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return cmdError(name, args, err, out)
	}
	return nil
}

// systemTool is name's path in the System32 folder (route.exe, netsh.exe), or name itself when
// Windows can't say where that is.
func systemTool(name string) string {
	dir, err := windows.GetSystemDirectory()
	if err != nil || dir == "" {
		return name
	}
	return filepath.Join(dir, name+".exe")
}

func waitIface(name string, d time.Duration) (*net.Interface, error) {
	deadline := time.Now().Add(d)
	for {
		ifc, err := net.InterfaceByName(name)
		if err == nil {
			return ifc, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("adapter %q did not appear: %w", name, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func hasAddr(ifc *net.Interface, ip string) bool {
	addrs, _ := ifc.Addrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.String() == ip {
			return true
		}
	}
	return false
}

// On an adapter with weak host send or forwarding turned on (Mobile Hotspot, Internet Connection
// Sharing, Hyper-V and some VPNs do that), Windows ignores a socket's bound address and
// IP_UNICAST_IF and routes by destination only, so once the capture routes exist our own pinned
// flows go back into the TUN: every adapter shows "no internet" and all traffic stops. While
// capture is on, both are turned off on the adapters we use, and put back on off, on the next
// start after a crash, or by `cleanup` (the file below remembers them).
var strongHost struct {
	mu      sync.Mutex
	checked map[int]bool
	restore []string // "family index weakhostsend=X forwarding=Y", to put back
	stop    chan struct{}
}

// strongHostFile is in the daemon's state folder (state.DefaultDir), which only SYSTEM and
// administrators may write: the service and an administrator's `cleanup` see the same file.
func strongHostFile() string { return filepath.Join(state.DefaultDir(), "weakhost.txt") }

func startStrongHost(tunIdx int) {
	stop := make(chan struct{})
	strongHost.mu.Lock()
	strongHost.checked, strongHost.restore, strongHost.stop = map[int]bool{tunIdx: true}, nil, stop
	strongHost.mu.Unlock()
	syncStrongHost(stop)
	go func() {
		t := time.NewTicker(5 * time.Second) // a tether plugged in later
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				syncStrongHost(stop)
			}
		}
	}()
}

func syncStrongHost(stop chan struct{}) {
	found, _ := nics.DiscoverNics(nil, nil)
	strongHost.mu.Lock()
	defer strongHost.mu.Unlock()
	if strongHost.stop != stop {
		return // capture was switched off meanwhile
	}
	var idx []string
	for _, n := range found {
		if !strongHost.checked[n.Index] {
			strongHost.checked[n.Index] = true
			idx = append(idx, strconv.Itoa(n.Index))
		}
	}
	if len(idx) == 0 {
		return
	}
	// Get-NetIPInterface prints enum names, which unlike netsh's output are not translated.
	// HideWindow: without it, every new adapter flashes a PowerShell console.
	ps := exec.Command(filepath.Join(filepath.Dir(systemTool("cmd")), `WindowsPowerShell\v1.0\powershell.exe`),
		"-NoProfile", "-NonInteractive", "-Command", weakHostQuery(idx))
	ps.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := ps.Output()
	if err != nil {
		logx.Printf("warning: could not check the adapters' weak host setting: %v\n", err)
		return
	}
	for _, f := range parseWeakHost(string(out)) {
		if err := run("netsh", "interface", f.family, "set", "interface", "interface="+f.index,
			"weakhostsend=disabled", "forwarding=disabled", "store=active"); err != nil {
			logx.Printf("warning: %v\n", err)
			continue
		}
		strongHost.restore = append(strongHost.restore, f.restoreLine())
		logx.Printf("note: turned off weak host send and forwarding on adapter %s (%s) while merging; "+
			"Windows ignores pinned connections there. Sharing its connection (Mobile Hotspot) pauses until system merge is off.\n",
			f.index, f.family)
	}
	if err := os.WriteFile(strongHostFile(), []byte(strings.Join(strongHost.restore, "\n")), 0o600); err != nil {
		logx.Printf("warning: could not record the adapters to put back: %v\n", err)
	}
}

func stopStrongHost() {
	strongHost.mu.Lock()
	defer strongHost.mu.Unlock()
	if strongHost.stop != nil {
		close(strongHost.stop)
		strongHost.stop = nil
	}
	putBack(strongHost.restore)
	strongHost.restore = nil
	os.Remove(strongHostFile())
}

// restoreStrongHost puts back what a crashed run turned off.
func restoreStrongHost() {
	b, err := os.ReadFile(strongHostFile())
	if err != nil {
		return
	}
	putBack(strings.Split(strings.TrimSpace(string(b)), "\n"))
	os.Remove(strongHostFile())
}

func putBack(lines []string) {
	for _, args := range putBackArgs(lines) {
		run("netsh", args...)
	}
}
