package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ZahidNoor7/mergelane/daemon/internal/nmhost"
)

const pong = `{"ok":true,"app":"mergelane","version":"t","api":2}`

// app listens on a short temp socket path (sun_path is 104 bytes on macOS) and answers every request
// with pong, sending each request line it received to got.
func app(t *testing.T) (path string, got <-chan string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nmh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path = filepath.Join(dir, "browser.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	lines := make(chan string, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(conn).ReadString('\n')
			lines <- line
			io.WriteString(conn, pong+"\n")
			conn.Close()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		<-done
	})
	return path, lines
}

func frame(msg string) []byte {
	return append(binary.NativeEndian.AppendUint32(nil, uint32(len(msg))), msg...)
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func readFrames(t *testing.T, b []byte) []string {
	t.Helper()
	r := bytes.NewReader(b)
	var out []string
	for {
		msg, err := nmhost.ReadMessage(r)
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("stdout holds something other than frames: %v", err)
		}
		out = append(out, string(msg))
	}
}

func TestVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, env(nil), strings.NewReader(""), &stdout, &stderr)
	if code != 0 || stdout.String() != "mergelane-nmhost dev\n" || stderr.Len() != 0 {
		t.Errorf("code = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}
}

func TestRun(t *testing.T) {
	// The browser that started the host, as ps would name it.
	defer func(real func() string) { parentApp = real }(parentApp)
	parentApp = func() string { return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
	const browser = `"browser":"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",`
	path, got := app(t)
	missing := filepath.Join(filepath.Dir(path), "missing.sock")
	const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
	tests := []struct {
		name     string
		args     []string
		socket   string
		in       []byte
		wantCode int
		want     []string
		wantLine string // the request the app should get; "" means none
	}{
		{"empty stdin", []string{origin}, path, nil, 0, nil, ""},
		{"chrome ping", []string{origin}, path, frame(`{"type":"ping"}`), 0, []string{pong},
			`{"v":3,"origin":"` + origin + `",` + browser + `"message":{"type":"ping"}}` + "\n"},
		{"firefox ping", []string{"/x/io.github.zahidnoor7.mergelane.json", "mergelane@zahidnoor7.github.io"}, path,
			frame(`{"type":"ping"}`), 0, []string{pong},
			`{"v":3,"origin":"mergelane@zahidnoor7.github.io",` + browser + `"message":{"type":"ping"}}` + "\n"},
		{"bad message", []string{origin}, path, frame(`[]`), 0, []string{`{"ok":false,"error":"bad-message"}`}, ""},
		{"app not running", []string{origin}, missing, frame(`{"type":"add","request":{}}`), 0,
			[]string{`{"ok":false,"error":"unavailable"}`}, ""},
		{"oversize message exits non-zero", []string{origin}, path, binary.NativeEndian.AppendUint32(nil, 1<<20+1), 1,
			[]string{`{"ok":false,"error":"bad-message"}`}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// NO_LAUNCH guards against ever starting the real app; no case here sends wake.
			getenv := env(map[string]string{nmhost.EnvSocket: tt.socket, nmhost.EnvNoLaunch: "1"})
			var stdout, stderr bytes.Buffer
			code := run(tt.args, getenv, bytes.NewReader(tt.in), &stdout, &stderr)
			if code != tt.wantCode {
				t.Errorf("exit code = %d, want %d (stderr: %s)", code, tt.wantCode, stderr.String())
			}
			answers := readFrames(t, stdout.Bytes())
			if strings.Join(answers, "|") != strings.Join(tt.want, "|") {
				t.Errorf("answers = %q, want %q", answers, tt.want)
			}
			if tt.wantLine != "" {
				if line := <-got; line != tt.wantLine {
					t.Errorf("app got %q, want %q", line, tt.wantLine)
				}
			}
			if tt.wantCode != 0 && !strings.Contains(stderr.String(), "mergelane-nmhost:") {
				t.Errorf("stderr = %q, want the error", stderr.String())
			}
		})
	}
	select {
	case line := <-got:
		t.Errorf("app got an unexpected request %q", line)
	default:
	}
}

func TestParentAppIsTheRealParent(t *testing.T) {
	// The default reads the test's own parent through ps: some executable, never empty.
	if got := parentApp(); got == "" {
		t.Error("parentApp() is empty for a running parent")
	}
}
