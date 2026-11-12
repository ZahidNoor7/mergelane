package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"time"

	"golang.org/x/sys/windows"

	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
	"github.com/ZahidNoor7/mergelane/daemon/internal/state"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
	"github.com/ZahidNoor7/mergelane/daemon/internal/winsvc"
)

// adminWord is who requireRoot asks for.
const adminWord = "administrator"

// serviceTimeout bounds waiting for the service to stop or start.
const serviceTimeout = 60 * time.Second

// windowsPaths is where the service's files go: %ProgramFiles%\Mergelane, and the log in the state
// folder.
func windowsPaths() (winsvc.Paths, error) {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return winsvc.Paths{}, fmt.Errorf("finding Program Files: %w", err)
	}
	return winsvc.PathsFor(pf, state.DefaultDir()), nil
}

func cmdInstall(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	sid := fs.String("user-sid", "", "the security identifier of the user the app runs as (the app passes its own)")
	source := fs.String("source", "", "program to install, with wintun.dll beside it (default: this one)")
	report := fs.String("report", "", `write "ok" or the error to this new file (the app reads it)`)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return reported(*report, func() error {
		if err := requireRoot("install", platform.IsAdmin); err != nil {
			return err
		}
		src, err := installSource(*source)
		if err != nil {
			return err
		}
		paths, err := windowsPaths()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), serviceTimeout)
		defer cancel()
		if err := winsvc.Install(ctx, winsvc.Options{Source: src, UserSID: *sid, Paths: paths, Manager: winsvc.SCM{}}); err != nil {
			return err
		}
		fmt.Fprintln(out, "installed", winsvc.Name)
		return nil
	})
}

func cmdUninstall(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	report := fs.String("report", "", `write "ok" or the error to this new file (the app reads it)`)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return reported(*report, func() error {
		if err := requireRoot("uninstall", platform.IsAdmin); err != nil {
			return err
		}
		paths, err := windowsPaths()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), serviceTimeout)
		defer cancel()
		if err := winsvc.Uninstall(ctx, winsvc.Options{Paths: paths, Manager: winsvc.SCM{}, Cleanup: tun.CleanupStale}); err != nil {
			return err
		}
		fmt.Fprintln(out, "uninstalled", winsvc.Name)
		return nil
	})
}
