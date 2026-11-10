package launchd

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden")

const plutil = "/usr/bin/plutil"

func TestPlistGolden(t *testing.T) {
	p, err := PathsFor("/")
	if err != nil {
		t.Fatal(err)
	}
	got, err := PlistXML(p, 501)
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "daemon.plist.golden")
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run go test -run TestPlistGolden -update to create it)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("plist differs from %s:\n--- got ---\n%s\n--- want ---\n%s", golden, got, want)
	}
}

func TestPlistRejectsInvalidUID(t *testing.T) {
	p, _ := PathsFor("/")
	for _, uid := range []int{0, -1, math.MaxUint32, math.MaxUint32 + 1} {
		if _, err := PlistXML(p, uid); !errors.Is(err, ErrInvalidUID) {
			t.Errorf("uid %d: err = %v, want ErrInvalidUID", uid, err)
		}
	}
	for _, uid := range []int{1, 501, math.MaxUint32 - 1} {
		if _, err := PlistXML(p, uid); err != nil {
			t.Errorf("uid %d: %v", uid, err)
		}
	}
}

// plutilJSON lints the plist with plutil(1) and returns it decoded through `plutil -convert json -o -`, which
// the man page documents as writing the converted plist to stdout.
func plutilJSON(t *testing.T, plist []byte) map[string]any {
	t.Helper()
	if _, err := os.Stat(plutil); err != nil {
		t.Skipf("%s not available: %v", plutil, err)
	}
	path := filepath.Join(t.TempDir(), Label+".plist")
	if err := os.WriteFile(path, plist, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(plutil, "-lint", path).CombinedOutput()
	if err != nil {
		t.Fatalf("plutil -lint: %v\n%s", err, out)
	}
	if !bytes.HasSuffix(bytes.TrimSpace(out), []byte(": OK")) {
		t.Fatalf("plutil -lint said %q", out)
	}
	out, err = exec.Command(plutil, "-convert", "json", "-o", "-", path).Output()
	if err != nil {
		t.Fatalf("plutil -convert json: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("decode plutil output %q: %v", out, err)
	}
	return m
}

func TestPlistParsesWithPlutil(t *testing.T) {
	p, _ := PathsFor("/")
	plist, err := PlistXML(p, 501)
	if err != nil {
		t.Fatal(err)
	}
	got := plutilJSON(t, plist)
	want := map[string]any{
		"Label": "io.github.zahidnoor7.mergelane.daemon",
		"ProgramArguments": []any{
			"/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon", "run", "--allowed-uid", "501",
		},
		"RunAtLoad":                   true,
		"KeepAlive":                   true,
		"ThrottleInterval":            float64(1),
		"ProcessType":                 "Interactive",
		"StandardOutPath":             "/Library/Logs/Mergelane/daemon.log",
		"StandardErrorPath":           "/Library/Logs/Mergelane/daemon.log",
		"AssociatedBundleIdentifiers": "io.github.zahidnoor7.mergelane",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("plutil read\n%#v\nwant\n%#v", got, want)
	}
}

func TestPlistEscapesPaths(t *testing.T) {
	p, err := PathsFor(`/tmp/a&b<c>"d'e]]>`)
	if err != nil {
		t.Fatal(err)
	}
	plist, err := PlistXML(p, 502)
	if err != nil {
		t.Fatal(err)
	}
	got := plutilJSON(t, plist)
	args, _ := got["ProgramArguments"].([]any)
	if len(args) != 4 || args[0] != p.Binary || args[3] != "502" {
		t.Errorf("ProgramArguments = %#v, want [%q run --allowed-uid 502]", args, p.Binary)
	}
	if got["StandardOutPath"] != p.Log {
		t.Errorf("StandardOutPath = %v, want %q", got["StandardOutPath"], p.Log)
	}
}
