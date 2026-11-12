// Package platform holds the Windows process plumbing the daemon needs: the administrator check,
// the single-instance lock and log redirection.
package platform

import (
	"log"
	"os"

	"golang.org/x/sys/windows"
)

// IsAdmin reports whether this process may create the adapter and its routes, i.e. runs elevated.
func IsAdmin() bool { return windows.GetCurrentProcessToken().IsElevated() }

// mutexName is the single-instance lock: a named mutex in the Global namespace, so every session
// sees it, released by Windows when the process dies.
var mutexName = `Global\mergelane-daemon` // a var only so the tests can use their own

// SingleInstance is false if another mergelane-daemon already owns the adapter.
// The mutex handle is intentionally kept for the life of the process.
func SingleInstance() bool {
	name, _ := windows.UTF16PtrFromString(mutexName)
	_, err := windows.CreateMutex(nil, false, name)
	return err != windows.ERROR_ALREADY_EXISTS
}

// InstanceRunning reports whether a mergelane-daemon holds the mutex. From a normal process
// OpenMutex is denied rather than succeeding, which also means it exists.
func InstanceRunning() bool {
	name, _ := windows.UTF16PtrFromString(mutexName)
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
	if err == nil {
		windows.CloseHandle(h)
		return true
	}
	return err == windows.ERROR_ACCESS_DENIED
}

// RedirectStd points stdout/stderr (including the runtime's panic output) at f, for a process
// started with no console (a service).
func RedirectStd(f *os.File) {
	os.Stdout, os.Stderr = f, f
	log.SetOutput(f) // the std logger captured the old stderr at init
	windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(f.Fd()))
	windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
}
