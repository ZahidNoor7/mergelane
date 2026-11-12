package main

import "github.com/ZahidNoor7/mergelane/daemon/internal/api"

// listenAPI serves the control pipe, which SYSTEM, administrators and the allowed user may open
// (api.PipeSDDL).
func listenAPI(c runConfig, h api.Handler) (runServer, error) {
	srv, err := api.ListenPipe(c.socketPath, c.allowedSID, h)
	if err != nil {
		return nil, err
	}
	return srv, nil
}
