// Package control is the daemon's state machine behind the control API: it turns system-wide
// merging on and off, refuses to while another VPN is active, turns itself off when one appears,
// turns itself back on after a crash when the user allows it, and reports links, statistics and
// link events. It implements api.Handler.
package control

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
)

// Tunnel is the system-wide switch (tun.Tun): On adds the utun's capture routes, Off removes them.
type Tunnel interface {
	On() error
	Off()
	// Name is the utun's name once created, "" before; the VPN guard ignores it.
	Name() string
}

// Engine is the part of the scheduler the controller uses.
type Engine interface {
	Snapshot() []engine.SlotStats
	SetLimit(name string, mbitPerSec float64)
	Limits() map[string]float64
	Events() []engine.LinkEvent
}

// Prefs are the settings the controller keeps across restarts (state.Prefs, without the daemon's
// exit marker).
type Prefs struct {
	// AutoResume is the user's "turn system merge back on after a crash" setting.
	AutoResume bool
	// WantOn is the user's last explicit choice: true after a successful enable, false after a
	// disable or a VPN turn-off. Shutdown leaves it alone.
	WantOn bool
	// StickySites is the user's "keep each site on one network" setting (ADR-0048).
	StickySites bool
}

// Guard returns a user-facing message for each active VPN or tunnel that conflicts with system
// merging; ours reports whether an interface is the daemon's own. Empty means no conflict.
type Guard func(ctx context.Context, ours func(iface string) bool) ([]string, error)

// Config wires a Controller.
type Config struct {
	Version    string
	Tunnel     Tunnel
	Engine     Engine
	Guard      Guard
	SaveLimits func(map[string]float64) error
	// StartReason is shown while merging is off after startup, e.g. after a crash (ADR-0007).
	StartReason string
	// Prefs are the saved settings; SavePrefs (optional) saves every change.
	Prefs     Prefs
	SavePrefs func(Prefs) error
	// ApplySticky (optional) puts the sticky-sites setting into effect: called by New with the saved
	// one, and on every change.
	ApplySticky func(on bool)
	Now         func() time.Time
	Logf        func(format string, a ...any) // warnings; logx.Printf when nil
}

// Messages shown to the user.
const (
	ReasonRequested = ""
	ReasonCrash     = "System merge was turned off after Mergelane's helper stopped unexpectedly. Turn it on again when you're ready."
	ReasonNoLinks   = "No network with internet access is available to merge."
	// ReasonResuming is shown while Resume waits for a link after a crash.
	ReasonResuming = "Mergelane's helper restarted unexpectedly. System merge will turn back on once a network can reach the internet."
	// ReasonResumed is shown while merging is on because Resume turned it back on.
	ReasonResumed = "Turned back on after Mergelane's helper restarted."
)

// NotResumed is the reason shown when Resume could not turn merging back on: the crash, then why.
func NotResumed(why string) string {
	return ReasonCrash + " It wasn't turned back on automatically: " + why
}

// resumePoll is how often Resume looks for a link that passed its probe.
var resumePoll = 250 * time.Millisecond

// Controller implements api.Handler. It always starts off.
type Controller struct {
	cfg Config

	mu       sync.Mutex
	state    api.State
	reason   string
	since    time.Time
	prefs    Prefs
	disabled bool // Disable was called: a pending Resume must not undo it
	closed   bool // Shutdown ran: nothing turns merging on any more
}

// New returns a Controller in the off state.
func New(cfg Config) *Controller {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = logx.Printf
	}
	if cfg.ApplySticky != nil {
		cfg.ApplySticky(cfg.Prefs.StickySites)
	}
	return &Controller{cfg: cfg, state: api.StateOff, reason: cfg.StartReason, since: cfg.Now(), prefs: cfg.Prefs}
}

var _ api.Handler = (*Controller)(nil)

func (c *Controller) status() api.Status {
	return api.Status{
		State: c.state, Reason: c.reason, Since: c.since, Version: c.cfg.Version,
		AutoResume: c.prefs.AutoResume, StickySites: c.prefs.StickySites,
	}
}

// setWantOn records the user's choice. A failed save is only logged: it must not undo an enable or
// a disable that already happened, and the next successful save writes it.
func (c *Controller) setWantOn(on bool) {
	if c.prefs.WantOn == on {
		return
	}
	c.prefs.WantOn = on
	if c.cfg.SavePrefs != nil {
		if err := c.cfg.SavePrefs(c.prefs); err != nil {
			c.cfg.Logf("warning: saving prefs: %v\n", err)
		}
	}
}

func (c *Controller) set(state api.State, reason string) {
	if state != c.state {
		c.since = c.cfg.Now()
	}
	c.state, c.reason = state, reason
}

// Status implements api.Handler.
func (c *Controller) Status(context.Context) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status(), nil
}

func (c *Controller) ours(iface string) bool {
	name := c.cfg.Tunnel.Name()
	return name != "" && iface == name
}

