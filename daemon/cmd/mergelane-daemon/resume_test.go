package main

import (
	"net/netip"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/control"
	"github.com/ZahidNoor7/mergelane/daemon/internal/rib"
	"github.com/ZahidNoor7/mergelane/daemon/internal/routemark"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
)

// Auto-resume after a crash (the ADR-0007 follow-up), driven through runDaemon with fakes for every
// privileged step and the real control socket.

func savePrefs(t *testing.T, h *harness, p state.Prefs) {
	t.Helper()
	if err := state.SavePrefs(h.cfg.stateDir, p); err != nil {
		t.Fatal(err)
	}
}

func loadPrefs(t *testing.T, h *harness) state.Prefs {
	t.Helper()
	p, err := state.LoadPrefs(h.cfg.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// leftoverRoutes is what a run killed while merging was on leaves in the table.
func leftoverRoutes() []rib.Route {
	ours := routemark.Capture(netip.MustParsePrefix("0.0.0.0/1"), "utun7")
	ours.Flags |= rib.FlagProto2 | rib.FlagStatic
	return []rib.Route{ours}
}

// waitStatus polls status until ok accepts it.
func waitStatus(t *testing.T, cl *api.Client, ok func(api.Status) bool) api.Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, err := cl.Status(ctxT(t))
		if err != nil {
			t.Fatal(err)
		}
		if ok(st) {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("status = %+v", st)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func withResumeWait(t *testing.T, d time.Duration) {
	t.Helper()
	old := resumeWait
	resumeWait = d
	t.Cleanup(func() { resumeWait = old }) // runs after the daemon stopped (registered before start)
}

func TestRunDaemonResumesAfterACrashWhenAllowed(t *testing.T) {
	cases := []struct {
		name   string
		routes []rib.Route
		prefs  state.Prefs
		log    string
	}{
		// The wish was not saved (prefs lost, or a daemon from before M2.4 wrote none): routes tell.
		{"killed while on: routes left behind", leftoverRoutes(),
			state.Prefs{AutoResume: true}, "previous run left routes behind"},
		{"died while on: no clean exit, merging wanted", nil,
			state.Prefs{AutoResume: true, WantOn: true}, "previous run stopped unexpectedly while merging was wanted on"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.routes = tc.routes
			savePrefs(t, h, tc.prefs)
			errc := h.start(t)
			cl := h.dial(t)
			st := waitStatus(t, cl, func(st api.Status) bool { return st.State == api.StateOn })
			if st.Reason != control.ReasonResumed || !st.AutoResume {
				t.Fatalf("status = %+v, want on with %q", st, control.ReasonResumed)
			}
			h.shutdown(t, errc)
			if !slices.Contains(h.ev.get(), "on") {
				t.Fatalf("events = %q: the routes were never added", h.ev.get())
			}
			logs := h.logs.String()
			for _, want := range []string{tc.log, "auto-resume is on", "merging turned back on after the restart"} {
				if !strings.Contains(logs, want) {
					t.Errorf("logs %q lack %q", logs, want)
				}
			}
			// A clean stop now, and merging on means the wish is on.
			if p := loadPrefs(t, h); p != (state.Prefs{AutoResume: true, WantOn: true, CleanExit: true}) {
				t.Fatalf("prefs after shutdown = %+v", p)
			}
		})
	}
}

func TestRunDaemonStaysOffWithoutACrash(t *testing.T) {
	cases := []struct {
		name   string
		routes []rib.Route
		prefs  state.Prefs
		reason string
	}{
		// A clean stop can leave a marked route on purpose (#20); it is cleaned up, but no crash.
		{"a clean stop that left a route behind", leftoverRoutes(), state.Prefs{AutoResume: true, WantOn: true, CleanExit: true}, ""},
		// After a reboot or a helper update the previous run stopped cleanly: ADR-0007's rule holds.
		{"a clean stop while merging was on", nil, state.Prefs{AutoResume: true, WantOn: true, CleanExit: true}, ""},
		// Merging was off when the run died, as the user wanted: nothing to bring back.
		{"died while the user had merging off", nil, state.Prefs{AutoResume: true, CleanExit: false}, ""},
		// A crash, but the user did not allow auto-resume.
		{"a crash without auto-resume", nil, state.Prefs{WantOn: true}, control.ReasonCrash},
		{"killed while on, without auto-resume", leftoverRoutes(), state.Prefs{WantOn: true}, control.ReasonCrash},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.routes = tc.routes
			savePrefs(t, h, tc.prefs)
			errc := h.start(t)
			cl := h.dial(t)
			time.Sleep(20 * time.Millisecond) // a resume, if one started, has links up at once
			st, err := cl.Status(ctxT(t))
			if err != nil || st.State != api.StateOff || st.Reason != tc.reason || st.AutoResume != tc.prefs.AutoResume {
				t.Fatalf("status = %+v, %v; want off with %q", st, err, tc.reason)
			}
			h.shutdown(t, errc)
			assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
			if strings.Contains(h.logs.String(), "auto-resume") {
				t.Errorf("logs %q mention auto-resume", h.logs.String())
			}
		})
	}
}

