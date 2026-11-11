package nmhost

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	chromeOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
	firefoxID    = "mergelane@zahidnoor7.github.io"
	firefoxPath  = "/Users/me/Library/Application Support/Mozilla/NativeMessagingHosts/io.github.zahidnoor7.mergelane.json"
	pong         = `{"ok":true,"app":"mergelane","version":"1.2.3","api":2}`
)

// socketPath returns a socket path in a fresh directory under /tmp: macOS's per-user $TMPDIR is too
// long for sun_path (104 bytes in <sys/un.h>).
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nmh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "browser.sock")
}

// fakeApp stands in for Mergelane.app's browser socket. It records each request line and lets
// respond answer it; the connection is closed when respond returns.
type fakeApp struct {
	ln      net.Listener
	respond func(conn net.Conn, line []byte)
	wg      sync.WaitGroup

	mu  sync.Mutex
	got []string
}

func startApp(t *testing.T, path string, respond func(conn net.Conn, line []byte)) *fakeApp {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	a := &fakeApp{ln: ln, respond: respond}
	a.wg.Add(1)
	go a.serve()
	t.Cleanup(func() {
		ln.Close()
		a.wg.Wait()
	})
	return a
}

func (a *fakeApp) serve() {
	defer a.wg.Done()
	for {
		conn, err := a.ln.Accept()
		if err != nil {
			return
		}
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			defer conn.Close()
			line, err := bufio.NewReader(conn).ReadBytes('\n')
			if err != nil {
				return
			}
			a.mu.Lock()
			a.got = append(a.got, string(line))
			a.mu.Unlock()
			a.respond(conn, line)
		}()
	}
}

func (a *fakeApp) lines() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.got...)
}

// answer replies with s verbatim (so s carries its own newline, or deliberately none).
func answer(s string) func(net.Conn, []byte) {
	return func(conn net.Conn, _ []byte) { io.WriteString(conn, s) }
}

// silent never answers; it waits for the host to give up and close the connection.
func silent(conn net.Conn, _ []byte) { io.Copy(io.Discard, conn) }

// testHost returns a Host whose log is captured and which fails the test if it launches anything
// (unless opts.Launch is set): no test may start the real app.
func testHost(t *testing.T, opts Options) (*Host, *bytes.Buffer) {
	t.Helper()
	log := new(bytes.Buffer)
	opts.Log = log
	if opts.Launch == nil {
		opts.Launch = func(context.Context) error {
			t.Error("unexpected launch")
			return errors.New("tests never launch the app")
		}
	}
	return New(opts), log
}

// fakeClock makes wake's retries instant. Sleep advances Now and calls onSleep with the number of
// sleeps so far, which lets a test start the app after a given number of retries.
type fakeClock struct {
	now     time.Time
	sleeps  int
	onSleep func(n int)
}

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.now = c.now.Add(d)
	c.sleeps++
	if c.onSleep != nil {
		c.onSleep(c.sleeps)
	}
	return nil
}

