package launchd

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func testJob(t *testing.T) *job {
	t.Helper()
	j, err := newJob(Options{Root: t.TempDir(), Chown: func(string, int, int) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestWriteAtomicFillFailureLeavesNothing(t *testing.T) {
	j := testJob(t)
	dst := filepath.Join(j.paths.Root, "file")
	if err := os.WriteFile(dst, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	errFill := errors.New("disk full")
	err := j.writeAtomic(dst, 0o644, func(w io.Writer) error {
		_, _ = w.Write([]byte("partial"))
		return errFill
	})
	if !errors.Is(err, errFill) {
		t.Fatalf("err = %v, want the fill error", err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != "old" {
		t.Errorf("dst = %q, want the old content", got)
	}
	if temps := listTemps(t, j.paths.Root); temps != nil {
		t.Errorf("temporary files left behind: %q", temps)
	}
}

func TestWriteAtomicSetsExactMode(t *testing.T) {
	j := testJob(t)
	dst := filepath.Join(j.paths.Root, "file")
	for _, mode := range []os.FileMode{0o755, 0o644} {
		if err := j.writeAtomic(dst, mode, func(w io.Writer) error { _, err := w.Write([]byte("x")); return err }); err != nil {
			t.Fatal(err)
		}
		fi, err := os.Stat(dst)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode() != mode {
			t.Errorf("mode = %v, want %v", fi.Mode(), mode)
		}
	}
}

func TestWriteAtomicMissingDirectory(t *testing.T) {
	j := testJob(t)
	err := j.writeAtomic(filepath.Join(j.paths.Root, "missing", "file"), 0o644, func(io.Writer) error { return nil })
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("err = %v, want not-exist", err)
	}
}

func TestEnsureDir(t *testing.T) {
	j := testJob(t)
	file := filepath.Join(j.paths.Root, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := j.ensureDir(file); err == nil {
		t.Error("ensureDir over a regular file succeeded")
	}
	if err := j.ensureDir(filepath.Join(file, "sub")); err == nil {
		t.Error("ensureDir below a regular file succeeded")
	}

	// An existing directory keeps its mode.
	existing := filepath.Join(j.paths.Root, "existing")
	if err := os.Mkdir(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := j.ensureDir(existing); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(existing); fi.Mode().Perm() != 0o700 {
		t.Errorf("existing dir mode changed to %v", fi.Mode())
	}

	if os.Geteuid() != 0 {
		// Mkdir fails in a directory the caller cannot write.
		ro := filepath.Join(j.paths.Root, "ro")
		if err := os.Mkdir(ro, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })
		if err := j.ensureDir(filepath.Join(ro, "sub")); !errors.Is(err, os.ErrPermission) {
			t.Errorf("err = %v, want a permission error", err)
		}
	}
}

func TestRemoveIfPresentAndRegularFile(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing")
	if err := removeIfPresent(missing); err != nil {
		t.Errorf("removing a missing file: %v", err)
	}
	if ok, err := regularFile(missing); ok || err != nil {
		t.Errorf("regularFile(missing) = %v, %v", ok, err)
	}
	if ok, err := regularFile(dir); ok || err != nil {
		t.Errorf("regularFile(dir) = %v, %v", ok, err)
	}
	file := filepath.Join(dir, "f")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if ok, err := regularFile(file); !ok || err != nil {
		t.Errorf("regularFile(file) = %v, %v", ok, err)
	}
	if err := removeIfPresent(file); err != nil {
		t.Fatal(err)
	}
	if ok, _ := regularFile(file); ok {
		t.Error("file still there")
	}
}