func TestRunDaemonAutoResumeSaysWhyItStayedOff(t *testing.T) {
	t.Run("another VPN is active", func(t *testing.T) {
		h := newHarness(t)
		h.conflicts = []string{"Another VPN (utun4) is routing all IPv4 traffic."}
		savePrefs(t, h, state.Prefs{AutoResume: true, WantOn: true})
		errc := h.start(t)
		want := control.NotResumed("Another VPN (utun4) is routing all IPv4 traffic.")
		waitStatus(t, h.dial(t), func(st api.Status) bool { return st.Reason == want && st.State == api.StateOff })
		h.shutdown(t, errc)
		if !strings.Contains(h.logs.String(), "auto-resume: "+want) {
			t.Errorf("logs %q lack the reason", h.logs.String())
		}
		// The user's wish is still to be on: a refusal is not their choice.
		if p := loadPrefs(t, h); !p.WantOn || !p.CleanExit {
			t.Fatalf("prefs = %+v", p)
		}
	})
	t.Run("no link passes its probe in time", func(t *testing.T) {
		withResumeWait(t, 30*time.Millisecond)
		h := newHarness(t)
		h.linkState = "checking"
		savePrefs(t, h, state.Prefs{AutoResume: true, WantOn: true})
		errc := h.start(t)
		want := control.NotResumed(control.ReasonNoLinks)
		waitStatus(t, h.dial(t), func(st api.Status) bool { return st.Reason == want })
		h.shutdown(t, errc)
		assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
	})
}

func TestRunDaemonStopsWhileAutoResumeWaits(t *testing.T) {
	withResumeWait(t, time.Hour)
	h := newHarness(t)
	h.linkState = "checking"
	savePrefs(t, h, state.Prefs{AutoResume: true, WantOn: true})
	errc := h.start(t)
	waitStatus(t, h.dial(t), func(st api.Status) bool { return st.Reason == control.ReasonResuming })
	h.shutdown(t, errc) // fails if runDaemon waits out the hour
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
	if logs := h.logs.String(); strings.Contains(logs, "auto-resume: ") {
		t.Errorf("a stop is not a failed resume: logs %q", logs)
	}
	if p := loadPrefs(t, h); !p.CleanExit || !p.WantOn {
		t.Fatalf("prefs = %+v", p)
	}
}

func TestRunDaemonKeepsPrefs(t *testing.T) {
	h := newHarness(t)
	errc := h.start(t)
	// Running: the exit is not clean until the daemon stops.
	if p := loadPrefs(t, h); p != state.DefaultPrefs() {
		t.Fatalf("prefs while running = %+v, want the defaults (and the file written)", p)
	}
	if _, err := os.Stat(state.PrefsPath(h.cfg.stateDir)); err != nil {
		t.Fatalf("the start did not record that the daemon runs: %v", err)
	}
	cl := h.dial(t)
	st, err := cl.SetAutoResume(ctxT(t), true)
	if err != nil || !st.AutoResume || st.Protocol != api.ProtocolVersion {
		t.Fatalf("setAutoResume = %+v, %v", st, err)
	}
	if p := loadPrefs(t, h); !p.AutoResume {
		t.Fatalf("prefs = %+v, want auto-resume saved", p)
	}
	if _, err := cl.Enable(ctxT(t)); err != nil {
		t.Fatal(err)
	}
	if p := loadPrefs(t, h); !p.WantOn {
		t.Fatalf("prefs = %+v, want the wish to be on saved", p)
	}
	// The CLI drives the same method.
	code, out, errOut := run("auto-resume", "-socket", h.cfg.socketPath, "off")
	if code != 0 || out != "system merge: on (daemon dev, protocol 1)\neach site kept on one network: on\n" {
		t.Fatalf("auto-resume off = %d %q %q", code, out, errOut)
	}
	// Sticky sites, from the CLI too: saved, and shown in the status.
	code, out, errOut = run("sticky-sites", "-socket", h.cfg.socketPath, "off")
	if code != 0 || out != "system merge: on (daemon dev, protocol 1)\n" {
		t.Fatalf("sticky-sites off = %d %q %q", code, out, errOut)
	}
	if p := loadPrefs(t, h); p.StickySites {
		t.Fatalf("prefs = %+v, want sticky sites off saved", p)
	}
	if code, _, errOut := run("sticky-sites", "-socket", h.cfg.socketPath, "maybe"); code == 0 || !strings.Contains(errOut, "sticky-sites on|off") {
		t.Fatalf("sticky-sites maybe = %d %q", code, errOut)
	}
	if code, out, _ := run("sticky-sites", "-socket", h.cfg.socketPath, "on"); code != 0 || !strings.Contains(out, "each site kept on one network: on") {
		t.Fatalf("sticky-sites on = %d %q", code, out)
	}
	if _, err := cl.Disable(ctxT(t), ""); err != nil {
		t.Fatal(err)
	}
	h.shutdown(t, errc)
	if p := loadPrefs(t, h); p != (state.Prefs{CleanExit: true, StickySites: true}) {
		t.Fatalf("prefs after shutdown = %+v", p)
	}
}

