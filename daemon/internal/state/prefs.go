package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const prefsVersion = 1

// Prefs are the daemon's own settings and the facts it needs after a restart (ADR-0007 follow-up):
//
//   - AutoResume is the user's "turn system merge back on after a crash" setting. Off by default.
//   - WantOn is the user's last explicit choice: true after a successful enable, false after a disable
//     or after the VPN guard turned merging off. Stopping the daemon does not change it.
//   - CleanExit is false while a daemon runs and true once it has stopped on SIGTERM or SIGINT. A start
//     that finds it false knows the previous run died (crash, kill -9, power loss), or that there was no
//     previous run with prefs.json (a first start, or a daemon from before M2.4).
type Prefs struct {
	AutoResume bool `json:"autoResume"`
	WantOn     bool `json:"wantOn"`
	CleanExit  bool `json:"cleanExit"`
}

// prefsFile is prefs.json.
type prefsFile struct {
	Version    int  `json:"version"`
	AutoResume bool `json:"autoResume"`
	WantOn     bool `json:"wantOn"`
	CleanExit  bool `json:"cleanExit"`
}

// PrefsPath is where Prefs live: beside limits.json, so on macOS in Application Support, which
// survives a reboot (LimitsPath explains why).
func PrefsPath(dir string) string {
	return filepath.Join(limitsDir(dir), "prefs.json")
}

// LoadPrefs reads the saved Prefs. A missing file (or one that cannot be read, with the error) gives
// the zero Prefs: auto-resume off, no wish to be on, and no clean exit on record, so the routing table
// alone decides whether the previous run crashed, as before M2.4 (ADR-0007).
func LoadPrefs(dir string) (Prefs, error) {
	b, err := os.ReadFile(PrefsPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		return Prefs{}, nil
	}
	if err != nil {
		return Prefs{}, err
	}
	var f prefsFile
	if err := json.Unmarshal(b, &f); err != nil {
		return Prefs{}, fmt.Errorf("%s: %w", PrefsPath(dir), err)
	}
	return Prefs{AutoResume: f.AutoResume, WantOn: f.WantOn, CleanExit: f.CleanExit}, nil
}

// SavePrefs writes p atomically, like SaveLimits.
func SavePrefs(dir string, p Prefs) error {
	return writeJSON(PrefsPath(dir), prefsFile{
		Version: prefsVersion, AutoResume: p.AutoResume, WantOn: p.WantOn, CleanExit: p.CleanExit,
	})
}

// PrefsStore holds the current Prefs and writes every change through to prefs.json. The controller
// and the daemon's start and stop all change the same file, so changes go through one lock.
type PrefsStore struct {
	dir string

	mu sync.Mutex
	p  Prefs
}

// NewPrefsStore starts from p, normally what LoadPrefs returned. Nothing is written until Update.
func NewPrefsStore(dir string, p Prefs) *PrefsStore {
	return &PrefsStore{dir: dir, p: p}
}

// Get returns the current Prefs.
func (s *PrefsStore) Get() Prefs {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.p
}

// Update applies change and saves the result. If saving fails the change is not kept, so Get never
// reports a setting the file does not hold.
func (s *PrefsStore) Update(change func(*Prefs)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.p
	change(&next)
	if err := SavePrefs(s.dir, next); err != nil {
		return err
	}
	s.p = next
	return nil
}

// writeJSON writes v as indented JSON to path through a temporary file and a rename, so a crash
// mid-write cannot leave a broken file. The directory is created if needed.
func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return replaceFile(tmp, path)
}
