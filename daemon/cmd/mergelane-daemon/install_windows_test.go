package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Run as a normal user (the kit), install and uninstall refuse before touching anything, and say so in
// the report the app reads.
func TestInstallAndUninstallNeedAdministrator(t *testing.T) {
	dir := t.TempDir()
	for _, cmd := range []string{"install", "uninstall"} {
		report := filepath.Join(dir, cmd+".txt")
		args := []string{"--report", report}
		if cmd == "install" {
			args = append(args, "--user-sid", "S-1-5-21-1-2-3-1001")
		}
		code, out, errOut := run(cmd, args...)
		if code != 1 || out != "" || !strings.Contains(errOut, cmd+" must run as administrator") {
			t.Errorf("%s = %d %q %q", cmd, code, out, errOut)
		}
		if b, _ := os.ReadFile(report); string(b) != "error: "+cmd+" must run as administrator\n" {
			t.Errorf("%s report = %q", cmd, b)
		}
	}
	if code, _, _ := run("uninstall", "--bogus"); code != 1 {
		t.Error("uninstall took a bad flag")
	}
}

func TestWindowsPathsAreInProgramFiles(t *testing.T) {
	p, err := windowsPaths()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(strings.ToLower(p.Binary), `\mergelane\mergelane-daemon.exe`) ||
		!strings.HasSuffix(strings.ToLower(p.Log), `\mergelane\daemon\daemon.log`) {
		t.Errorf("paths: %+v", p)
	}
}
