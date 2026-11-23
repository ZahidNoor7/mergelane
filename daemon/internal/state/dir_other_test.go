//go:build !windows

package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNoWindowsDirElsewhere(t *testing.T) {
	if got := windowsDir(); got != "" {
		t.Errorf("windowsDir() = %q off Windows", got)
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
