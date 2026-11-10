package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/nics"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/routemark"
)

type fakeHandler struct{ limits map[string]float64 }

func (fakeHandler) Status(context.Context) (api.Status, error) {
	return api.Status{State: api.StateOff, Reason: "after a crash", Version: "t"}, nil
}
func (fakeHandler) Enable(context.Context) (api.Status, error) {
	return api.Status{}, api.Errorf(api.CodeVPNActive, "Another VPN (utun4) is routing all IPv4 traffic.")
}
func (fakeHandler) Disable(context.Context, api.DisableParams) (api.Status, error) {
	return api.Status{State: api.StateOff, Version: "t"}, nil
}
func (fakeHandler) Links(context.Context) (api.LinksResult, error) {
	return api.LinksResult{Links: []api.Link{{Name: "en0", Index: 4, IPv4: "192.0.2.2", Up: true, State: api.LinkUp, LimitMbps: 20}}}, nil
}
func (fakeHandler) Stats(context.Context) (api.Stats, error) {
	return api.Stats{At: time.Now(), Links: []api.LinkStats{{Name: "en0", RxBps: 1e6, TxBps: 1e5, ActiveFlows: 3, TotalFlows: 7, Weight: 1}}}, nil
}
func (h fakeHandler) SetLimit(_ context.Context, p api.SetLimitParams) (api.SetLimitResult, error) {
	h.limits[p.Link] = p.Mbps
	return api.SetLimitResult(p), nil
}
func (h fakeHandler) SetAutoResume(_ context.Context, p api.SetAutoResumeParams) (api.Status, error) {
	h.limits["auto-resume"] = map[bool]float64{false: 0, true: 1}[p.Enabled] // recorded beside the caps
	return api.Status{State: api.StateOff, Version: "t", AutoResume: p.Enabled}, nil
}
func (fakeHandler) Events(context.Context) (api.EventsResult, error) {
	return api.EventsResult{Events: []api.LinkEvent{
		{At: time.Date(2026, 11, 10, 9, 41, 7, 0, time.Local), Link: "en0", From: api.LinkUp, To: api.LinkDown, Reason: api.EventProbeFailed},
	}}, nil
}

// serve starts the control API on a short temp socket path (sun_path is 104 bytes on macOS).
func serve(t *testing.T, h api.Handler) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "mld")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "s")
	srv, err := api.Listen(path, 0o600, func(uint32) bool { return true }, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	return path
}

