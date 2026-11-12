//go:build !windows

package main

import "github.com/ZahidNoor7/mergelane/daemon/internal/api"

// listenAPI serves the control socket, which root and the allowed user may use (authorizer).
func listenAPI(c runConfig, h api.Handler) (runServer, error) {
	srv, err := api.Listen(c.socketPath, 0o666, authorizer(c.allowedUID), h)
	if err != nil {
		return nil, err
	}
	return srv, nil
}

// runPlatform runs the daemon: on macOS launchd starts it as a plain process.
func runPlatform(c runConfig, d runDeps) error { return runDaemon(c, d) }