func TestCaller(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"chrome", []string{chromeOrigin}, chromeOrigin},
		{"chrome on another platform with an extra argument", []string{chromeOrigin, "--parent-window=0"}, chromeOrigin},
		{"firefox", []string{firefoxPath, firefoxID}, firefoxID},
		{"firefox without the add-on id", []string{firefoxPath}, ""},
		{"no arguments", nil, ""},
		{"empty first argument", []string{""}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Caller(tt.args); got != tt.want {
				t.Errorf("Caller(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

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

func TestOptionsFromEnv(t *testing.T) {
	tests := []struct {
		noLaunch string
		want     bool
	}{{"1", true}, {"", false}, {"0", false}, {"true", false}}
	for _, tt := range tests {
		o := OptionsFromEnv([]string{firefoxPath, firefoxID}, env(map[string]string{EnvSocket: "/tmp/s", EnvNoLaunch: tt.noLaunch}))
		want := Options{Origin: firefoxID, SocketPath: "/tmp/s", NoLaunch: tt.want}
		if !reflect.DeepEqual(o, want) {
			t.Errorf("%s=%q: got %+v, want %+v", EnvNoLaunch, tt.noLaunch, o, want)
		}
	}
}

func TestOptionsDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	if o.Launch == nil || o.Dial == nil || o.Now == nil || o.Sleep == nil {
		t.Error("a function field has no default")
	}
	if o.Log != io.Discard {
		t.Errorf("Log = %v, want io.Discard", o.Log)
	}
	got := []time.Duration{o.DialTimeout, o.ReplyTimeout, o.RetryInterval, o.WakeTimeout}
	want := []time.Duration{2 * time.Second, 15 * time.Second, 250 * time.Millisecond, 10 * time.Second}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("timeouts = %v, want %v", got, want)
	}
	custom := Options{DialTimeout: 1, ReplyTimeout: 2, RetryInterval: 3, WakeTimeout: 4}.withDefaults()
	got = []time.Duration{custom.DialTimeout, custom.ReplyTimeout, custom.RetryInterval, custom.WakeTimeout}
	if !reflect.DeepEqual(got, []time.Duration{1, 2, 3, 4}) {
		t.Errorf("set timeouts were replaced: %v", got)
	}
}

func TestSleep(t *testing.T) {
	if err := sleep(context.Background(), time.Millisecond); err != nil {
		t.Errorf("sleep: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := sleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled sleep: err = %v, want context.Canceled", err)
	}
	if time.Since(start) > time.Second {
		t.Error("cancelled sleep did not return promptly")
	}
}

func TestOpenAppCommand(t *testing.T) {
	want := []string{"/usr/bin/open", "-g", "-b", "io.github.zahidnoor7.mergelane"}
	if !reflect.DeepEqual(openArgv, want) {
		t.Errorf("openArgv = %q, want %q", openArgv, want)
	}
}

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

func TestParseMessage(t *testing.T) {
	tests := []struct {
		name        string
		msg         string
		wantType    string
		wantCompact string
		wantErr     string // "" means valid
	}{
		{"ping", `{"type":"ping"}`, "ping", `{"type":"ping"}`, ""},
		{"extra fields kept in order", `{"type":"add","request":{"url":"u"},"a":1}`, "add", `{"type":"add","request":{"url":"u"},"a":1}`, ""},
		{"whitespace removed", " {\n \"type\" : \"wake\" ,\t\"x\" : [ 1, 2 ] }\r\n", "wake", `{"type":"wake","x":[1,2]}`, ""},
		{"escapes kept", `{"type":"ping","s":"<&>\né"}`, "ping", `{"type":"ping","s":"<&>\né"}`, ""},
		{"empty type is a string", `{"type":""}`, "", `{"type":""}`, ""},
		{"zero length", ``, "", "", "not JSON"},
		{"not JSON", `hello`, "", "", "not JSON"},
		{"truncated object", `{"type":"ping"`, "", "", "not JSON"},
		{"trailing garbage", `{"type":"ping"} x`, "", "", "not JSON"},
		{"invalid UTF-8", "{\"type\":\"\xff\"}", "", "", "not UTF-8"},
		{"array", `[{"type":"ping"}]`, "", "", "not a JSON object"},
		{"string", `"ping"`, "", "", "not a JSON object"},
		{"number", `1`, "", "", "not a JSON object"},
		{"null", `null`, "", "", "not a JSON object"},
		{"true", `true`, "", "", "not a JSON object"},
		{"missing type", `{}`, "", "", `no string "type"`},
		{"type is a number", `{"type":1}`, "", "", `no string "type"`},
		{"type is null", `{"type":null}`, "", "", `no string "type"`},
		{"type is an object", `{"type":{"x":"ping"}}`, "", "", `no string "type"`},
		{"type differs in case", `{"Type":"ping"}`, "", "", `no string "type"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			typ, compact, err := parseMessage([]byte(tt.msg))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("err = %v, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || typ != tt.wantType || string(compact) != tt.wantCompact {
				t.Errorf("got %q, %q, %v; want %q, %q, nil", typ, compact, err, tt.wantType, tt.wantCompact)
			}
		})
	}
}

func TestHandleBadMessageNeverReachesTheApp(t *testing.T) {
	for _, msg := range []string{``, `[]`, `null`, `{}`, `{"type":7}`, `nope`, "{\"type\":\"\xfe\"}"} {
		h, log := testHost(t, Options{
			SocketPath: "/tmp/unused.sock",
			Dial: func(context.Context, string) (net.Conn, error) {
				t.Errorf("%q: dialled the app", msg)
				return nil, errors.New("no")
			},
		})
		if got := string(h.Handle(context.Background(), []byte(msg))); got != replyBadMessage {
			t.Errorf("%q: answer = %s, want %s", msg, got, replyBadMessage)
		}
		if !strings.Contains(log.String(), "bad message") {
			t.Errorf("%q: log = %q, want a bad message line", msg, log)
		}
	}
}

func TestHandleForwardsToTheApp(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		msg      string
		wantLine string
	}{
		{
			"chrome ping", []string{chromeOrigin}, `{"type":"ping"}`,
			`{"v":3,"origin":"` + chromeOrigin + `","message":{"type":"ping"}}` + "\n",
		},
		{
			"firefox ping", []string{firefoxPath, firefoxID}, `{"type":"ping"}`,
			`{"v":3,"origin":"` + firefoxID + `","message":{"type":"ping"}}` + "\n",
		},
		{
			"no caller", nil, `{"type":"health"}`,
			`{"v":3,"origin":"","message":{"type":"health"}}` + "\n",
		},
		{
			"add kept byte for byte", []string{chromeOrigin},
			`{"type":"add","request":{"url":"https://example.com/f?a=1&b=<2>","name":"café ☕","n":1.50,"z":null}}`,
			`{"v":3,"origin":"` + chromeOrigin + `","message":{"type":"add","request":{"url":"https://example.com/f?a=1&b=<2>","name":"café ☕","n":1.50,"z":null}}}` + "\n",
		},
		{
			"whitespace removed so it stays one line", []string{chromeOrigin}, "{\n  \"type\": \"confirm\",\n  \"token\": \"t-1\"\n}",
			`{"v":3,"origin":"` + chromeOrigin + `","message":{"type":"confirm","token":"t-1"}}` + "\n",
		},
		{
			"wake with the app running is forwarded without launching", []string{chromeOrigin}, `{"type":"wake"}`,
			`{"v":3,"origin":"` + chromeOrigin + `","message":{"type":"wake"}}` + "\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := socketPath(t)
			app := startApp(t, path, answer(pong+"\n"))
			opts := OptionsFromEnv(tt.args, env(map[string]string{EnvSocket: path}))
			h, log := testHost(t, opts)
			if got := string(h.Handle(context.Background(), []byte(tt.msg))); got != pong {
				t.Errorf("answer = %s, want %s (log: %s)", got, pong, log)
			}
			if got := app.lines(); len(got) != 1 || got[0] != tt.wantLine {
				t.Errorf("app received %q, want exactly %q", got, tt.wantLine)
			}
		})
	}
}

// object returns a JSON object of exactly n bytes.
func object(n int) string {
	const head, tail = `{"ok":true,"pad":"`, `"}`
	return head + strings.Repeat("x", n-len(head)-len(tail)) + tail
}

func TestHandleRelaysTheAppsAnswer(t *testing.T) {
	tests := []struct {
		name    string
		respond func(net.Conn, []byte)
		want    string
	}{
		{"one line", answer(pong + "\n"), pong},
		{"answer to add", answer(`{"ok":true,"token":"0b8f"}` + "\n"), `{"ok":true,"token":"0b8f"}`},
		{"app error passed through", answer(`{"ok":false,"error":"forbidden"}` + "\n"), `{"ok":false,"error":"forbidden"}`},
		{"no newline before close", answer(pong), pong},
		{"anything after the first line ignored", answer(pong + "\n" + `{"ok":false}` + "\n"), pong},
		{"exactly 1 MiB", answer(object(MaxMessageBytes) + "\n"), object(MaxMessageBytes)},
		{"exactly 1 MiB, no newline", answer(object(MaxMessageBytes)), object(MaxMessageBytes)},
		{"over 1 MiB", answer(object(MaxMessageBytes+1) + "\n"), replyBadMessage},
		{"far over 1 MiB", answer(object(3*MaxMessageBytes) + "\n"), replyBadMessage},
		{"not JSON", answer("hello\n"), replyBadMessage},
		{"cut short", answer(`{"ok":tr`), replyBadMessage},
		{"JSON but not an object", answer("[1]\n"), replyBadMessage},
		{"blank line", answer("\n"), replyBadMessage},
		{"invalid UTF-8", answer("{\"ok\":\"\xff\"}\n"), replyBadMessage},
		{"closed without answering", answer(""), replyUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := socketPath(t)
			startApp(t, path, tt.respond)
			h, log := testHost(t, Options{Origin: chromeOrigin, SocketPath: path})
			if got := string(h.Handle(context.Background(), []byte(`{"type":"ping"}`))); got != tt.want {
				t.Errorf("answer = %.80s (%d bytes), want %.80s (log: %s)", got, len(got), tt.want, log)
			}
		})
	}
}

func TestHandleUnavailable(t *testing.T) {
	stale := socketPath(t) // a socket file nobody listens on, as after an app crash: ECONNREFUSED
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	l.SetUnlinkOnClose(false)
	l.Close()

	tests := []struct {
		name string
		path string
		msg  string
	}{
		{"ping, no socket file", "/tmp/nmh-missing/browser.sock", `{"type":"ping"}`},
		{"add, no socket file", "/tmp/nmh-missing/browser.sock", `{"type":"add","request":{"url":"https://example.com/secret-token"}}`},
		{"confirm, stale socket", stale, `{"type":"confirm","token":"t"}`},
		{"health, stale socket", stale, `{"type":"health"}`},
		{"unknown type, stale socket", stale, `{"type":"surprise"}`},
		{"no socket path", "", `{"type":"ping"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := &fakeClock{now: time.Unix(1000, 0)}
			h, log := testHost(t, Options{SocketPath: tt.path, Now: clock.Now, Sleep: clock.Sleep})
			if got := string(h.Handle(context.Background(), []byte(tt.msg))); got != replyUnavailable {
				t.Errorf("answer = %s, want %s", got, replyUnavailable)
			}
			if clock.sleeps != 0 {
				t.Errorf("retried %d times; only wake retries", clock.sleeps)
			}
			if !strings.Contains(log.String(), "app unavailable") {
				t.Errorf("log = %q, want an app unavailable line", log)
			}
			if strings.Contains(log.String(), "secret-token") {
				t.Errorf("log = %q leaks message contents", log)
			}
		})
	}
}

func TestHandleWake(t *testing.T) {
	const wake = `{"type":"wake"}`
	tests := []struct {
		name         string
		noLaunch     bool
		launchErr    error
		startAfter   int // the app starts listening after this many sleeps; 0 means never
		want         string
		wantLaunches int
		wantSleeps   int
	}{
		{"launches and waits for the app", false, nil, 3, pong, 1, 3},
		{"app ready on the first retry", false, nil, 1, pong, 1, 1},
		{"app ready on the last retry", false, nil, 40, pong, 1, 40},
		{"gives up after 10 s", false, nil, 0, replyUnavailable, 1, 40},
		{"launch fails", false, errors.New("open: no such app"), 0, replyUnavailable, 1, 0},
		{"NO_LAUNCH still waits for the app", true, nil, 2, pong, 0, 2},
		{"NO_LAUNCH gives up after 10 s", true, nil, 0, replyUnavailable, 0, 40},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := socketPath(t)
			var app *fakeApp
			clock := &fakeClock{now: time.Unix(1000, 0)}
			clock.onSleep = func(n int) {
				if n == tt.startAfter {
					app = startApp(t, path, answer(pong+"\n"))
				}
			}
			launches := 0
			getenv := env(map[string]string{EnvSocket: path})
			if tt.noLaunch {
				getenv = env(map[string]string{EnvSocket: path, EnvNoLaunch: "1"})
			}
			opts := OptionsFromEnv([]string{chromeOrigin}, getenv)
			opts.Now, opts.Sleep = clock.Now, clock.Sleep
			opts.Launch = func(ctx context.Context) error {
				launches++
				if _, ok := ctx.Deadline(); !ok {
					t.Error("launch has no deadline")
				}
				return tt.launchErr
			}
			h, log := testHost(t, opts)

			if got := string(h.Handle(context.Background(), []byte(wake))); got != tt.want {
				t.Errorf("answer = %s, want %s (log: %s)", got, tt.want, log)
			}
			if launches != tt.wantLaunches || clock.sleeps != tt.wantSleeps {
				t.Errorf("launches = %d, sleeps = %d; want %d and %d", launches, clock.sleeps, tt.wantLaunches, tt.wantSleeps)
			}
			if tt.want == pong {
				want := `{"v":3,"origin":"` + chromeOrigin + `","message":` + wake + "}\n"
				if got := app.lines(); len(got) != 1 || got[0] != want {
					t.Errorf("app received %q, want %q", got, want)
				}
			}
		})
	}
}

func TestHandleWakeStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h, _ := testHost(t, Options{
		SocketPath: "/tmp/nmh-missing/browser.sock",
		NoLaunch:   true,
		Sleep: func(ctx context.Context, d time.Duration) error {
			cancel()
			return sleep(ctx, d)
		},
	})
	if got := string(h.Handle(ctx, []byte(`{"type":"wake"}`))); got != replyUnavailable {
		t.Errorf("answer = %s, want %s", got, replyUnavailable)
	}
}

func TestHandleReplyTimeout(t *testing.T) {
	path := socketPath(t)
	app := startApp(t, path, silent)
	h, log := testHost(t, Options{SocketPath: path, ReplyTimeout: 100 * time.Millisecond})
	start := time.Now()
	if got := string(h.Handle(context.Background(), []byte(`{"type":"add","request":{}}`))); got != replyUnavailable {
		t.Errorf("answer = %s, want %s", got, replyUnavailable)
	}
	if d := time.Since(start); d < 100*time.Millisecond || d > 5*time.Second {
		t.Errorf("gave up after %v, want about 100ms", d)
	}
	if len(app.lines()) != 1 {
		t.Errorf("app received %d requests, want 1", len(app.lines()))
	}
	if !strings.Contains(log.String(), "no answer from the app") {
		t.Errorf("log = %q", log)
	}
}

