package winsvc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sid = "S-1-5-21-1004336348-1177238915-682003330-1001"

// fakeSCM records the calls Install and Uninstall make, and fails the one named in fail.
type fakeSCM struct {
	calls []string
	fail  string
	args  []string
}

func (f *fakeSCM) step(name string) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New(name + " failed")
	}
	return nil
}

func (f *fakeSCM) Stop(context.Context) error { return f.step("stop") }
func (f *fakeSCM) Configure(binary string, args []string) error {
	f.args = append([]string{binary}, args...)
	return f.step("configure")
}
func (f *fakeSCM) Start(context.Context) error { return f.step("start") }
func (f *fakeSCM) Delete() error               { return f.step("delete") }

// setup makes the app's folder with the program and wintun.dll, and the folders to install into.
func setup(t *testing.T) (Options, *fakeSCM) {
	t.Helper()
	root := t.TempDir()
	app := filepath.Join(root, "app", "resources")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{BinaryName: "new daemon", WintunName: "new wintun"} {
		if err := os.WriteFile(filepath.Join(app, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	scm := &fakeSCM{}
	return Options{
		Source:  filepath.Join(app, BinaryName),
		UserSID: sid,
		Paths:   PathsFor(filepath.Join(root, "Program Files"), filepath.Join(root, "ProgramData", "Mergelane", "daemon")),
		Manager: scm,
	}, scm
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPathsAndArgs(t *testing.T) {
	p := PathsFor(`C:\Program Files`, `C:\ProgramData\Mergelane\daemon`)
	if !strings.HasSuffix(p.Binary, BinaryName) || filepath.Dir(p.Binary) != p.Dir || filepath.Dir(p.Wintun) != p.Dir {
		t.Errorf("paths: %+v", p)
	}
	if got, want := Args(p, sid), []string{"run", "--allowed-sid", sid, "--log", p.Log}; !reflect.DeepEqual(got, want) {
		t.Errorf("Args = %v, want %v", got, want)
	}
}

// A fresh install, then an update over it: the old helper is stopped before its files are replaced.
func TestInstallCopiesThenRegistersAndStarts(t *testing.T) {
	o, scm := setup(t)
	if err := Install(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if want := []string{"stop", "configure", "start"}; !reflect.DeepEqual(scm.calls, want) {
		t.Errorf("calls = %v, want %v", scm.calls, want)
	}
	if want := append([]string{o.Paths.Binary}, Args(o.Paths, sid)...); !reflect.DeepEqual(scm.args, want) {
		t.Errorf("configured %v, want %v", scm.args, want)
	}
	if read(t, o.Paths.Binary) != "new daemon" || read(t, o.Paths.Wintun) != "new wintun" {
		t.Error("the files weren't copied")
	}
	os.WriteFile(o.Source, []byte("newer daemon"), 0o644)
	if err := Install(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if read(t, o.Paths.Binary) != "newer daemon" {
		t.Error("the update didn't replace the program")
	}
	entries, _ := os.ReadDir(o.Paths.Dir)
	if len(entries) != 2 {
		t.Errorf("the folder has %d entries, want the program and wintun.dll only (no temporary file left)", len(entries))
	}
}

func TestInstallRefusesBeforeTouchingAnything(t *testing.T) {
	for _, c := range []struct {
		name   string
		change func(*Options)
		want   string
	}{
		{"a group instead of a user", func(o *Options) { o.UserSID = "S-1-1-0" }, "security identifier"},
		{"no program", func(o *Options) { o.Source = filepath.Join(filepath.Dir(o.Source), "missing.exe") }, "is missing"},
		{"no wintun.dll", func(o *Options) { os.Remove(filepath.Join(filepath.Dir(o.Source), WintunName)) }, "wintun.dll is missing"},
	} {
		t.Run(c.name, func(t *testing.T) {
			o, scm := setup(t)
			c.change(&o)
			err := Install(context.Background(), o)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("Install = %v, want an error with %q", err, c.want)
			}
			if len(scm.calls) != 0 {
				t.Errorf("calls = %v, want none", scm.calls)
			}
			if _, err := os.Stat(o.Paths.Dir); !errors.Is(err, os.ErrNotExist) {
				t.Error("the install folder was made")
			}
		})
	}
}

func TestInstallStopsAtTheFailingStep(t *testing.T) {
	for _, step := range []string{"stop", "configure", "start"} {
		t.Run(step, func(t *testing.T) {
			o, scm := setup(t)
			scm.fail = step
			if err := Install(context.Background(), o); err == nil || !strings.Contains(err.Error(), step+" failed") {
				t.Errorf("Install = %v", err)
			}
			if last := scm.calls[len(scm.calls)-1]; last != step {
				t.Errorf("went on after %s: %v", step, scm.calls)
			}
		})
	}
}

func TestInstallCopyFailure(t *testing.T) {
	o, _ := setup(t)
	// The program's place is taken by a folder, which a file can't be renamed over.
	if err := os.MkdirAll(filepath.Join(o.Paths.Binary, "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), o); err == nil {
		t.Fatal("Install succeeded over a folder")
	}
	entries, _ := os.ReadDir(o.Paths.Dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Errorf("temporary file %s left behind", e.Name())
		}
	}
}

func TestUninstallRemovesServiceThenFiles(t *testing.T) {
	o, scm := setup(t)
	if err := Install(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	scm.calls = nil
	cleaned := false
	o.Cleanup = func() { cleaned = true }
	if err := Uninstall(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if want := []string{"stop", "delete"}; !reflect.DeepEqual(scm.calls, want) || !cleaned {
		t.Errorf("calls = %v, cleaned %v", scm.calls, cleaned)
	}
	if _, err := os.Stat(o.Paths.Dir); !errors.Is(err, os.ErrNotExist) {
		t.Error("the install folder is still there")
	}
	// Again, with nothing installed: nothing to do, no error.
	if err := Uninstall(context.Background(), o); err != nil {
		t.Errorf("second Uninstall: %v", err)
	}
}

func TestUninstallLeavesOthersFiles(t *testing.T) {
	o, _ := setup(t)
	if err := Install(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(o.Paths.Dir, "notes.txt")
	os.WriteFile(other, []byte("not ours"), 0o644)
	if err := Uninstall(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	if read(t, other) != "not ours" {
		t.Error("someone else's file was removed")
	}
	if _, err := os.Stat(o.Paths.Binary); !errors.Is(err, os.ErrNotExist) {
		t.Error("the program is still there")
	}
}

func TestUninstallStopsAtTheFailingStep(t *testing.T) {
	for _, step := range []string{"stop", "delete"} {
		t.Run(step, func(t *testing.T) {
			o, scm := setup(t)
			scm.fail = step
			cleaned := false
			o.Cleanup = func() { cleaned = true }
			if err := Uninstall(context.Background(), o); err == nil || cleaned {
				t.Errorf("Uninstall = %v, cleaned %v", err, cleaned)
			}
		})
	}
}

func TestInstallCantMakeItsFolder(t *testing.T) {
	o, scm := setup(t)
	// A file where the Program Files folder should be.
	os.WriteFile(filepath.Dir(o.Paths.Dir), []byte("file"), 0o644)
	if err := Install(context.Background(), o); err == nil {
		t.Fatal("Install succeeded without its folder")
	}
	if want := []string{"stop"}; !reflect.DeepEqual(scm.calls, want) {
		t.Errorf("calls = %v, want %v", scm.calls, want)
	}
}

func TestCopyFileFailures(t *testing.T) {
	dir := t.TempDir()
	if err := copyFile(filepath.Join(dir, "missing"), filepath.Join(dir, "out")); err == nil {
		t.Error("copied a missing file")
	}
	src := filepath.Join(dir, "src")
	os.WriteFile(src, []byte("x"), 0o644)
	if err := copyFile(src, filepath.Join(dir, "no-such-folder", "out")); err == nil {
		t.Error("copied into a missing folder")
	}
	// A folder can be opened but not read as a file.
	if err := copyFile(dir, filepath.Join(dir, "out")); err == nil {
		t.Error("copied a folder")
	}
	if _, err := os.Stat(filepath.Join(dir, "out")); !errors.Is(err, os.ErrNotExist) {
		t.Error("a failed copy left its destination")
	}
}

func TestUninstallCantRemoveAFile(t *testing.T) {
	o, _ := setup(t)
	// The program's place is a folder with something in it, which Remove refuses.
	os.MkdirAll(filepath.Join(o.Paths.Binary, "x"), 0o755)
	if err := Uninstall(context.Background(), o); err == nil {
		t.Error("Uninstall succeeded although the program couldn't be removed")
	}
}
