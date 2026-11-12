package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReportedWritesTheResultOnce(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.txt")
	if err := reported(ok, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(ok); string(b) != "ok\n" {
		t.Errorf("report = %q", b)
	}
	failed := filepath.Join(dir, "failed.txt")
	if err := reported(failed, func() error { return errors.New("install: wintun.dll is missing") }); err == nil {
		t.Fatal("the step's error was lost")
	}
	if b, _ := os.ReadFile(failed); string(b) != "error: install: wintun.dll is missing\n" {
		t.Errorf("report = %q", b)
	}
	// A file already there is never written through, and that failure is reported.
	if err := reported(ok, func() error { return nil }); err == nil {
		t.Error("wrote over an existing report")
	}
	if b, _ := os.ReadFile(ok); string(b) != "ok\n" {
		t.Errorf("the existing file changed: %q", b)
	}
	// The step's own error wins over the report's.
	if err := reported(ok, func() error { return errors.New("step") }); err == nil || err.Error() != "step" {
		t.Errorf("err = %v, want the step's", err)
	}
	// No path: just the step.
	if err := reported("", func() error { return nil }); err != nil {
		t.Error(err)
	}
	if err := writeReport(filepath.Join(dir, "missing", "r.txt"), nil); err == nil {
		t.Error("wrote into a missing folder")
	}
}

func TestInstallSourceDefaultsToThisProgram(t *testing.T) {
	if got, err := installSource(`C:\x\mergelane-daemon.exe`); err != nil || got != `C:\x\mergelane-daemon.exe` {
		t.Errorf("installSource(given) = %q, %v", got, err)
	}
	self, _ := os.Executable()
	if got, err := installSource(""); err != nil || got != self {
		t.Errorf("installSource(\"\") = %q, %v; want %q", got, err, self)
	}
}
