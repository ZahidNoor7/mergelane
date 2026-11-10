// Package platform holds the macOS process plumbing the daemon needs: the root check, the
// single-instance lock and log redirection.
package platform

import (
	"log"
	"os"

	"golang.org/x/sys/unix"
)

// IsAdmin reports whether this process may create the utun and its routes, i.e. runs as root.
func IsAdmin() bool { return os.Geteuid() == 0 }

// The single-instance lock is a flock on a root-created file: visible to every user, and
// released by the kernel when the process dies, so a crash never leaves a stale lock behind.
const lockPath = "/var/run/mergelane-daemon.lock"

// lockFile is never read: holding the reference keeps the locked file open (and the lock held)
// for the life of the process.
//
//lint:ignore U1000 the reference itself is the point
var lockFile *os.File

// SingleInstance is false if another mergelane-daemon already owns the utun.
// The file is intentionally kept open for the life of the process.
func SingleInstance() bool {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return false
	}
	if unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		f.Close()
		return false
	}
	lockFile = f
	return true
}

// InstanceRunning reports whether a mergelane-daemon holds the lock; works for any user, since the
// file is world-readable and flock doesn't need write access.
func InstanceRunning() bool {
	f, err := os.Open(lockPath)
	if err != nil {
		return false
	}
	defer f.Close()
	if unix.Flock(int(f.Fd()), unix.LOCK_SH|unix.LOCK_NB) != nil {
		return true
	}
	unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return false
}

// RedirectStd points stdout/stderr (including the runtime's panic output) at f, for a process
// started with no terminal (launchd).
func RedirectStd(f *os.File) {
	os.Stdout, os.Stderr = f, f
	log.SetOutput(f) // the std logger captured the old stderr at init
	unix.Dup2(int(f.Fd()), 1)
	unix.Dup2(int(f.Fd()), 2)
}