func TestHandleDialTimeout(t *testing.T) {
	var deadline time.Time
	h, _ := testHost(t, Options{
		SocketPath:  "/tmp/nmh-hangs/browser.sock",
		DialTimeout: 30 * time.Millisecond,
		Dial: func(ctx context.Context, path string) (net.Conn, error) {
			deadline, _ = ctx.Deadline()
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	start := time.Now()
	if got := string(h.Handle(context.Background(), []byte(`{"type":"ping"}`))); got != replyUnavailable {
		t.Errorf("answer = %s, want %s", got, replyUnavailable)
	}
	if deadline.IsZero() || deadline.Sub(start) > time.Second {
		t.Errorf("dial deadline = %v after start, want about 30ms", deadline.Sub(start))
	}
}

// deadlineFailConn is a connection whose deadlines can't be set.
type deadlineFailConn struct{ net.Conn }

func (deadlineFailConn) SetDeadline(time.Time) error { return errors.New("no deadlines here") }

// writeFailConn is a connection that can't be written to.
type writeFailConn struct{ net.Conn }

func (writeFailConn) Write([]byte) (int, error) { return 0, errors.New("write refused") }

func TestHandleConnectionErrors(t *testing.T) {
	tests := []struct {
		name    string
		conn    func() net.Conn
		wantLog string // proves which step failed
	}{
		{"deadline cannot be set", func() net.Conn {
			c, _ := net.Pipe()
			return deadlineFailConn{c}
		}, "no deadlines here"},
		{"write fails", func() net.Conn {
			c, _ := net.Pipe()
			return writeFailConn{c}
		}, "write refused"},
		{"app closes after reading", func() net.Conn {
			c, peer := net.Pipe()
			go func() {
				bufio.NewReader(peer).ReadBytes('\n')
				peer.Close()
			}()
			return c
		}, "closed the connection without answering"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conn := tt.conn()
			h, log := testHost(t, Options{
				SocketPath:   "/tmp/nmh-fake/browser.sock",
				ReplyTimeout: time.Second,
				Dial:         func(context.Context, string) (net.Conn, error) { return conn, nil },
			})
			if got := string(h.Handle(context.Background(), []byte(`{"type":"ping"}`))); got != replyUnavailable {
				t.Errorf("answer = %s, want %s", got, replyUnavailable)
			}
			if !strings.Contains(log.String(), tt.wantLog) {
				t.Errorf("log = %q, want it to mention %q", log, tt.wantLog)
			}
		})
	}
}

// frames decodes all of b as frames, failing the test if anything else is in it.
func frames(t *testing.T, b []byte) []string {
	t.Helper()
	r := bytes.NewReader(b)
	var out []string
	for {
		msg, err := ReadMessage(r)
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("stdout is not only frames: %v", err)
		}
		out = append(out, string(msg))
	}
}

func stream(msgs ...[]byte) []byte {
	var b bytes.Buffer
	for _, m := range msgs {
		b.Write(frame(uint32(len(m)), m))
	}
	return b.Bytes()
}

func TestRunSeveralMessagesInOneStream(t *testing.T) {
	path := socketPath(t)
	app := startApp(t, path, func(conn net.Conn, line []byte) {
		if bytes.Contains(line, []byte(`"type":"health"`)) {
			io.WriteString(conn, `{"ok":true,"app":"mergelane","version":"1.2.3","ready":true}`+"\n")
			return
		}
		io.WriteString(conn, pong+"\n")
	})
	big := []byte(`{"type":"ping","pad":"` + strings.Repeat("y", MaxMessageBytes-len(`{"type":"ping","pad":""}`)) + `"}`)
	if len(big) != MaxMessageBytes {
		t.Fatalf("big is %d bytes", len(big))
	}
	in := stream(
		[]byte(`{"type":"ping"}`),
		[]byte(`[1,2]`),
		[]byte(``),
		[]byte(`{"type":"health"}`),
		big,
	)
	h, log := testHost(t, Options{Origin: chromeOrigin, SocketPath: path})
	var out bytes.Buffer
	if err := h.Run(context.Background(), bytes.NewReader(in), &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	want := []string{pong, replyBadMessage, replyBadMessage, `{"ok":true,"app":"mergelane","version":"1.2.3","ready":true}`, pong}
	if got := frames(t, out.Bytes()); !reflect.DeepEqual(got, want) {
		t.Errorf("answers = %q, want %q", got, want)
	}
	if got := app.lines(); len(got) != 3 {
		t.Errorf("app received %d requests, want 3", len(got))
	}
	if strings.Contains(log.String(), "yyyy") {
		t.Error("log contains message contents")
	}
}

func TestRunStreamErrors(t *testing.T) {
	ping := []byte(`{"type":"ping"}`)
	tests := []struct {
		name        string
		in          []byte
		wantErr     error
		wantAnswers []string
	}{
		{"empty stdin", nil, nil, nil},
		{"oversize length", append(frame(MaxMessageBytes+1, nil), stream(ping)...), ErrTooBig, []string{replyBadMessage}},
		{"oversize after a good message", append(stream([]byte(`[]`)), frame(64<<20, []byte("x"))...), ErrTooBig, []string{replyBadMessage, replyBadMessage}},
		{"truncated length", []byte{9, 0}, io.ErrUnexpectedEOF, []string{replyBadMessage}},
		{"truncated body", frame(20, []byte(`{"type":`)), io.ErrUnexpectedEOF, []string{replyBadMessage}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, _ := testHost(t, Options{SocketPath: "/tmp/nmh-missing/browser.sock"})
			var out bytes.Buffer
			err := h.Run(context.Background(), bytes.NewReader(tt.in), &out)
			if !errors.Is(err, tt.wantErr) { // errors.Is(nil, nil) is true
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got := frames(t, out.Bytes()); !reflect.DeepEqual(got, tt.wantAnswers) {
				t.Errorf("answers = %q, want %q", got, tt.wantAnswers)
			}
		})
	}
}

func TestRunStopsWhenStdoutFails(t *testing.T) {
	boom := errors.New("broken pipe")
	h, _ := testHost(t, Options{SocketPath: "/tmp/nmh-missing/browser.sock"})
	err := h.Run(context.Background(), bytes.NewReader(stream([]byte(`{}`), []byte(`{}`))), failingWriter{boom})
	if !errors.Is(err, boom) {
		t.Errorf("err = %v, want broken pipe", err)
	}
}

func TestRequestLineCarriesTheBrowser(t *testing.T) {
	got := string(requestLine("o", `/Applications/Firefox.app/Contents/MacOS/firefox`, []byte(`{"type":"ping"}`)))
	want := `{"v":3,"origin":"o","browser":"/Applications/Firefox.app/Contents/MacOS/firefox","message":{"type":"ping"}}` + "\n"
	if got != want {
		t.Errorf("requestLine = %q, want %q", got, want)
	}
	if got := string(requestLine("o", "", []byte(`{}`))); got != `{"v":3,"origin":"o","message":{}}`+"\n" {
		t.Errorf("an unknown browser is left out: %q", got)
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