// Enable implements api.Handler. It refuses while another VPN is active (VPN_ACTIVE) or when no
// link has internet (NO_USABLE_LINKS), and never adds a route in either case. A successful enable
// is saved as the user's wish (Prefs.WantOn).
func (c *Controller) Enable(ctx context.Context) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == api.StateOn {
		return c.status(), nil
	}
	if c.closed {
		return c.status(), api.Errorf(api.CodeInternal, "mergelane-daemon is stopping")
	}
	if err := c.enableLocked(ctx); err != nil {
		return c.status(), err
	}
	c.setWantOn(true)
	return c.status(), nil
}

// enableLocked runs Enable's checks and adds the routes.
func (c *Controller) enableLocked(ctx context.Context) *api.Error {
	conflicts, err := c.cfg.Guard(ctx, c.ours)
	if err != nil {
		return api.Errorf(api.CodeInternal, "couldn't check for other VPNs: %v", err)
	}
	if len(conflicts) > 0 {
		c.reason = conflicts[0]
		return api.Errorf(api.CodeVPNActive, "%s", conflicts[0])
	}
	if !hasUsableLink(c.cfg.Engine.Snapshot()) {
		c.reason = ReasonNoLinks
		return api.Errorf(api.CodeNoUsableLinks, "%s", ReasonNoLinks)
	}
	c.set(api.StateStarting, "")
	if err := c.cfg.Tunnel.On(); err != nil {
		c.set(api.StateOff, "")
		return api.Errorf(api.CodeInternal, "couldn't turn system merge on: %v", err)
	}
	c.set(api.StateOn, "")
	return nil
}

// Disable implements api.Handler. It is saved as the user's wish (Prefs.WantOn), and cancels a
// pending Resume.
func (c *Controller) Disable(_ context.Context, p api.DisableParams) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.disabled = true
	c.disableLocked(p.Reason)
	c.setWantOn(false)
	return c.status(), nil
}

// SetAutoResume implements api.Handler: it saves the "turn back on after a crash" setting, which
// Resume reads at the daemon's next start after a crash. If saving fails, the setting is unchanged.
func (c *Controller) SetAutoResume(_ context.Context, p api.SetAutoResumeParams) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prefs.AutoResume == p.Enabled {
		return c.status(), nil
	}
	next := c.prefs
	next.AutoResume = p.Enabled
	if c.cfg.SavePrefs != nil {
		if err := c.cfg.SavePrefs(next); err != nil {
			return c.status(), api.Errorf(api.CodeInternal, "saving the auto-resume setting: %v", err)
		}
	}
	c.prefs = next
	return c.status(), nil
}

// SetStickySites implements api.Handler: it saves the "keep each site on one network" setting and
// puts it into effect for the next flows. If saving fails, the setting is unchanged.
func (c *Controller) SetStickySites(_ context.Context, p api.SetStickySitesParams) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prefs.StickySites == p.Enabled {
		return c.status(), nil
	}
	next := c.prefs
	next.StickySites = p.Enabled
	if c.cfg.SavePrefs != nil {
		if err := c.cfg.SavePrefs(next); err != nil {
			return c.status(), api.Errorf(api.CodeInternal, "saving the sticky-sites setting: %v", err)
		}
	}
	c.prefs = next
	if c.cfg.ApplySticky != nil {
		c.cfg.ApplySticky(next.StickySites)
	}
	return c.status(), nil
}

// Resume turns merging back on after the daemon restarted from a crash, when auto-resume is on (the
// ADR-0007 follow-up). run calls it only after a crash. It waits up to wait for a link's internet
// probe to pass, then makes Enable's checks: no other VPN, a usable link. If a check fails, merging
// stays off and the reason says why. It does nothing if auto-resume is off, and stops quietly if the
// user turns merging on or off, or auto-resume off, meanwhile, or the daemon stops. It reports
// whether it turned merging on.
func (c *Controller) Resume(ctx context.Context, wait time.Duration) bool {
	c.mu.Lock()
	if !c.resumable() {
		c.mu.Unlock()
		return false
	}
	c.reason = ReasonResuming
	c.mu.Unlock()

	up := c.waitForUpLink(ctx, wait)

	c.mu.Lock()
	defer c.mu.Unlock()
	if ctx.Err() != nil || !c.resumable() {
		if c.state == api.StateOff && c.reason == ReasonResuming {
			c.reason = ReasonCrash
		}
		return false
	}
	if !up {
		c.reason = NotResumed(ReasonNoLinks)
		return false
	}
	if err := c.enableLocked(ctx); err != nil {
		c.reason = NotResumed(err.Message)
		return false
	}
	c.set(api.StateOn, ReasonResumed)
	c.setWantOn(true) // already true after an unclean exit; after leftover routes it may not be
	return true
}

func (c *Controller) resumable() bool {
	return !c.closed && !c.disabled && c.state == api.StateOff && c.prefs.AutoResume
}

