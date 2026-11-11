// Package control is the daemon's state machine behind the control API: it turns system-wide
// merging on and off, refuses to while another VPN is active, turns itself off when one appears,
// and reports links and statistics. It implements api.Handler.
package control

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
	"github.com/ZahidNoor7/mergelane/daemon/internal/engine"
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
	Now         func() time.Time
}

// Messages shown to the user.
const (
	ReasonRequested = ""
	ReasonCrash     = "System merge was turned off after Mergelane's helper stopped unexpectedly. Turn it on again when you're ready."
	ReasonNoLinks   = "No network with internet access is available to merge."
)

// Controller implements api.Handler. It always starts off.
type Controller struct {
	cfg Config

	mu     sync.Mutex
	state  api.State
	reason string
	since  time.Time
}

// New returns a Controller in the off state.
func New(cfg Config) *Controller {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Controller{cfg: cfg, state: api.StateOff, reason: cfg.StartReason, since: cfg.Now()}
}

var _ api.Handler = (*Controller)(nil)

func (c *Controller) status() api.Status {
	return api.Status{State: c.state, Reason: c.reason, Since: c.since, Version: c.cfg.Version}
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
// link has internet (NO_USABLE_LINKS), and never adds a route in either case.
func (c *Controller) Enable(ctx context.Context) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == api.StateOn {
		return c.status(), nil
	}
	conflicts, err := c.cfg.Guard(ctx, c.ours)
	if err != nil {
		return c.status(), api.Errorf(api.CodeInternal, "couldn't check for other VPNs: %v", err)
	}
	if len(conflicts) > 0 {
		c.reason = conflicts[0]
		return c.status(), api.Errorf(api.CodeVPNActive, "%s", conflicts[0])
	}
	if !hasUsableLink(c.cfg.Engine.Snapshot()) {
		c.reason = ReasonNoLinks
		return c.status(), api.Errorf(api.CodeNoUsableLinks, "%s", ReasonNoLinks)
	}
	c.set(api.StateStarting, "")
	if err := c.cfg.Tunnel.On(); err != nil {
		c.set(api.StateOff, "")
		return c.status(), api.Errorf(api.CodeInternal, "couldn't turn system merge on: %v", err)
	}
	c.set(api.StateOn, "")
	return c.status(), nil
}

// Disable implements api.Handler.
func (c *Controller) Disable(_ context.Context, p api.DisableParams) (api.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.disableLocked(p.Reason)
	return c.status(), nil
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

func linkState(s engine.SlotStats) api.LinkState {
	state := s.State
	if state == "-" {
		state = s.State6
	}
	switch state {
	case "up":
		return api.LinkUp
	case "no internet":
		return api.LinkDown
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

// Shutdown turns merging off before the daemon exits.
func (c *Controller) Shutdown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.disableLocked(c.reason)
}
