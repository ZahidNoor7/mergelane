package control

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
)

func TestTheSavedStickySettingIsAppliedAtStart(t *testing.T) {
	var applied []bool
	c := New(Config{
		Version: "v", Tunnel: &fakeTunnel{}, Engine: &fakeEngine{},
		Prefs:       Prefs{StickySites: true},
		ApplySticky: func(on bool) { applied = append(applied, on) },
	})
	if st := statusOf(t, c); !st.StickySites {
		t.Fatalf("status = %+v, want sticky sites on", st)
	}
	if len(applied) != 1 || !applied[0] {
		t.Fatalf("applied %v at start, want [true]", applied)
	}
}

func TestSetStickySitesSavesAndApplies(t *testing.T) {
	c, _, _, _, rec := newResumer(t, Prefs{WantOn: true, StickySites: true})
	var applied []bool
	c.cfg.ApplySticky = func(on bool) { applied = append(applied, on) }
	ctx := context.Background()

	st, err := c.SetStickySites(ctx, api.SetStickySitesParams{Enabled: false})
	if err != nil || st.StickySites {
		t.Fatalf("setStickySites off = %+v, %v", st, err)
	}
	// Saved with the rest unchanged, and in effect at once.
	if got := rec.get(); len(got) != 1 || got[0] != (Prefs{WantOn: true}) {
		t.Fatalf("saved %+v", got)
	}
	if len(applied) != 1 || applied[0] {
		t.Fatalf("applied %v, want [false]", applied)
	}
	// The same value again: nothing saved or applied.
	if _, err := c.SetStickySites(ctx, api.SetStickySitesParams{Enabled: false}); err != nil || len(rec.get()) != 1 || len(applied) != 1 {
		t.Fatalf("a no-op change acted: saved %+v, applied %v, %v", rec.get(), applied, err)
	}
	// A failed save changes nothing.
	rec.err = errors.New("disk full")
	st, err = c.SetStickySites(ctx, api.SetStickySitesParams{Enabled: true})
	if code(t, err) != api.CodeInternal || !strings.Contains(err.Error(), "disk full") || st.StickySites {
		t.Fatalf("a failed save = %+v, %v; the setting must stay off", st, err)
	}
	if statusOf(t, c).StickySites || len(applied) != 1 {
		t.Fatal("a setting that could not be saved took effect")
	}
	// Without a saver or an applier it still changes.
	c.cfg.SavePrefs, c.cfg.ApplySticky = nil, nil
	if st, err := c.SetStickySites(ctx, api.SetStickySitesParams{Enabled: true}); err != nil || !st.StickySites {
		t.Fatalf("without a saver: %+v, %v", st, err)
	}
}
