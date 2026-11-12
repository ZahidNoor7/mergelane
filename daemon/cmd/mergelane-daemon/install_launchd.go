//go:build !windows

package main

import (
	"context"
	"flag"
	"fmt"
	"io"

	"github.com/ZahidNoor7/mergelane/daemon/internal/launchd"
	"github.com/ZahidNoor7/mergelane/daemon/internal/tun"
)

// adminWord is who requireRoot asks for.
const adminWord = "root"

func cmdInstall(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	uid := fs.Int("uid", 0, "the console user's uid (the app passes its own)")
	source := fs.String("source", "", "binary to install (default: this one)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	src, err := installSource(*source)
	if err != nil {
		return err
	}
	if err := launchd.Install(context.Background(), launchd.Options{Source: src, UID: *uid}); err != nil {
		return err
	}
	fmt.Fprintln(out, "installed", launchd.Label)
	return nil
}

func cmdUninstall(_ []string, out io.Writer) error {
	res, err := launchd.Uninstall(context.Background(), launchd.Options{
		Cleanup: func(context.Context, []string) error { tun.CleanupStale(); return nil },
	})
	if err != nil {
		return err
	}
	if res.Hint != "" {
		fmt.Fprintln(out, res.Hint)
	}
	fmt.Fprintln(out, "uninstalled", launchd.Label)
	return nil
}
