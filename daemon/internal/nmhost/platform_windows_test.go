package nmhost

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsSocketPathIsTheAppsPipe(t *testing.T) {
	appData := `C:\Users\Alex\AppData\Roaming`
	got := SocketPath(env(map[string]string{"APPDATA": appData}))
	if want := PipeName(filepath.Join(appData, "Mergelane")); got != want {
		t.Errorf("SocketPath = %q, want %q", got, want)
	}
	if got := SocketPath(env(map[string]string{EnvSocket: `\\.\pipe\x`, "APPDATA": appData})); got != `\\.\pipe\x` {
		t.Errorf("the override lost: %q", got)
	}
	if got := SocketPath(env(nil)); got != "" {
		t.Errorf("SocketPath without APPDATA = %q, want empty", got)
	}
}

// pipeServer serves one connection on a new pipe the way the app does: it reads a line and answers with one.
func pipeServer(t *testing.T, name, answer string) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateNamedPipe(p, windows.PIPE_ACCESS_DUPLEX,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT, 1, 4096, 4096, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		defer windows.CloseHandle(h)
		if err := windows.ConnectNamedPipe(h, nil); err != nil && !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
			return
		}
		f := os.NewFile(uintptr(h), name)
		if _, err := bufio.NewReader(f).ReadString('\n'); err != nil {
			return
		}
		f.Write([]byte(answer + "\n"))
		windows.FlushFileBuffers(h)
		windows.DisconnectNamedPipe(h)
	}()
}

func TestDialPipeExchangesWithTheApp(t *testing.T) {
	name := fmt.Sprintf(`\\.\pipe\mergelane-test-%d`, os.Getpid())
	pipeServer(t, name, `{"ok":true}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialPipe(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if conn.LocalAddr().Network() != "pipe" || conn.RemoteAddr().String() != name {
		t.Errorf("addresses %v %v", conn.LocalAddr(), conn.RemoteAddr())
	}
	// Deadlines work: the file is opened overlapped (go doc os.NewFile).
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("SetDeadline: %v", err)
	}
	if _, err := conn.Write([]byte(`{"v":3}` + "\n")); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != `{"ok":true}` {
		t.Fatalf("answer %q, %v", line, err)
	}
}

func TestDialPipeWithoutTheApp(t *testing.T) {
	_, err := dialPipe(context.Background(), `\\.\pipe\mergelane-test-nobody-here`)
	if err == nil || !strings.Contains(err.Error(), "mergelane-test-nobody-here") {
		t.Errorf("dialPipe to a missing pipe = %v, want an error naming it", err)
	}
}

func TestParentAppNamesARealProcess(t *testing.T) {
	if got := ParentApp(context.Background(), os.Getpid()); !strings.HasSuffix(strings.ToLower(got), ".exe") {
		t.Errorf("ParentApp(own pid) = %q, want this test program", got)
	}
	if got := ParentApp(context.Background(), 0); got != "" {
		t.Errorf("ParentApp(0) = %q", got)
	}
	if got := ParentApp(context.Background(), 1<<30); got != "" {
		t.Errorf("ParentApp(missing) = %q", got)
	}
}

func TestOpenAppStartsMergelaneOutOfTheJob(t *testing.T) {
	oldExe, oldStart := appExe, start
	defer func() { appExe, start = oldExe, oldStart }()
	appExe = func() (string, error) { return `C:\Program Files\Mergelane\Mergelane.exe`, nil }
	var calls []uint32
	start = func(name string, flags uint32) error {
		if name != `C:\Program Files\Mergelane\Mergelane.exe` {
			t.Errorf("started %q", name)
		}
		calls = append(calls, flags)
		return nil
	}
	if err := OpenApp(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0]&windows.CREATE_BREAKAWAY_FROM_JOB == 0 {
		t.Errorf("calls %#x, want one with CREATE_BREAKAWAY_FROM_JOB", calls)
	}

	// A job that forbids breaking away refuses the flag: then it starts inside the job.
	calls = nil
	start = func(_ string, flags uint32) error {
		calls = append(calls, flags)
		if flags&windows.CREATE_BREAKAWAY_FROM_JOB != 0 {
			return windows.ERROR_ACCESS_DENIED
		}
		return nil
	}
	if err := OpenApp(context.Background()); err != nil || len(calls) != 2 || calls[1] != windows.DETACHED_PROCESS {
		t.Errorf("fallback: %v, calls %#x", err, calls)
	}

	appExe = func() (string, error) { return "", errors.New("no executable") }
	if err := OpenApp(context.Background()); err == nil {
		t.Error("OpenApp without its own path succeeded")
	}
}

func TestAppExeIsBesideTheResourcesFolder(t *testing.T) {
	exe, err := oldAppExe()
	if err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	if want := filepath.Join(filepath.Dir(filepath.Dir(self)), "Mergelane.exe"); exe != want {
		t.Errorf("appExe = %q, want %q", exe, want)
	}
}

// oldAppExe is appExe as built, whatever a test set it to.
var oldAppExe = appExe
