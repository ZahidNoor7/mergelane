package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"

	"github.com/ZahidNoor7/mergelane/daemon/internal/api"
)

var pipeCount atomic.Int32

func currentSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

// testSocket gives a run a pipe of its own, which this user may open.
func testSocket(t *testing.T, c *runConfig) {
	t.Helper()
	c.socketPath = fmt.Sprintf(`\\.\pipe\mergelane-daemon-test-%d-%d`, os.Getpid(), pipeCount.Add(1))
	c.allowedSID = currentSID(t)
}

// serve starts the control API on a pipe of its own.
func serve(t *testing.T, h api.Handler) string {
	t.Helper()
	var c runConfig
	testSocket(t, &c)
	srv, err := api.ListenPipe(c.socketPath, c.allowedSID, h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	return c.socketPath
}

// checkSocketListening: the pipe answers.
func checkSocketListening(t *testing.T, path string) {
	t.Helper()
	cl, err := api.Dial(path)
	if err != nil {
		t.Errorf("the pipe doesn't answer: %v", err)
		return
	}
	cl.Close()
}

func socketGone(path string) error {
	if cl, err := api.Dial(path); err == nil {
		cl.Close()
		return errors.New(path + " still answers")
	}
	return nil
}

// breakSocket makes the pipe impossible to create: it would let everyone in.
func breakSocket(c *runConfig) { c.allowedSID = "S-1-1-0" }

const brokenSocket = "not a user account's security identifier"

// A user the pipe isn't made for can't open it: Windows refuses before the daemon sees them. The kit
// runs as a normal user, so administrators' access doesn't let it in either.
func TestRunDaemonPipeRefusesOtherUsers(t *testing.T) {
	if windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("running as administrator, which is always allowed")
	}
	h := newHarness(t)
	h.cfg.allowedSID = "S-1-5-21-1-2-3-1001" // someone else
	errc := h.start(t)
	_, err := api.Dial(h.cfg.socketPath)
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Errorf("Dial by another user = %v, want access denied", err)
	}
	h.shutdown(t, errc)
	assertEvents(t, h, "read routes", "cleanup", "warm", "listen", "server close", "close")
}

// The service handler runs the daemon until Windows asks it to stop, answering Interrogate meanwhile.
func TestServiceHandlerStopsOnRequest(t *testing.T) {
	ran := make(chan context.Context, 1)
	h := &serviceHandler{run: func(_ runConfig, d runDeps) error {
		ctx, cancel := d.signalContext()
		defer cancel()
		ran <- ctx
		<-ctx.Done()
		return nil
	}}
	requests, status := make(chan svc.ChangeRequest), make(chan svc.Status, 8)
	result := make(chan [2]any, 1)
	go func() {
		specific, code := h.Execute(nil, requests, status)
		result <- [2]any{specific, code}
	}()
	if s := <-status; s.State != svc.StartPending {
		t.Fatalf("first status %v, want StartPending", s.State)
	}
	if s := <-status; s.State != svc.Running || s.Accepts&svc.AcceptStop == 0 {
		t.Fatalf("second status %+v, want Running, accepting Stop", s)
	}
	ctx := <-ran
	requests <- svc.ChangeRequest{Cmd: svc.Interrogate, CurrentStatus: svc.Status{State: svc.Running}}
	if s := <-status; s.State != svc.Running {
		t.Errorf("Interrogate answered %v", s.State)
	}
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	if s := <-status; s.State != svc.StopPending {
		t.Errorf("Stop answered %v, want StopPending", s.State)
	}
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Stop didn't end the daemon's context")
	}
	if r := <-result; r[0] != false || r[1] != uint32(0) {
		t.Errorf("Execute = %v, want false, 0", r)
	}
	if h.result() != nil {
		t.Errorf("result = %v", h.result())
	}
}

// A daemon that fails on its own reports a service-specific exit code, so Windows' recovery restarts it.
func TestServiceHandlerReportsAFailure(t *testing.T) {
	h := &serviceHandler{run: func(runConfig, runDeps) error { return errors.New("mergelane-daemon is already running") }}
	status := make(chan svc.Status, 8)
	specific, code := h.Execute(nil, make(chan svc.ChangeRequest), status)
	if !specific || code != 1 || h.result() == nil || !strings.Contains(h.result().Error(), "already running") {
		t.Errorf("Execute = %v, %d; result %v", specific, code, h.result())
	}
}