// waitForUpLink reports whether a link passed its internet probe within wait.
func (c *Controller) waitForUpLink(ctx context.Context, wait time.Duration) bool {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	tick := time.NewTicker(resumePoll)
	defer tick.Stop()
	for !hasUpLink(c.cfg.Engine.Snapshot()) {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return hasUpLink(c.cfg.Engine.Snapshot())
		case <-tick.C:
		}
	}
	return true
}

func (c *Controller) disableLocked(reason string) {
	if c.state != api.StateOff {
		c.set(api.StateStopping, reason)
		c.cfg.Tunnel.Off()
	}
	c.set(api.StateOff, reason)
}

// CheckGuard turns merging off, with the conflict as the reason, if a VPN appeared while it was on.
// It reports whether it did.
func (c *Controller) CheckGuard(ctx context.Context) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != api.StateOn {
		return false
	}
	conflicts, err := c.cfg.Guard(ctx, c.ours)
	if err != nil || len(conflicts) == 0 {
		return false
	}
	c.disableLocked(conflicts[0])
	c.setWantOn(false)
	return true
}

// Watch calls CheckGuard every interval until ctx ends.
func (c *Controller) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.CheckGuard(ctx)
		}
	}
}

func hasUsableLink(snap []engine.SlotStats) bool {
	for _, s := range snap {
		if s.Present && (s.State == "up" || s.State == "checking" || s.State6 == "up") {
			return true
		}
	}
	return false
}

// hasUpLink is stricter than hasUsableLink: a link's probe has passed.
func hasUpLink(snap []engine.SlotStats) bool {
	for _, s := range snap {
		if s.Present && (s.State == "up" || s.State6 == "up") {
			return true
		}
	}
	return false
}

func linkState(s engine.SlotStats) api.LinkState {
	state := s.State
	if state == "-" {
		state = s.State6
	}
	return stateOf(state)
}

// stateOf maps the scheduler's words for a link's state (SlotStats.State, LinkEvent) to the API's.
func stateOf(word string) api.LinkState {
	switch word {
	case "up":
		return api.LinkUp
	case "no internet":
		return api.LinkDown
	case engine.StateGone:
		return api.LinkGone
	}
	return api.LinkUnknown
}

// Links implements api.Handler.
func (c *Controller) Links(context.Context) (api.LinksResult, error) {
	snap := c.cfg.Engine.Snapshot()
	links := make([]api.Link, 0, len(snap))
	for _, s := range snap {
		links = append(links, api.Link{
			Name: s.Name, Index: s.Index, IPv4: s.IP, IPv6: s.IP6,
			Up: s.Present, State: linkState(s), LimitMbps: s.LimitMbps,
		})
	}
	return api.LinksResult{Links: links}, nil
}

// Stats implements api.Handler. Rates are bytes per second.
func (c *Controller) Stats(context.Context) (api.Stats, error) {
	snap := c.cfg.Engine.Snapshot()
	links := make([]api.LinkStats, 0, len(snap))
	for _, s := range snap {
		links = append(links, api.LinkStats{
			Name: s.Name, RxBps: s.RateIn, TxBps: s.RateOut, LinkRxBps: s.LinkIn, LinkTxBps: s.LinkOut,
			ActiveFlows: s.Active, TotalFlows: s.Total, Weight: math.Max(s.Weight, s.Weight6), Failed: s.Failed,
		})
	}
	return api.Stats{At: c.cfg.Now(), Links: links}, nil
}

// SetLimit implements api.Handler: caps a link (0 removes the cap) and saves the caps.
func (c *Controller) SetLimit(_ context.Context, p api.SetLimitParams) (api.SetLimitResult, error) {
	if err := p.Validate(); err != nil {
		return api.SetLimitResult{}, api.Errorf(api.CodeBadRequest, "%v", err)
	}
	c.cfg.Engine.SetLimit(p.Link, p.Mbps)
	if c.cfg.SaveLimits != nil {
		if err := c.cfg.SaveLimits(c.cfg.Engine.Limits()); err != nil {
			return api.SetLimitResult{}, api.Errorf(api.CodeInternal, "saving the limit: %v", err)
		}
	}
	return api.SetLimitResult(p), nil
}

// Events implements api.Handler: the scheduler's recent link changes, oldest first.
func (c *Controller) Events(context.Context) (api.EventsResult, error) {
	evs := c.cfg.Engine.Events()
	out := make([]api.LinkEvent, 0, len(evs))
	for _, e := range evs {
		out = append(out, api.LinkEvent{
			At: e.At, Link: e.Link, From: stateOf(e.From), To: stateOf(e.To), Reason: api.LinkEventReason(e.Reason),
		})
	}
	return api.EventsResult{Events: out}, nil
}

// Shutdown turns merging off before the daemon exits. Afterwards nothing turns it on again, not a
// late Enable nor a pending Resume. The user's wish (Prefs.WantOn) is left as it is.
func (c *Controller) Shutdown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.disableLocked(c.reason)
}
