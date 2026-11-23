package state

import (
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
