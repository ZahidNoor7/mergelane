package api

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func currentUserSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

// On the laptop (the test kit): the user the pipe is made for reaches the handler through it, a second
// server can't take the same name, and Close removes it.
func TestPipeServesItsUser(t *testing.T) {
	path := fmt.Sprintf(`\\.\pipe\mergelane-daemon-test-%d`, os.Getpid())
	s, err := ListenPipe(path, currentUserSID(t), &fakeHandler{})
	if err != nil {
		t.Fatalf("ListenPipe: %v", err)
	}
	if _, err := ListenPipe(path, currentUserSID(t), &fakeHandler{}); err == nil {
		t.Error("a second ListenPipe on the same name succeeded")
	}
	cl, err := Dial(path)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := cl.Status(ctx); err != nil {
		t.Errorf("Status over the pipe: %v", err)
	}
	cl.Close()
	if err := s.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if cl, err := Dial(path); err == nil {
		cl.Close()
		t.Error("the pipe still answers after Close")
	}
}

func TestListenPipeRefusesABadSID(t *testing.T) {
	if _, err := ListenPipe(`\\.\pipe\mergelane-daemon-test-bad`, "S-1-1-0", &fakeHandler{}); err == nil {
		t.Error("ListenPipe allowed Everyone")
	}
	if _, err := ListenPipe(`\\.\pipe\mergelane-daemon-test-bad`, currentUserSID(t), nil); err == nil {
		t.Error("ListenPipe took a nil handler")
	}
}