func TestRunDaemonRewritesBrokenPrefs(t *testing.T) {
	h := newHarness(t)
	if err := state.Prepare(h.cfg.stateDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.PrefsPath(h.cfg.stateDir), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	errc := h.start(t)
	if st, err := h.dial(t).Status(ctxT(t)); err != nil || st.Reason != "" || st.AutoResume || !st.StickySites {
		t.Fatalf("status = %+v, %v; a broken file means the defaults", st, err)
	}
	h.shutdown(t, errc)
	if !strings.Contains(h.logs.String(), "prefs.json") {
		t.Errorf("logs %q lack the warning", h.logs.String())
	}
	if p := loadPrefs(t, h); p != (state.Prefs{CleanExit: true, StickySites: true}) {
		t.Fatalf("prefs = %+v, want a fresh file", p)
	}
}

func TestRunDaemonRunsWhenPrefsCantBeSaved(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(state.PrefsPath(h.cfg.stateDir)+".tmp", 0o755); err != nil { // blocks every write
		t.Fatal(err)
	}
	errc := h.start(t)
	cl := h.dial(t)
	if st, err := cl.Enable(ctxT(t)); err != nil || st.State != api.StateOn {
		t.Fatalf("enable = %+v, %v; merging must work without prefs", st, err)
	}
	_, err := cl.SetAutoResume(ctxT(t), true)
	if e := api.AsError(err); e == nil || e.Code != api.CodeInternal {
		t.Fatalf("setAutoResume = %v, want INTERNAL", err)
	}
	h.shutdown(t, errc)
	if n := strings.Count(h.logs.String(), "warning: saving prefs"); n < 3 { // start, the wish, stop
		t.Errorf("%d warnings in logs %q", n, h.logs.String())
	}
}

func TestRunDaemonReportsItsBuildVersion(t *testing.T) {
	old := version
	version = "1.4.2" // what -X main.version stamps at build time
	t.Cleanup(func() { version = old })
	h := newHarness(t)
	errc := h.start(t)
	st, err := h.dial(t).Status(ctxT(t))
	if err != nil || st.Version != "1.4.2" || st.Protocol != api.ProtocolVersion {
		t.Fatalf("status = %+v, %v", st, err)
	}
	h.shutdown(t, errc)
	if !strings.Contains(h.logs.String(), "mergelane-daemon 1.4.2 listening") {
		t.Errorf("logs %q", h.logs.String())
	}
}

func TestRunDaemonServesLinkEvents(t *testing.T) {
	h := newHarness(t)
	errc := h.start(t)
	res, err := h.dial(t).Events(ctxT(t))
	want := api.LinkEvent{At: fakeEventAt, Link: "en0", From: api.LinkGone, To: api.LinkUnknown, Reason: api.EventFound}
	if err != nil || len(res.Events) != 1 || !res.Events[0].At.Equal(want.At) || res.Events[0].Link != want.Link ||
		res.Events[0].From != want.From || res.Events[0].To != want.To || res.Events[0].Reason != want.Reason {
		t.Fatalf("events = %+v, %v; want [%+v]", res, err, want)
	}
	code, out, _ := run("events", "-socket", h.cfg.socketPath)
	if code != 0 || !strings.Contains(out, "en0      gone    -> unknown  found") {
		t.Fatalf("events CLI = %d %q", code, out)
	}
	h.shutdown(t, errc)
}
