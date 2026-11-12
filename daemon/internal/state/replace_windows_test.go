package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// holdOpen opens path the way a reader that blocks renames does: shared for reading only, so
// Windows refuses to replace the file until the handle is closed.
func holdOpen(t *testing.T, path string) windows.Handle {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func files(t *testing.T) (tmp, dst string) {
	t.Helper()
	dir := t.TempDir()
	tmp, dst = filepath.Join(dir, "prefs.json.tmp"), filepath.Join(dir, "prefs.json")
	if err := os.WriteFile(dst, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	return tmp, dst
}

func want(t *testing.T, path, content string) {
	t.Helper()
	if b, err := os.ReadFile(path); err != nil || string(b) != content {
		t.Errorf("%s = %q, %v; want %q", filepath.Base(path), b, err, content)
	}
}

func TestReplaceFileReplaces(t *testing.T) {
	tmp, dst := files(t)
	if err := replaceFile(tmp, dst); err != nil {
		t.Fatal(err)
	}
	want(t, dst, "new")
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("the temporary file is still there: %v", err)
	}
}

func TestReplaceFileWaitsForAReader(t *testing.T) {
	tmp, dst := files(t)
	h := holdOpen(t, dst)
	go func() {
		time.Sleep(100 * time.Millisecond)
		windows.CloseHandle(h)
	}()
	if err := replaceFile(tmp, dst); err != nil {
		t.Fatalf("replaceFile with a reader that closes after 100 ms: %v", err)
	}
	want(t, dst, "new")
}

func TestReplaceFileGivesUpAfterASecond(t *testing.T) {
	tmp, dst := files(t)
	h := holdOpen(t, dst)
	defer windows.CloseHandle(h)
	start := time.Now()
	err := replaceFile(tmp, dst)
	if err == nil {
		t.Fatal("replaceFile succeeded while the file was held open")
	}
	if took := time.Since(start); took < time.Second || took > 5*time.Second {
		t.Errorf("gave up after %v, want about a second", took)
	}
	want(t, dst, "old")
}

func TestReplaceFileReportsOtherErrorsAtOnce(t *testing.T) {
	dir := t.TempDir()
	start := time.Now()
	if err := replaceFile(filepath.Join(dir, "missing"), filepath.Join(dir, "dst")); err == nil {
		t.Fatal("replaceFile of a missing file succeeded")
	}
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Errorf("a missing file took %v to fail; it must not wait", took)
	}
}
