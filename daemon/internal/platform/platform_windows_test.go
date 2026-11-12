package platform

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// The single-instance mutex, under a name of the test's own so a real helper is never involved.
// Local\ keeps it in this session's namespace.
func TestSingleInstance(t *testing.T) {
	old := mutexName
	defer func() { mutexName = old }()
	mutexName = fmt.Sprintf(`Local\mergelane-daemon-test-%d`, os.Getpid())

	if InstanceRunning() {
		t.Fatal("InstanceRunning before any instance")
	}
	if !SingleInstance() {
		t.Fatal("the first SingleInstance was refused")
	}
	if !InstanceRunning() {
		t.Error("InstanceRunning is false while this process holds the mutex")
	}
	if SingleInstance() {
		t.Error("a second SingleInstance was allowed")
	}
}

func TestIsAdminMatchesTheToken(t *testing.T) {
	// The test kit refuses to run elevated, so there this is false; elsewhere it must at least
	// agree with the token's own answer.
	if got, want := IsAdmin(), windows.GetCurrentProcessToken().IsElevated(); got != want {
		t.Errorf("IsAdmin = %v, token says %v", got, want)
	}
}

func TestRedirectStd(t *testing.T) {
	oldOut, oldErr, oldLog := os.Stdout, os.Stderr, log.Writer()
	hOut, _ := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	hErr, _ := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	f, err := os.Create(filepath.Join(t.TempDir(), "daemon.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	RedirectStd(f)
	fmt.Fprint(os.Stdout, "stdout ")
	fmt.Fprint(os.Stderr, "stderr ")
	log.Print("log")
	// What the runtime writes on a crash goes to the process's standard handle, not os.Stderr.
	if h, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE); err == nil {
		var n uint32
		windows.WriteFile(h, []byte(" handle"), &n, nil)
	}

	os.Stdout, os.Stderr = oldOut, oldErr
	log.SetOutput(oldLog)
	windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, hOut)
	windows.SetStdHandle(windows.STD_ERROR_HANDLE, hErr)

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	for _, s := range []string{"stdout", "stderr", "log", "handle"} {
		if !strings.Contains(string(b), s) {
			t.Errorf("the log file lacks %q: %q", s, b)
		}
	}
}
