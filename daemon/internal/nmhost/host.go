package nmhost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
	"unicode/utf8"
)

// Defaults for the zero fields of Options (docs/BROWSER-BRIDGE.md).
const (
	DefaultDialTimeout   = 2 * time.Second
	DefaultReplyTimeout  = 15 * time.Second // the app may take up to 8 s to answer an add
	DefaultRetryInterval = 250 * time.Millisecond
	DefaultWakeTimeout   = 10 * time.Second
)

// The host's own answers. The app gives the same errors in the same shape.
const (
	replyBadMessage  = `{"ok":false,"error":"bad-message"}`
	replyUnavailable = `{"ok":false,"error":"unavailable"}`
)

// Options configures a Host. The function fields exist so that tests can replace the app, the
// launcher and the clock; nil means the real one.
type Options struct {
	// Origin identifies the calling extension (see Caller). It is forwarded to the app as is.
	Origin string
	// Browser is the executable of the browser that started the host (see ParentApp). It is
	// forwarded to the app, which shows which browsers have connected; empty leaves it out.
	Browser string
	// SocketPath is the app's browser socket (see SocketPath). Empty means the app is unreachable.
	SocketPath string
	// NoLaunch stops wake from launching the app; wake still waits for the app to appear.
	NoLaunch bool

	// Launch starts the app. Nil means OpenApp. It is given at most WakeTimeout.
	Launch func(ctx context.Context) error
	// Dial connects to the socket at path. Nil means a net.Dialer on "unix". It is given at most
	// DialTimeout, through ctx.
	Dial func(ctx context.Context, path string) (net.Conn, error)
	// Now and Sleep pace wake's retries. Nil means time.Now and a timer that ctx can cut short.
	// Socket deadlines always use the real clock, because the kernel enforces them.
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
	// Log receives brief diagnostics, never message contents. Nil means io.Discard. The command
	// passes stderr: stdout belongs to the protocol.
	Log io.Writer

	DialTimeout   time.Duration // zero means DefaultDialTimeout
	ReplyTimeout  time.Duration // for writing the request and reading the answer; zero means DefaultReplyTimeout
	RetryInterval time.Duration // between wake's dial attempts; zero means DefaultRetryInterval
	WakeTimeout   time.Duration // how long wake keeps retrying; zero means DefaultWakeTimeout
}

func (o Options) withDefaults() Options {
	if o.Launch == nil {
		o.Launch = OpenApp
	}
	if o.Dial == nil {
		o.Dial = dialUnix
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = sleep
	}
	if o.Log == nil {
		o.Log = io.Discard
	}
	if o.DialTimeout == 0 {
		o.DialTimeout = DefaultDialTimeout
	}
	if o.ReplyTimeout == 0 {
		o.ReplyTimeout = DefaultReplyTimeout
	}
	if o.RetryInterval == 0 {
		o.RetryInterval = DefaultRetryInterval
	}
	if o.WakeTimeout == 0 {
		o.WakeTimeout = DefaultWakeTimeout
	}
	return o
}

func dialUnix(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}

// sleep waits for d, or until ctx is done.
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Host relays the browser's messages to the app.
type Host struct {
	opts Options
}

// New returns a Host that runs with opts, defaults filled in.
func New(opts Options) *Host { return &Host{opts: opts.withDefaults()} }

// Run answers every message on in, in order, until in ends. It returns nil when in ends between
// messages. A frame that is cut short or longer than MaxMessageBytes gets a bad-message answer and
// ends the run with an error, because the stream cannot be resynchronised after it. A failed write
// to out also ends it with an error.
func (h *Host) Run(ctx context.Context, in io.Reader, out io.Writer) error {
	for {
		msg, err := ReadMessage(in)
		if err == io.EOF {
			return nil
		}
		if err != nil { // the caller reports err
			_ = WriteMessage(out, []byte(replyBadMessage)) // best effort: the browser may be gone
			return err
		}
		if err := WriteMessage(out, h.Handle(ctx, msg)); err != nil {
			return fmt.Errorf("nmhost: writing an answer: %w", err)
		}
	}
}

// Handle answers one message from the browser. msg must be a UTF-8 JSON object with a string "type";
// anything else is answered bad-message without contacting the app. Otherwise msg is forwarded to the
// app and the app's answer returned. When the app isn't running the answer is unavailable, except for
// a wake message, which launches the app (unless NoLaunch) and waits for it first.
func (h *Host) Handle(ctx context.Context, msg []byte) []byte {
	typ, compact, err := parseMessage(msg)
	if err != nil {
		h.logf("bad message: %v", err)
		return []byte(replyBadMessage)
	}
	conn, err := h.dial(ctx)
	if err != nil && typ == "wake" {
		conn, err = h.wake(ctx)
	}
	if err != nil {
		h.logf("%.32q: app unavailable: %v", typ, err)
		return []byte(replyUnavailable)
	}
	defer conn.Close()

	reply, err := h.exchange(conn, requestLine(h.opts.Origin, h.opts.Browser, compact))
	switch {
	case err == nil:
		return reply
	case errors.Is(err, errReplyTooBig), errors.Is(err, errBadReply):
		h.logf("%.32q: %v", typ, err)
		return []byte(replyBadMessage)
	default:
		h.logf("%.32q: no answer from the app: %v", typ, err)
		return []byte(replyUnavailable)
	}
}

