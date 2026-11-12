package main

import (
	"context"
	"sync"

	"golang.org/x/sys/windows/svc"

	"github.com/ZahidNoor7/mergelane/daemon/internal/logx"
	"github.com/ZahidNoor7/mergelane/daemon/internal/winsvc"
)

// runPlatform runs the daemon. Started by the Service Control Manager (the installed service), it
// runs as a service: Windows' Stop and the shutdown of the PC end it the way Ctrl+C ends it in a
// console. Started from a console, it runs as a plain process.
func runPlatform(c runConfig, d runDeps) error {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return runDaemon(c, d)
	}
	h := &serviceHandler{c: c, d: d, run: runDaemon}
	if err := svc.Run(winsvc.Name, h); err != nil {
		return err
	}
	return h.result()
}

// serviceHandler is the service's control handler (svc.Handler).
type serviceHandler struct {
	c   runConfig
	d   runDeps
	run func(runConfig, runDeps) error

	mu  sync.Mutex
	err error
}

func (h *serviceHandler) result() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.err
}

// Execute runs the daemon until Windows asks the service to stop, or the daemon ends by itself. A
// daemon that ends with an error reports a service-specific exit code, which counts as a failure for
// the service's recovery actions (winsvc.Configure turns them on for such failures too).
func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d := h.d
	d.signalContext = func() (context.Context, context.CancelFunc) { return context.WithCancel(ctx) }
	status <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() { done <- h.run(h.c, d) }()
	const accepts = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.Running, Accepts: accepts}
	for {
		select {
		case err := <-done:
			h.mu.Lock()
			h.err = err
			h.mu.Unlock()
			if err != nil {
				logx.Printf("mergelane-daemon: %v\n", err)
				return true, 1
			}
			return false, 0
		case r := <-requests:
			switch r.Cmd {
			case svc.Interrogate:
				status <- r.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
			}
		}
	}
}