func run(cmd string, args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := dispatch(cmd, args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestVersionAndUsage(t *testing.T) {
	if code, out, _ := run("version"); code != 0 || out != "mergelane-daemon dev\n" {
		t.Fatalf("version = %d %q", code, out)
	}
	if code, _, errOut := run("bogus"); code != 2 || !strings.Contains(errOut, "mergelane-daemon: merges") {
		t.Fatalf("unknown command = %d %q", code, errOut)
	}
}

func TestClientCommandsTalkToTheDaemon(t *testing.T) {
	h := fakeHandler{limits: map[string]float64{}}
	sock := serve(t, h)
	cases := []struct {
		cmd  string
		args []string
		code int
		want string
	}{
		{"status", nil, 0, "system merge: off (daemon t, protocol 1)\nreason: after a crash\n"},
		{"off", nil, 0, "system merge: off (daemon t, protocol 1)\n"},
		{"on", nil, 1, "VPN_ACTIVE"},
		{"links", nil, 0, "en0      index 4   up       up=true  v4 192.0.2.2       v6   limit 20 Mbit/s\n"},
		{"stats", nil, 0, "merged down     8.0 up    0.8 Mbit/s"},
		{"limit", []string{"en0", "unlimited"}, 0, "en0: unlimited\n"},
		{"limit", []string{"en5", "25"}, 0, "en5: 25 Mbit/s\n"},
		{"limit", []string{"en5", "fast"}, 1, ""},
		{"limit", []string{"en5"}, 1, "usage: mergelane-daemon limit"},
		{"events", nil, 0, "2026-11-10 09:41:07  en0      up      -> down     probe-failed\n"},
		{"auto-resume", []string{"on"}, 0, "system merge: off (daemon t, protocol 1)\nauto-resume after a crash: on\n"},
		{"auto-resume", []string{"off"}, 0, "system merge: off (daemon t, protocol 1)\n"},
		{"auto-resume", nil, 1, "usage: mergelane-daemon auto-resume on|off"},
		{"auto-resume", []string{"maybe"}, 1, "usage: mergelane-daemon auto-resume on|off"},
		{"auto-resume", []string{"on", "now"}, 1, "usage: mergelane-daemon auto-resume on|off"},
	}
	for _, c := range cases {
		code, out, errOut := run(c.cmd, append([]string{"-socket", sock}, c.args...)...)
		if code != c.code || !strings.Contains(out+errOut, c.want) {
			t.Errorf("%s %v = %d, out %q, err %q; want %d containing %q", c.cmd, c.args, code, out, errOut, c.code, c.want)
		}
	}
	if h.limits["en5"] != 25 {
		t.Fatalf("limit not applied: %v", h.limits)
	}
	if v, ok := h.limits["auto-resume"]; !ok || v != 0 {
		t.Fatalf("auto-resume not sent: %v", h.limits)
	}
}

func TestFormatEventsWithoutEvents(t *testing.T) {
	if got := formatEvents(nil); got != "No link changes since the daemon started.\n" {
		t.Fatalf("formatEvents(nil) = %q", got)
	}
}

func TestClientWithoutADaemon(t *testing.T) {
	code, _, errOut := run("status", "-socket", "/tmp/mergelane-no-such-socket")
	if code != 1 || !strings.Contains(errOut, "isn't running or isn't reachable") {
		t.Fatalf("status = %d %q", code, errOut)
	}
	if code, _, _ := run("status", "-nope"); code != 1 {
		t.Fatal("a bad flag must fail")
	}
}

func TestRootCommandsRefuseOtherUsers(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root")
	}
	for _, cmd := range []string{"run", "cleanup", "install", "uninstall"} {
		if code, _, errOut := run(cmd, "-uid", "501"); code != 1 || errOut == "" {
			if cmd == "run" || cmd == "uninstall" || cmd == "cleanup" {
				code, _, errOut = run(cmd)
			}
			if code != 1 || errOut == "" {
				t.Errorf("%s as a normal user = %d %q", cmd, code, errOut)
			}
		}
	}
	if code, _, _ := run("run", "-nope"); code != 1 {
		t.Fatal("run with a bad flag must fail")
	}
	if code, _, _ := run("install", "-nope"); code != 1 {
		t.Fatal("install with a bad flag must fail")
	}
}

func TestListShowsLinks(t *testing.T) {
	code, out, errOut := run("list", "-include", "lo0")
	if code != 0 || out == "" {
		t.Fatalf("list = %d %q %q", code, out, errOut)
	}
	if code, _, _ := run("list", "-nope"); code != 1 {
		t.Fatal("list with a bad flag must fail")
	}
}

func TestWeightFlags(t *testing.T) {
	w := weightFlags{}
	if err := w.Set("en0=3"); err != nil || w["en0"] != 3 || w.String() != "" {
		t.Fatalf("Set = %v, %v", err, w)
	}
	for _, bad := range []string{"en0", "=3", "en0=x", "en0=0"} {
		if w.Set(bad) == nil {
			t.Errorf("Set(%q) must fail", bad)
		}
	}
}

func TestHelpers(t *testing.T) {
	if got := splitList(" en0, ,en5 ,"); strings.Join(got, "|") != "en0|en5" {
		t.Fatalf("splitList = %v", got)
	}
	n := nics.Nic{Name: "en0", IP: net.ParseIP("192.0.2.2"), IP6: net.ParseIP("2001:db8::2")}
	if got := describeNic(n); got != "en0  v4 192.0.2.2  v6 2001:db8::2" {
		t.Fatalf("describeNic = %q", got)
	}
	if limitPhrase(0) != "unlimited" || limitPhrase(12.5) != "12.5 Mbit/s" {
		t.Fatal("limitPhrase")
	}
	a := authorizer(501)
	if !a(0) || !a(501) || a(502) || authorizer(0)(501) {
		t.Fatal("authorizer must allow only root and the installing user")
	}
}

func TestCountLeftovers(t *testing.T) {
	if countLeftovers(func() ([]rib.Route, error) { return nil, errors.New("no rib") }) != 0 {
		t.Fatal("an unreadable table counts as clean")
	}
	ours := routemark.Capture(netip.MustParsePrefix("0.0.0.0/1"), "utun7")
	ours.Flags |= rib.FlagProto2 | rib.FlagStatic
	theirs := rib.Route{Dst: netip.MustParsePrefix("128.0.0.0/1"), Iface: "utun4", Flags: rib.FlagStatic}
	if got := countLeftovers(func() ([]rib.Route, error) { return []rib.Route{ours, theirs}, nil }); got != 1 {
		t.Fatalf("leftovers = %d, want 1 (only the marked route)", got)
	}
}

func TestGuardMessages(t *testing.T) {
	vpn := []rib.Route{{Dst: netip.MustParsePrefix("0.0.0.0/1"), Iface: "utun4", Flags: rib.FlagStatic}}
	noNC := func(context.Context) ([]string, error) { return nil, nil }
	g := guardMessages(func() ([]rib.Route, error) { return vpn, nil }, noNC)
	msgs, err := g(context.Background(), func(string) bool { return false })
	if err != nil || len(msgs) != 1 || !strings.Contains(msgs[0], "utun4") {
		t.Fatalf("guard = %v, %v", msgs, err)
	}
	if msgs, _ := g(context.Background(), func(i string) bool { return i == "utun4" }); len(msgs) != 0 {
		t.Fatalf("our own utun is not a conflict: %v", msgs)
	}
	bad := guardMessages(func() ([]rib.Route, error) { return nil, errors.New("rib") }, noNC)
	if _, err := bad(context.Background(), nil); err == nil {
		t.Fatal("a route read failure must be reported")
	}
	badNC := guardMessages(func() ([]rib.Route, error) { return nil, nil },
		func(context.Context) ([]string, error) { return nil, errors.New("scutil") })
	if _, err := badNC(context.Background(), nil); err == nil {
		t.Fatal("a scutil failure must be reported")
	}
}
