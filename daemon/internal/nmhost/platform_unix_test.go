//go:build !windows

package nmhost

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSocketPath(t *testing.T) {
	tests := []struct {
		name string
		vars map[string]string
		want string
	}{
		{"override wins", map[string]string{EnvSocket: "/tmp/x.sock", "HOME": "/Users/me"}, "/tmp/x.sock"},
		{"default under HOME", map[string]string{"HOME": "/Users/me"}, "/Users/me/Library/Application Support/Mergelane/browser.sock"},
		{"neither set", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SocketPath(env(tt.vars)); got != tt.want {
				t.Errorf("SocketPath = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestOpenAppCommand(t *testing.T) {
	want := []string{"/usr/bin/open", "-g", "-b", "io.github.zahidnoor7.mergelane"}
	if !reflect.DeepEqual(openArgv, want) {
		t.Errorf("openArgv = %q, want %q", openArgv, want)
	}
}

func TestParentApp(t *testing.T) {
	if got := ParentApp(context.Background(), os.Getpid()); !strings.Contains(got, "nmhost") {
		t.Errorf("ParentApp(own pid) = %q, want the test binary", got)
	}
	if got := ParentApp(context.Background(), 0); got != "" {
		t.Errorf("ParentApp(0) = %q, want empty", got)
	}
	// A pid no process has: ps fails, and nothing is guessed.
	if got := ParentApp(context.Background(), 1<<30); got != "" {
		t.Errorf("ParentApp(missing) = %q, want empty", got)
	}
}
