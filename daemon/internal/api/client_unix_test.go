//go:build !windows

package api

import (
	"context"
	"testing"
	"time"
)

// The Unix socket refuses by the caller's uid (startServer's authorizer). On Windows the pipe's ACL does that
// instead, before a connection exists (pipe_windows_test.go).
func TestClientNotAuthorized(t *testing.T) {
	s := startServer(t, &fakeHandler{}, func(uint32) bool { return false })
	ctx := context.Background()
	for range 20 { // the refusal may land before or after the request is written
		c := dialClient(t, s)
		if _, err := c.Status(ctx); !isCode(err, CodeNotAuthorized) {
			t.Fatalf("got %v", err)
		}
		if _, err := c.Status(ctx); !isCode(err, CodeNotAuthorized) {
			t.Fatalf("second call: %v", err)
		}
	}
	// Refused before the request is even written: the client still reports NOT_AUTHORIZED.
	c := dialClient(t, s)
	time.Sleep(50 * time.Millisecond)
	if _, err := c.Status(ctx); !isCode(err, CodeNotAuthorized) {
		t.Fatalf("late request: %v", err)
	}
}
