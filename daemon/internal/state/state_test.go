package state

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDefaultDir(t *testing.T) {
	got := DefaultDir()
	if runtime.GOOS == "darwin" && got != macStateDir {
		t.Fatalf("DefaultDir() = %q, want %q", got, macStateDir)
	}
	if got == "" {
		t.Fatal("DefaultDir() is empty")
	}
}

func TestPrepareMakesAWorldReadableDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "b")
	if err := Prepare(dir); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o755 {
		t.Fatalf("stat = %v, %v", fi, err)
	}
	if err := Prepare(dir); err != nil {
		t.Fatalf("Prepare must be idempotent: %v", err)
	}
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, nil, 0o600)
	if err := Prepare(filepath.Join(file, "x")); err == nil {
		t.Fatal("Prepare under a regular file must fail")
	}
}
