// Package winsvc installs, updates and removes mergelane-daemon as a Windows service (ADR-0059), the
// Windows counterpart of package launchd.
//
// The app runs `mergelane-daemon.exe install` once, elevated by a UAC prompt (CLAUDE.md, Architecture).
// The program and wintun.dll are copied into %ProgramFiles%\Mergelane, which only administrators may
// change: the app itself lives in the user's own, writable folder, and a service running as SYSTEM must
// never run a file a normal user can replace. The service starts automatically at boot, runs as
// LocalSystem, and Windows restarts it after a crash (Manager.Configure), whose first job is to clean up
// what the crashed run left (run.go). Its log and state stay in %ProgramData%\Mergelane\daemon.
//
// Every step against the Service Control Manager goes through a Manager, so the order of the steps is
// tested on any platform; manager_windows.go is the real one.
package winsvc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
)

const (
	// Name is the service's name (`sc query mergelane-daemon`).
	Name = "mergelane-daemon"
	// DisplayName is what Services (services.msc) shows.
	DisplayName = "Mergelane helper"
	// Description is the service's description in Services.
	Description = "Merges every internet connection this PC has, for all apps (Mergelane's system merge). " +
		"Mergelane installs and removes it."
	// BinaryName and WintunName are the installed files.
	BinaryName = "mergelane-daemon.exe"
	WintunName = "wintun.dll"
)

// Paths are where the service's files live.
type Paths struct {
	Dir    string // %ProgramFiles%\Mergelane
	Binary string // Dir\mergelane-daemon.exe
	Wintun string // Dir\wintun.dll, which Wintun loads from the program's own folder
	Log    string // the state folder's daemon.log
}

// PathsFor lays the files out under programFiles, with the log in stateDir.
func PathsFor(programFiles, stateDir string) Paths {
	dir := filepath.Join(programFiles, "Mergelane")
	return Paths{
		Dir:    dir,
		Binary: filepath.Join(dir, BinaryName),
		Wintun: filepath.Join(dir, WintunName),
		Log:    filepath.Join(stateDir, "daemon.log"),
	}
}

// Args are the service's arguments: `run`, the one user allowed on its pipe, and the log.
func Args(p Paths, userSID string) []string {
	return []string{"run", "--allowed-sid", userSID, "--log", p.Log}
}

// Manager is what Install and Uninstall need from the Service Control Manager. Each method acts on the
// service named Name.
type Manager interface {
	// Stop stops the service if it is running and waits until it has stopped. A service that doesn't
	// exist is already stopped.
	Stop(ctx context.Context) error
	// Configure creates the service, or updates one that exists, to run binary with args: started at
	// boot, as LocalSystem, restarted by Windows after a crash.
	Configure(binary string, args []string) error
	// Start starts the service and waits until it runs.
	Start(ctx context.Context) error
	// Delete removes the service. One that doesn't exist is already removed.
	Delete() error
}

// Options are Install's and Uninstall's inputs.
type Options struct {
	Source  string  // the mergelane-daemon.exe to install; wintun.dll is taken from the same folder
	UserSID string  // the user the app runs as, the only one allowed on the pipe besides administrators
	Paths   Paths   // where the files go
	Manager Manager // the Service Control Manager
	Cleanup func()  // Uninstall: removes what a crashed run left (tun.CleanupStale)
}

// Install copies the program and wintun.dll into place and starts the service, replacing an installed
// one: that one is stopped first, since Windows won't replace a running program. Merging is off in the
// new service until the app asks again.
func Install(ctx context.Context, o Options) error {
	if _, err := api.PipeSDDL(o.UserSID); err != nil {
		return err
	}
	wintun := filepath.Join(filepath.Dir(o.Source), WintunName)
	for _, f := range []string{o.Source, wintun} {
		if fi, err := os.Stat(f); err != nil || !fi.Mode().IsRegular() {
			return fmt.Errorf("install: %s is missing", f)
		}
	}
	if err := o.Manager.Stop(ctx); err != nil {
		return fmt.Errorf("install: stopping the installed helper: %w", err)
	}
	if err := os.MkdirAll(o.Paths.Dir, 0o755); err != nil {
		return fmt.Errorf("install: %w", err)
	}
	for _, c := range [][2]string{{o.Source, o.Paths.Binary}, {wintun, o.Paths.Wintun}} {
		if err := copyFile(c[0], c[1]); err != nil {
			return fmt.Errorf("install: %w", err)
		}
	}
	if err := o.Manager.Configure(o.Paths.Binary, Args(o.Paths, o.UserSID)); err != nil {
		return fmt.Errorf("install: registering the service: %w", err)
	}
	if err := o.Manager.Start(ctx); err != nil {
		return fmt.Errorf("install: starting the service: %w", err)
	}
	return nil
}

// Uninstall stops and removes the service, cleans up anything a crashed run left, and deletes the
// installed files. The log and state folder stay, as the log folder does on macOS.
func Uninstall(ctx context.Context, o Options) error {
	if err := o.Manager.Stop(ctx); err != nil {
		return fmt.Errorf("uninstall: stopping the helper: %w", err)
	}
	if err := o.Manager.Delete(); err != nil {
		return fmt.Errorf("uninstall: removing the service: %w", err)
	}
	if o.Cleanup != nil {
		o.Cleanup()
	}
	for _, f := range []string{o.Paths.Binary, o.Paths.Wintun} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("uninstall: %w", err)
		}
	}
	// Only if empty: anything else in the folder isn't ours to delete.
	if err := os.Remove(o.Paths.Dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		if entries, readErr := os.ReadDir(o.Paths.Dir); readErr != nil || len(entries) == 0 {
			return fmt.Errorf("uninstall: %w", err)
		}
	}
	return nil
}

// copyFile writes src to dst through a temporary file in dst's folder, renamed over dst at the end, so
// a failed copy never leaves half a program behind.
func copyFile(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err = io.Copy(tmp, in); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}
