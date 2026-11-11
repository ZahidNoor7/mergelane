package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
)

func init() { resumePoll = time.Millisecond }

// prefsRec records every SavePrefs call; err, when set, makes them fail.
type prefsRec struct {
	mu    sync.Mutex
	saved []Prefs
	err   error
}

func (r *prefsRec) save(p Prefs) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.saved = append(r.saved, p)
	return nil
}

func (r *prefsRec) get() []Prefs {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Prefs(nil), r.saved...)
}

// newResumer is newController after a crash, with saved prefs and a recorder for them.
func newResumer(t *testing.T, prefs Prefs) (*Controller, *fakeTunnel, *fakeEngine, *fakeGuard, *prefsRec) {
	t.Helper()
	c, tun, eng, g, _ := newController(t)
	rec := &prefsRec{}
	c.cfg.SavePrefs = rec.save
	c.prefs = prefs
	c.reason = ReasonCrash
	return c, tun, eng, g, rec
}

func statusOf(t *testing.T, c *Controller) api.Status {
	t.Helper()
	st, err := c.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestStatusReportsTheAutoResumeSetting(t *testing.T) {
	c := New(Config{Version: "v", Tunnel: &fakeTunnel{}, Engine: &fakeEngine{}, Prefs: Prefs{AutoResume: true}})
	if st := statusOf(t, c); !st.AutoResume || st.State != api.StateOff {
		t.Fatalf("status = %+v, want autoResume on", st)
	}
}

func TestSetAutoResumeSavesTheSetting(t *testing.T) {
	c, _, _, _, rec := newResumer(t, Prefs{WantOn: true})
	st, err := c.SetAutoResume(context.Background(), api.SetAutoResumeParams{Enabled: true})
	if err != nil || !st.AutoResume || st.State != api.StateOff || st.Reason != ReasonCrash {
		t.Fatalf("setAutoResume = %+v, %v", st, err)
	}
	// The wish to be on is saved along with it, unchanged.
	if got := rec.get(); len(got) != 1 || got[0] != (Prefs{AutoResume: true, WantOn: true}) {
		t.Fatalf("saved %+v", got)
	}
	// Setting it to what it already is writes nothing.
	if _, err := c.SetAutoResume(context.Background(), api.SetAutoResumeParams{Enabled: true}); err != nil || len(rec.get()) != 1 {
		t.Fatalf("a no-op change saved again: %+v, %v", rec.get(), err)
	}

	rec.err = errors.New("disk full")
	st, err = c.SetAutoResume(context.Background(), api.SetAutoResumeParams{Enabled: false})
	if code(t, err) != api.CodeInternal || !strings.Contains(err.Error(), "disk full") || !st.AutoResume {
		t.Fatalf("a failed save = %+v, %v; the setting must stay on", st, err)
	}
	if !statusOf(t, c).AutoResume {
		t.Fatal("a setting that could not be saved must not take effect")
	}

	c.cfg.SavePrefs = nil
	if st, err := c.SetAutoResume(context.Background(), api.SetAutoResumeParams{Enabled: false}); err != nil || st.AutoResume {
		t.Fatalf("without a saver: %+v, %v", st, err)
	}
}

func TestEnableAndDisableSaveTheWish(t *testing.T) {
	c, _, _, g, rec := newResumer(t, Prefs{AutoResume: true})
	g.set([]string{"Another VPN is active."}, nil)
	if _, err := c.Enable(context.Background()); code(t, err) != api.CodeVPNActive || len(rec.get()) != 0 {
		t.Fatalf("a refused enable must not save the wish: %v, %+v", err, rec.get())
	}
	g.set(nil, nil)
	if _, err := c.Enable(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.Enable(context.Background()) // already on: nothing to save
	if _, err := c.Disable(context.Background(), api.DisableParams{}); err != nil {
		t.Fatal(err)
	}
	c.Disable(context.Background(), api.DisableParams{}) // already off and unwanted
	want := []Prefs{{AutoResume: true, WantOn: true}, {AutoResume: true, WantOn: false}}
	if got := rec.get(); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("saved %+v, want %+v", got, want)
	}
}

func TestAFailedWishSaveIsLoggedNotFatal(t *testing.T) {
	c, tun, _, _, rec := newResumer(t, Prefs{})
	var mu sync.Mutex
	var logged []string
	c.cfg.Logf = func(format string, a ...any) {
		mu.Lock()
		logged = append(logged, fmt.Sprintf(format, a...))
		mu.Unlock()
	}
	rec.err = errors.New("read-only file system")
	st, err := c.Enable(context.Background())
	if err != nil || st.State != api.StateOn || tun.on != 1 {
		t.Fatalf("enable must succeed although the wish could not be saved: %+v, %v", st, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(logged) != 1 || !strings.Contains(logged[0], "read-only file system") {
		t.Fatalf("logged %q", logged)
	}
}

func TestNewLogsWithLogxByDefault(t *testing.T) {
	c := New(Config{Tunnel: &fakeTunnel{}, Engine: &fakeEngine{}})
	if c.cfg.Logf == nil {
		t.Fatal("no default logger")
	}
}

func TestAVPNTurnOffClearsTheWish(t *testing.T) {
	c, _, _, g, rec := newResumer(t, Prefs{})
	c.Enable(context.Background())
	g.set([]string{"VPN \"Work\" is connected."}, nil)
	if !c.CheckGuard(context.Background()) {
		t.Fatal("the VPN must turn merging off")
	}
	if got := rec.get(); len(got) != 2 || got[1].WantOn {
		t.Fatalf("saved %+v; a VPN turn-off must clear the wish", got)
	}
}

func TestShutdownKeepsTheWishAndRefusesALateEnable(t *testing.T) {
	c, tun, _, _, rec := newResumer(t, Prefs{})
	c.Enable(context.Background())
	c.Shutdown()
	if got := rec.get(); len(got) != 1 || !got[0].WantOn {
		t.Fatalf("saved %+v; stopping the daemon is not the user's choice", got)
	}
	st, err := c.Enable(context.Background())
	if code(t, err) != api.CodeInternal || !strings.Contains(err.Error(), "stopping") || st.State != api.StateOff || tun.on != 1 {
		t.Fatalf("enable after shutdown = %+v, %v (on %d)", st, err, tun.on)
	}
}

func TestResumeTurnsMergingBackOn(t *testing.T) {
	c, tun, _, g, rec := newResumer(t, Prefs{AutoResume: true, WantOn: true})
	if !c.Resume(context.Background(), time.Second) {
		t.Fatal("Resume did not turn merging on")
	}
	st := statusOf(t, c)
	if st.State != api.StateOn || st.Reason != ReasonResumed || tun.on != 1 {
		t.Fatalf("status = %+v, on %d", st, tun.on)
	}
	if len(g.sawOurs) != 1 {
		t.Fatalf("the VPN guard ran %d times, want once", len(g.sawOurs))
	}
	if len(rec.get()) != 0 {
		t.Fatalf("saved %+v; the wish was already on", rec.get())
	}
	// A later user disable clears the resumed reason like any other.
	if st, _ := c.Disable(context.Background(), api.DisableParams{}); st.Reason != "" || st.State != api.StateOff {
		t.Fatalf("disable = %+v", st)
	}
}

// Leftover routes prove merging was on, even when the saved wish says otherwise (a prefs file that
// was lost or written by an older daemon). Once merging is back on, the wish is saved as on.
func TestResumeSavesTheWishWhenItWasNotOn(t *testing.T) {
	c, _, _, _, rec := newResumer(t, Prefs{AutoResume: true})
	if !c.Resume(context.Background(), time.Second) {
		t.Fatal("Resume did not turn merging on")
	}
	if got := rec.get(); len(got) != 1 || got[0] != (Prefs{AutoResume: true, WantOn: true}) {
		t.Fatalf("saved %+v", got)
	}
}

func TestResumeWaitsForALinkToPassItsProbe(t *testing.T) {
	c, tun, eng, _, _ := newResumer(t, Prefs{AutoResume: true, WantOn: true})
	checking := engine.SlotStats{Name: "en0", State: "checking", State6: "-", Present: true}
	eng.setSnap([]engine.SlotStats{checking})
	done := make(chan bool)
	go func() { done <- c.Resume(context.Background(), 10*time.Second) }()

	// While it waits, merging is off and the reason says it will come back.
	deadline := time.Now().Add(5 * time.Second)
	for statusOf(t, c).Reason != ReasonResuming {
		if time.Now().After(deadline) {
			t.Fatalf("status = %+v while waiting", statusOf(t, c))
		}
		time.Sleep(time.Millisecond)
	}
	if st := statusOf(t, c); st.State != api.StateOff {
		t.Fatalf("status = %+v while waiting", st)
	}
	for {
		eng.mu.Lock()
		reads := eng.reads
		eng.mu.Unlock()
		if reads >= 3 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	tun.mu.Lock()
	early := tun.on
	tun.mu.Unlock()
	if early != 0 {
		t.Fatal("merging went on before any link passed its probe")
	}
	eng.setSnap([]engine.SlotStats{checking, {Name: "en7", State: "-", State6: "up", Present: true}})
	if !<-done {
		t.Fatal("Resume gave up although a link came up")
	}
	if st := statusOf(t, c); st.State != api.StateOn || st.Reason != ReasonResumed {
		t.Fatalf("status = %+v", st)
	}
}

func TestResumeStaysOffAndSaysWhy(t *testing.T) {
	cases := []struct {
		name  string
		setup func(tun *fakeTunnel, eng *fakeEngine, g *fakeGuard)
		why   string
	}{
		{"no link passes its probe in time", func(_ *fakeTunnel, eng *fakeEngine, _ *fakeGuard) {
			eng.setSnap([]engine.SlotStats{
				{Name: "en0", State: "checking", State6: "-", Present: true},
				{Name: "en7", State: "up", Present: false},
			})
		}, ReasonNoLinks},
		{"another VPN is active", func(_ *fakeTunnel, _ *fakeEngine, g *fakeGuard) {
			g.set([]string{"Another VPN is active: utun4 carries the default route."}, nil)
		}, "Another VPN is active: utun4 carries the default route."},
		{"the VPN check fails", func(_ *fakeTunnel, _ *fakeEngine, g *fakeGuard) {
			g.set(nil, errors.New("rib unreadable"))
		}, "couldn't check for other VPNs: rib unreadable"},
		{"the routes can't be added", func(tun *fakeTunnel, _ *fakeEngine, _ *fakeGuard) {
			tun.onErr = errors.New("route add failed")
		}, "couldn't turn system merge on: route add failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, tun, eng, g, rec := newResumer(t, Prefs{AutoResume: true, WantOn: true})
			tc.setup(tun, eng, g)
			if c.Resume(context.Background(), 20*time.Millisecond) {
				t.Fatal("Resume turned merging on")
			}
			st := statusOf(t, c)
			if st.State != api.StateOff || st.Reason != NotResumed(tc.why) || tun.on != 0 {
				t.Fatalf("status = %+v, on %d; want off with %q", st, tun.on, NotResumed(tc.why))
			}
			if !strings.HasPrefix(st.Reason, ReasonCrash) {
				t.Fatalf("reason %q must start with the crash", st.Reason)
			}
			if len(rec.get()) != 0 {
				t.Fatalf("saved %+v; a failed resume is not the user's choice", rec.get())
			}
		})
	}
}

func TestResumeDoesNothingWithoutTheSetting(t *testing.T) {
	c, tun, eng, _, _ := newResumer(t, Prefs{WantOn: true})
	if c.Resume(context.Background(), time.Second) {
		t.Fatal("Resume turned merging on with auto-resume off")
	}
	if st := statusOf(t, c); st.State != api.StateOff || st.Reason != ReasonCrash || tun.on != 0 || eng.reads != 0 {
		t.Fatalf("status = %+v, on %d, snapshot read %d times", st, tun.on, eng.reads)
	}
}

// waitingResume starts Resume with no link up yet and returns once it is waiting.
func waitingResume(t *testing.T, ctx context.Context) (*Controller, *fakeTunnel, *fakeEngine, <-chan bool) {
	t.Helper()
	c, tun, eng, _, _ := newResumer(t, Prefs{AutoResume: true, WantOn: true})
	eng.setSnap(nil)
	done := make(chan bool, 1)
	go func() { done <- c.Resume(ctx, 10*time.Second) }()
	deadline := time.Now().Add(5 * time.Second)
	for statusOf(t, c).Reason != ReasonResuming {
		if time.Now().After(deadline) {
			t.Fatal("Resume never started waiting")
		}
		time.Sleep(time.Millisecond)
	}
	return c, tun, eng, done
}

func finish(t *testing.T, done <-chan bool) bool {
	t.Helper()
	select {
	case ok := <-done:
		return ok
	case <-time.After(5 * time.Second):
		t.Fatal("Resume kept waiting")
		return false
	}
}

func TestResumeYieldsToTheUser(t *testing.T) {
	t.Run("the user turns merging off", func(t *testing.T) {
		c, tun, eng, done := waitingResume(t, context.Background())
		c.Disable(context.Background(), api.DisableParams{Reason: "Turned off from the menu bar."})
		eng.setSnap([]engine.SlotStats{upLink})
		if finish(t, done) || tun.on != 0 {
			t.Fatal("Resume undid the user's disable")
		}
		if st := statusOf(t, c); st.State != api.StateOff || st.Reason != "Turned off from the menu bar." {
			t.Fatalf("status = %+v", st)
		}
	})
	t.Run("the user turns merging on", func(t *testing.T) {
		c, tun, eng, done := waitingResume(t, context.Background())
		eng.setSnap([]engine.SlotStats{upLink})
		if _, err := c.Enable(context.Background()); err != nil {
			t.Fatal(err)
		}
		if finish(t, done) || tun.on != 1 {
			t.Fatalf("Resume turned merging on a second time (on %d)", tun.on)
		}
		if st := statusOf(t, c); st.State != api.StateOn || st.Reason != "" {
			t.Fatalf("status = %+v", st)
		}
	})
	t.Run("the user turns auto-resume off", func(t *testing.T) {
		c, tun, eng, done := waitingResume(t, context.Background())
		c.SetAutoResume(context.Background(), api.SetAutoResumeParams{Enabled: false})
		eng.setSnap([]engine.SlotStats{upLink})
		if finish(t, done) || tun.on != 0 {
			t.Fatal("Resume ran with auto-resume turned off")
		}
		if st := statusOf(t, c); st.State != api.StateOff || st.Reason != ReasonCrash {
			t.Fatalf("status = %+v; the crash reason must come back", st)
		}
	})
	t.Run("the daemon stops", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		c, tun, _, done := waitingResume(t, ctx)
		cancel()
		c.Shutdown()
		if finish(t, done) || tun.on != 0 {
			t.Fatal("Resume turned merging on while the daemon stopped")
		}
		if st := statusOf(t, c); st.State != api.StateOff || st.Reason != ReasonCrash {
			t.Fatalf("status = %+v", st)
		}
	})
	t.Run("the daemon is stopping before a link comes up", func(t *testing.T) {
		c, tun, eng, done := waitingResume(t, context.Background())
		c.Shutdown()
		eng.setSnap([]engine.SlotStats{upLink})
		if finish(t, done) || tun.on != 0 {
			t.Fatal("Resume turned merging on after Shutdown")
		}
	})
}

func TestEventsMapTheScheduler(t *testing.T) {
	c, _, eng, _, _ := newController(t)
	at := time.Date(2026, 11, 10, 9, 41, 7, 0, time.UTC)
	eng.events = []engine.LinkEvent{
		{At: at, Link: "en0", From: "up", To: "no internet", Reason: engine.EventProbeFailed},
		{At: at.Add(time.Second), Link: "en0", From: "no internet", To: engine.StateGone, Reason: engine.EventLost},
		{At: at.Add(2 * time.Second), Link: "en0", From: engine.StateGone, To: "checking", Reason: engine.EventReturned},
	}
	res, err := c.Events(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []api.LinkEvent{
		{At: at, Link: "en0", From: api.LinkUp, To: api.LinkDown, Reason: api.EventProbeFailed},
		{At: at.Add(time.Second), Link: "en0", From: api.LinkDown, To: api.LinkGone, Reason: api.EventLost},
		{At: at.Add(2 * time.Second), Link: "en0", From: api.LinkGone, To: api.LinkUnknown, Reason: api.EventReturned},
	}
	if len(res.Events) != len(want) {
		t.Fatalf("events = %+v", res.Events)
	}
	for i := range want {
		if res.Events[i] != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, res.Events[i], want[i])
		}
	}
	eng.events = nil
	if res, _ := c.Events(context.Background()); res.Events == nil || len(res.Events) != 0 {
		t.Fatalf("no events must be an empty list, got %#v", res.Events)
	}
}

// The scheduler's reasons are the API's, word for word.
func TestEventReasonsMatchTheAPI(t *testing.T) {
	ours := []string{engine.EventFound, engine.EventLost, engine.EventReturned, engine.EventAddress, engine.EventProbeOK, engine.EventProbeFailed}
	theirs := api.EventReasons()
	if len(ours) != len(theirs) {
		t.Fatalf("engine has %d reasons, the API %d", len(ours), len(theirs))
	}
	for i := range ours {
		if ours[i] != string(theirs[i]) {
			t.Errorf("reason %d: engine %q, API %q", i, ours[i], theirs[i])
		}
	}
	if engine.MaxLinkEvents != api.MaxEvents {
		t.Errorf("the engine keeps %d events, the API promises %d", engine.MaxLinkEvents, api.MaxEvents)
	}
}

// The contract fixtures the app tests against carry the controller's own words.
func TestResumeReasonsMatchTheFixtures(t *testing.T) {
	read := func(name string) (api.Response, string) {
		t.Helper()
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "fixtures", "daemon-api", name))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := api.ParseResponse(b)
		if err != nil {
			t.Fatal(err)
		}
		if !resp.OK {
			return resp, ""
		}
		var st api.Status
		if err := json.Unmarshal(resp.Result, &st); err != nil {
			t.Fatal(err)
		}
		return resp, st.Reason
	}
	if _, got := read("status.auto-resumed.response.json"); got != ReasonResumed {
		t.Errorf("status.auto-resumed reason = %q, want %q", got, ReasonResumed)
	}
	if _, got := read("setAutoResume.response.json"); got != ReasonCrash {
		t.Errorf("setAutoResume reason = %q, want %q", got, ReasonCrash)
	}
	vpn, _ := read("error.vpn-active.response.json")
	if _, got := read("status.resume-skipped.response.json"); got != NotResumed(vpn.Error.Message) {
		t.Errorf("status.resume-skipped reason = %q, want %q", got, NotResumed(vpn.Error.Message))
	}
}
