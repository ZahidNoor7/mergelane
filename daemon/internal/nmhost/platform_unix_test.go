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

// runCommand only runs on macOS (OpenApp, platform_unix.go).
func TestRunCommand(t *testing.T) {
	tests := []struct {
		name    string
		argv    []string
		wantErr string // "" means success
	}{
		{"success", []string{"/usr/bin/true"}, ""},
		{"failure without output", []string{"/usr/bin/false"}, "/usr/bin/false: exit status 1"},
		{"failure with output", []string{"/bin/sh", "-c", "echo nope >&2; exit 3"}, "/bin/sh: exit status 3: nope"},
		{"missing program", []string{"/nonexistent/open"}, "/nonexistent/open"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := runCommand(context.Background(), tt.argv)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("err = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}
