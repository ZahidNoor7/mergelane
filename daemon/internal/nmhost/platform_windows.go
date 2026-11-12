package nmhost

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// defaultDial reaches the app's named pipe (pipe_windows.go).
var defaultDial = dialPipe

// ParentApp returns the full path of process pid's executable, the browser that started the host, or "" when it
// can't be read. QueryFullProcessImageName needs only PROCESS_QUERY_LIMITED_INFORMATION (Microsoft Learn). Edge
// may start the host through cmd.exe (its NativeHostsExecutablesLaunchDirectly policy), which this then names.
func ParentApp(_ context.Context, pid int) string {
	if pid <= 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &size) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}

// SocketPath returns the app's browser pipe: $MERGELANE_BROWSER_SOCKET, else the pipe named after the app's
// own folder, %APPDATA%\Mergelane (PipeName). It returns "" when neither is set.
func SocketPath(getenv func(string) string) string {
	if p := getenv(EnvSocket); p != "" {
		return p
	}
	appData := getenv("APPDATA")
	if appData == "" {
		return ""
	}
	return PipeName(filepath.Join(appData, "Mergelane"))
}

// appExe is Mergelane.exe, next to the resources folder the host runs from (electron-builder's layout:
// <install>\resources\mergelane-nmhost.exe and <install>\Mergelane.exe). A variable for tests.
var appExe = func() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(filepath.Dir(self)), "Mergelane.exe"), nil
}

// launchFlags lets Mergelane outlive the host. "On Windows, the browser puts the native application's process
// into a Job object and kills the job"; a process meant to stay open "must launch the additional process with
// the CREATE_BREAKAWAY_FROM_JOB flag" (MDN, "Native messaging"). DETACHED_PROCESS keeps it off the host's
// console.
const launchFlags = windows.CREATE_BREAKAWAY_FROM_JOB | windows.DETACHED_PROCESS

// start runs a command without waiting for it; a variable for tests.
var start = func(name string, flags uint32) error {
	cmd := exec.Command(name)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags, HideWindow: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// OpenApp starts Mergelane.exe, out of the browser's job where the job allows it, and in it otherwise (a job
// that forbids breaking away refuses the flag). It returns once the process has started, not when the app is
// ready.
func OpenApp(context.Context) error {
	exe, err := appExe()
	if err != nil {
		return err
	}
	if err := start(exe, launchFlags); err == nil {
		return nil
	}
	return start(exe, windows.DETACHED_PROCESS)
}