// parseMessage checks that msg is a UTF-8 JSON object with a string "type". It returns the type and
// msg without insignificant whitespace, so that it fits on the request line; nothing else in msg
// changes, string escapes included.
func parseMessage(msg []byte) (typ string, compact []byte, err error) {
	if !utf8.Valid(msg) {
		return "", nil, errors.New("not UTF-8")
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, msg); err != nil {
		return "", nil, fmt.Errorf("not JSON: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &fields); err != nil || fields == nil { // null leaves fields nil
		return "", nil, errors.New("not a JSON object")
	}
	raw := fields["type"]
	if len(raw) == 0 || raw[0] != '"' {
		return "", nil, errors.New(`no string "type"`)
	}
	if err := json.Unmarshal(raw, &typ); err != nil {
		return "", nil, fmt.Errorf(`bad "type": %w`, err)
	}
	return typ, buf.Bytes(), nil
}

// requestLine is the one line the app reads: {"v":3,"origin":<origin>,"browser":<browser>,
// "message":<msg>} and a newline, "browser" left out when empty. msg must be compact JSON (see
// parseMessage); it is copied byte for byte.
func requestLine(origin, browser string, msg []byte) []byte {
	o, _ := json.Marshal(origin) // cannot fail: invalid UTF-8 becomes U+FFFD
	b, _ := json.Marshal(browser)
	line := make([]byte, 0, len(msg)+len(o)+len(b)+48)
	line = fmt.Appendf(line, `{"v":%d,"origin":`, ProtocolVersion)
	line = append(line, o...)
	if browser != "" {
		line = append(line, `,"browser":`...)
		line = append(line, b...)
	}
	line = append(line, `,"message":`...)
	line = append(line, msg...)
	return append(line, "}\n"...)
}

// dial connects to the app's socket, giving up after DialTimeout.
func (h *Host) dial(ctx context.Context) (net.Conn, error) {
	if h.opts.SocketPath == "" {
		return nil, errors.New("no socket path: neither " + EnvSocket + " nor HOME is set")
	}
	ctx, cancel := context.WithTimeout(ctx, h.opts.DialTimeout)
	defer cancel()
	return h.opts.Dial(ctx, h.opts.SocketPath)
}

// wake launches the app (unless NoLaunch), then dials every RetryInterval until it answers or
// WakeTimeout has passed.
func (h *Host) wake(ctx context.Context) (net.Conn, error) {
	if h.opts.NoLaunch {
		h.logf("app not running; %s=1, so waiting without launching it", EnvNoLaunch)
	} else {
		h.logf("app not running; launching %s", BundleID)
		lctx, cancel := context.WithTimeout(ctx, h.opts.WakeTimeout)
		err := h.opts.Launch(lctx)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("launching the app: %w", err)
		}
	}
	deadline := h.opts.Now().Add(h.opts.WakeTimeout)
	for {
		if err := h.opts.Sleep(ctx, h.opts.RetryInterval); err != nil {
			return nil, err
		}
		conn, err := h.dial(ctx)
		if err == nil {
			return conn, nil
		}
		if !h.opts.Now().Before(deadline) {
			return nil, fmt.Errorf("still not answering after %v: %w", h.opts.WakeTimeout, err)
		}
	}
}

var (
	errReplyTooBig = errors.New("the app's answer is over 1 MiB")
	errBadReply    = errors.New("the app's answer is not a UTF-8 JSON object")
	errNoReply     = errors.New("the app closed the connection without answering")
)

// exchange sends line and reads the app's one-line answer, within ReplyTimeout.
func (h *Host) exchange(conn net.Conn, line []byte) ([]byte, error) {
	if err := conn.SetDeadline(time.Now().Add(h.opts.ReplyTimeout)); err != nil {
		return nil, err
	}
	if _, err := conn.Write(line); err != nil {
		return nil, err
	}
	return readReply(conn)
}

// readReply reads one line of at most MaxMessageBytes (newline excluded) and checks that it is a
// UTF-8 JSON object. An answer the app ended by closing the connection instead of with a newline is
// accepted too: a cut-short object is never valid JSON.
func readReply(r io.Reader) ([]byte, error) {
	line, err := bufio.NewReader(io.LimitReader(r, MaxMessageBytes+1)).ReadBytes('\n')
	switch {
	case err == nil:
		line = line[:len(line)-1]
	case err != io.EOF:
		return nil, err
	case len(line) > MaxMessageBytes:
		return nil, errReplyTooBig
	case len(line) == 0:
		return nil, errNoReply
	}
	trimmed := bytes.TrimLeft(line, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' || !utf8.Valid(line) || !json.Valid(line) {
		return nil, errBadReply
	}
	return line, nil
}

func (h *Host) logf(format string, a ...any) {
	fmt.Fprintf(h.opts.Log, "mergelane-nmhost: "+format+"\n", a...)
}
