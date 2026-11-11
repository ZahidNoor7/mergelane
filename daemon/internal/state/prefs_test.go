package state

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLoadPrefsWithoutAFileIsAFirstStart(t *testing.T) {
	got, err := LoadPrefs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Auto-resume is off by default (ADR-0007), nothing is wanted on, and no clean exit is on record:
	// only leftover routes can tell that a daemon from before M2.4 crashed.
	if got != (Prefs{}) {
		t.Fatalf("LoadPrefs = %+v, want the zero Prefs", got)
	}
}

func TestPrefsRoundTrip(t *testing.T) {
	for _, want := range []Prefs{
		{AutoResume: true, WantOn: true, CleanExit: false},
		{AutoResume: false, WantOn: false, CleanExit: true},
		{AutoResume: true, WantOn: false, CleanExit: true},
	} {
		dir := t.TempDir()
		if err := SavePrefs(dir, want); err != nil {
			t.Fatal(err)
		}
		got, err := LoadPrefs(dir)
		if err != nil || got != want {
			t.Fatalf("LoadPrefs = %+v, %v; want %+v", got, err, want)
		}
	}
}

func TestSavePrefsWritesTheDocumentedFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "made", "on", "demand")
	if err := SavePrefs(dir, Prefs{AutoResume: true, WantOn: true}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(PrefsPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"version\": 1,\n  \"autoResume\": true,\n  \"wantOn\": true,\n  \"cleanExit\": false\n}\n"
	if string(b) != want {
		t.Fatalf("prefs.json = %q, want %q", b, want)
	}
	if _, err := os.Stat(PrefsPath(dir) + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("the temporary file was left behind: %v", err)
	}
}

func TestLoadPrefsWithoutACleanExitFieldIsNotClean(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(PrefsPath(dir), []byte(`{"version":1,"autoResume":true,"wantOn":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadPrefs(dir)
	if want := (Prefs{AutoResume: true, WantOn: true}); err != nil || got != want {
		t.Fatalf("LoadPrefs = %+v, %v; want %+v", got, err, want)
	}
}

func TestLoadPrefsBrokenFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(PrefsPath(dir), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadPrefs(dir)
	if err == nil || !strings.Contains(err.Error(), PrefsPath(dir)) {
		t.Fatalf("a broken prefs.json must be reported with its path, got %v", err)
	}
	// The caller may ignore the error: the result is still the safe default.
	if got != (Prefs{}) {
		t.Fatalf("LoadPrefs = %+v, want the zero Prefs", got)
	}
}

func TestLoadPrefsUnreadable(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(PrefsPath(dir), 0o755); err != nil { // a directory where the file should be
		t.Fatal(err)
	}
	if got, err := LoadPrefs(dir); err == nil || got != (Prefs{}) {
		t.Fatalf("LoadPrefs = %+v, %v; want the defaults and an error", got, err)
	}
}

func TestPrefsLiveBesideTheLimits(t *testing.T) {
	for _, dir := range []string{macStateDir, "/tmp/somewhere-else"} {
		if got, want := PrefsPath(dir), filepath.Join(filepath.Dir(LimitsPath(dir)), "prefs.json"); got != want {
			t.Errorf("PrefsPath(%q) = %q, want %q", dir, got, want)
		}
	}
}

func TestPrefsStoreWritesThrough(t *testing.T) {
	dir := t.TempDir()
	s := NewPrefsStore(dir, Prefs{CleanExit: true})
	if err := s.Update(func(p *Prefs) { p.AutoResume, p.CleanExit = true, false }); err != nil {
		t.Fatal(err)
	}
	want := Prefs{AutoResume: true}
	if got := s.Get(); got != want {
		t.Fatalf("Get = %+v, want %+v", got, want)
	}
	if got, err := LoadPrefs(dir); err != nil || got != want {
		t.Fatalf("on disk = %+v, %v; want %+v", got, err, want)
	}

	// Updates from several goroutines are serialised: none is lost.
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			if err := s.Update(func(p *Prefs) {
				if i%2 == 0 {
					p.WantOn = true
				} else {
					p.CleanExit = true
				}
			}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	want = Prefs{AutoResume: true, WantOn: true, CleanExit: true}
	if got, err := LoadPrefs(dir); err != nil || got != want || s.Get() != want {
		t.Fatalf("after concurrent updates: disk %+v (%v), memory %+v; want %+v", got, err, s.Get(), want)
	}
}

func TestPrefsStoreKeepsTheOldValueWhenSavingFails(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewPrefsStore(filepath.Join(file, "state"), Prefs{CleanExit: true}) // a directory under a file
	if err := s.Update(func(p *Prefs) { p.AutoResume = true }); err == nil {
		t.Fatal("saving under a regular file must fail")
	}
	if got := s.Get(); got != (Prefs{CleanExit: true}) {
		t.Fatalf("Get = %+v after a failed save; the change must not be kept", got)
	}
}

func TestWriteJSONReportsAnEncodingError(t *testing.T) {
	if err := writeJSON(filepath.Join(t.TempDir(), "x.json"), map[string]any{"bad": make(chan int)}); err == nil {
		t.Fatal("a value JSON cannot encode must be an error")
	}
}

func TestWriteJSONReportsAWriteError(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "x.json.tmp"), 0o755); err != nil { // the temporary file can't be created
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(dir, "x.json"), Prefs{}); err == nil {
		t.Fatal("a temporary file that can't be written must be an error")
	}
}
