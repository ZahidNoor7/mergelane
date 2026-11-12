package api

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func dialClient(t *testing.T, s *Server) *Client {
	t.Helper()
	c, err := Dial(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestClientMethods(t *testing.T) {
	h := &fakeHandler{
		links: []Link{{Name: "en0", Index: 11, Kind: "Wi-Fi", IPv4: "192.168.1.2", Up: true, State: LinkUp}},
		stats: []LinkStats{{Name: "en0", RxBps: 10, ActiveFlows: 2, Weight: 1}},
	}
	c := dialClient(t, startServer(t, h, allowAll))
	ctx := context.Background()

	st, err := c.Status(ctx)
	if err != nil || st.State != StateOn || !st.Since.Equal(testTime) || st.Protocol != ProtocolVersion || st.Version != "test" {
		t.Fatalf("status %+v, %v", st, err)
	}
	if st, err = c.Enable(ctx); err != nil || st.State != StateStarting {
		t.Fatalf("enable %+v, %v", st, err)
	}
	if st, err = c.Disable(ctx, "bye"); err != nil || st.State != StateOff || st.Reason != "bye" {
		t.Fatalf("disable %+v, %v", st, err)
	}
	if st, err = c.Disable(ctx, ""); err != nil || st.Reason != "" {
		t.Fatalf("disable without reason %+v, %v", st, err)
	}
	links, err := c.Links(ctx)
	if err != nil || len(links.Links) != 1 || links.Links[0] != h.links[0] {
		t.Fatalf("links %+v, %v", links, err)
	}
	stats, err := c.Stats(ctx)
	if err != nil || !stats.At.Equal(testTime) || len(stats.Links) != 1 || stats.Links[0] != h.stats[0] {
		t.Fatalf("stats %+v, %v", stats, err)
	}
	lim, err := c.SetLimit(ctx, "en0", 0)
	if err != nil || lim != (SetLimitResult{Link: "en0"}) {
		t.Fatalf("setLimit %+v, %v", lim, err)
	}
	if st, err = c.SetAutoResume(ctx, true); err != nil || !st.AutoResume || st.Protocol != ProtocolVersion {
		t.Fatalf("setAutoResume %+v, %v", st, err)
	}
	if st, err = c.SetAutoResume(ctx, false); err != nil || st.AutoResume {
		t.Fatalf("setAutoResume off %+v, %v", st, err)
	}
	if st, err = c.SetStickySites(ctx, false); err != nil || st.StickySites || st.Protocol != ProtocolVersion {
		t.Fatalf("setStickySites off %+v, %v", st, err)
	}
	if st, err = c.SetStickySites(ctx, true); err != nil || !st.StickySites {
		t.Fatalf("setStickySites on %+v, %v", st, err)
	}
	h.events = []LinkEvent{{At: testTime, Link: "en0", From: LinkUp, To: LinkGone, Reason: EventLost}}
	ev, err := c.Events(ctx)
	if err != nil || len(ev.Events) != 1 || ev.Events[0] != h.events[0] {
		t.Fatalf("events %+v, %v", ev, err)
	}
	if err := c.Call(ctx, MethodStatus, nil, nil); err != nil {
		t.Fatalf("call without result: %v", err)
	}
	if len(h.disables) != 2 || h.disables[0].Reason != "bye" || len(h.limits) != 1 || h.limits[0].Link != "en0" {
		t.Fatalf("handler saw %+v %+v", h.disables, h.limits)
	}
	if len(h.resumes) != 2 || !h.resumes[0].Enabled || h.resumes[1].Enabled {
		t.Fatalf("handler saw setAutoResume %+v", h.resumes)
	}
	if len(h.stickies) != 2 || h.stickies[0].Enabled || !h.stickies[1].Enabled {
		t.Fatalf("handler saw setStickySites %+v", h.stickies)
	}
}

// An app newer than the helper may call a method the helper does not have yet. The older daemon
// answers UNKNOWN_METHOD for that request only, and the connection stays usable.
func TestClientNewMethodsAgainstAnOlderDaemon(t *testing.T) {
	c := pipeClient(t, func(req string) string {
		id := req[strings.Index(req, `"id":"`)+6 : strings.Index(req, `","method"`)]
		if strings.Contains(req, `"method":"status"`) {
			return `{"v":1,"id":"` + id + `","ok":true,"result":{"state":"off","version":"0.1.0","protocol":1}}` + "\n"
		}
		method := req[strings.Index(req, `"method":"`)+10:]
		method = method[:strings.Index(method, `"`)]
		return `{"v":1,"id":"` + id + `","ok":false,"error":{"code":"UNKNOWN_METHOD","message":"unknown method \"` + method + `\""}}` + "\n"
	})
	ctx := context.Background()
	if _, err := c.SetAutoResume(ctx, true); !isCode(err, CodeUnknownMethod) {
		t.Fatalf("setAutoResume against an older daemon = %v, want UNKNOWN_METHOD", err)
	}
	if _, err := c.Events(ctx); !isCode(err, CodeUnknownMethod) {
		t.Fatalf("events against an older daemon = %v, want UNKNOWN_METHOD", err)
	}
	if _, err := c.SetStickySites(ctx, false); !isCode(err, CodeUnknownMethod) {
		t.Fatalf("setStickySites against an older daemon = %v, want UNKNOWN_METHOD", err)
	}
	// An older daemon's status has no autoResume: it reads as off.
	st, err := c.Status(ctx)
	if err != nil || st.State != StateOff || st.AutoResume || st.Version != "0.1.0" {
		t.Fatalf("status from an older daemon = %+v, %v", st, err)
	}
}

func TestClientErrorMapping(t *testing.T) {
	h := &fakeHandler{err: Errorf(CodeVPNActive, "utun4")}
	c := dialClient(t, startServer(t, h, allowAll))
	ctx := context.Background()

	_, err := c.Enable(ctx)
	if e, ok := errors.AsType[*Error](err); !ok || e.Code != CodeVPNActive || e.Message != "utun4" {
		t.Fatalf("got %v", err)
	}
	// A request error does not spoil the connection.
	h.err = nil
	if _, err := c.Status(ctx); err != nil {
		t.Fatalf("after an error response: %v", err)
	}
	if _, err := c.SetLimit(ctx, "en0", -1); !isCode(err, CodeBadRequest) {
		t.Fatalf("bad params: %v", err)
	}
	if err := c.Call(ctx, "reboot", nil, nil); !isCode(err, CodeUnknownMethod) {
		t.Fatalf("unknown method: %v", err)
	}

	h2 := &fakeHandler{err: errors.New("boom")}
	c2 := dialClient(t, startServer(t, h2, allowAll))
	if _, err := c2.Links(ctx); !isCode(err, CodeInternal) {
		t.Fatalf("plain error: %v", err)
	}
}

func isCode(err error, code Code) bool {
	e, ok := errors.AsType[*Error](err)
	return ok && e.Code == code
}

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

func TestClientContext(t *testing.T) {
	release := make(chan struct{})
	h := &fakeHandler{statusFn: func(ctx context.Context) (Status, error) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return Status{State: StateOn}, nil
	}}
	c := dialClient(t, startServer(t, h, allowAll))
	defer close(release)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Call(cancelled, MethodLinks, nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled ctx: %v", err)
	}
	// Nothing was sent, so the connection is still fine.
	if _, err := c.Links(context.Background()); err != nil {
		t.Fatalf("after a cancelled ctx: %v", err)
	}

	ctx, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	start := time.Now()
	if _, err := c.Status(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("deadline did not interrupt the call")
	}
	// The answer to the abandoned call may still arrive, so the connection is not reused.
	if _, err := c.Links(context.Background()); err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("after an interrupted call: %v", err)
	}
}

// pipeClient returns a client whose peer is reply: it reads each request line and answers with
// whatever reply returns for it.
func pipeClient(t *testing.T, reply func(req string) string) *Client {
	t.Helper()
	cli, srv := net.Pipe()
	t.Cleanup(func() { cli.Close(); srv.Close() })
	go func() {
		r := bufio.NewReader(srv)
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if _, err := srv.Write([]byte(reply(line))); err != nil {
				return
			}
		}
	}()
	return NewClient(cli)
}

func TestClientRejectsBadResponses(t *testing.T) {
	tests := []struct {
		name, reply, want string
		sticky            bool
	}{
		{name: "wrong id", reply: `{"v":1,"id":"999","ok":true,"result":{}}` + "\n", want: "does not match", sticky: true},
		{name: "ok with empty id", reply: `{"v":1,"id":"","ok":true,"result":{}}` + "\n", want: "does not match", sticky: true},
		{name: "not json", reply: "garbage\n", want: "not a valid JSON object", sticky: true},
		{name: "other version", reply: `{"v":2,"id":"1","ok":true,"result":{}}` + "\n", want: "protocol version 2", sticky: true},
		{name: "too long", reply: strings.Repeat("x", maxResponseBytes+1), want: "longer than", sticky: true},
		{name: "result of the wrong type", reply: `{"v":1,"id":"1","ok":true,"result":{"state":5}}` + "\n", want: "decoding status result"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := pipeClient(t, func(string) string { return tc.reply })
			_, err := c.Status(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
			if _, isAPI := errors.AsType[*Error](err); isAPI {
				t.Fatalf("a client-side failure looks like a daemon error: %v", err)
			}
			_, err2 := c.Status(context.Background())
			if tc.sticky && (err2 == nil || !strings.Contains(err2.Error(), tc.want)) {
				t.Fatalf("second call: %v", err2)
			}
		})
	}
}

func TestClientConnectionLevelErrorIsSticky(t *testing.T) {
	c := pipeClient(t, func(string) string {
		return `{"v":1,"id":"","ok":false,"error":{"code":"BAD_REQUEST","message":"line too long"}}` + "\n"
	})
	for range 2 {
		if _, err := c.Status(context.Background()); !isCode(err, CodeBadRequest) {
			t.Fatalf("got %v", err)
		}
	}
}

func TestClientLocalFailures(t *testing.T) {
	calls := 0
	c := pipeClient(t, func(req string) string {
		calls++
		return `{"v":1,"id":"` + req[strings.Index(req, `"id":"`)+6:strings.Index(req, `","method"`)] + `","ok":true,"result":{}}` + "\n"
	})
	ctx := context.Background()
	if err := c.Call(ctx, MethodStatus, make(chan int), nil); err == nil || !strings.Contains(err.Error(), "encoding status params") {
		t.Fatalf("unencodable params: %v", err)
	}
	if err := c.Call(ctx, MethodDisable, DisableParams{Reason: strings.Repeat("r", MaxLineBytes)}, nil); err == nil || !strings.Contains(err.Error(), "more than") {
		t.Fatalf("oversize request: %v", err)
	}
	if calls != 0 {
		t.Fatalf("%d requests reached the daemon", calls)
	}
	// Neither failure touched the connection.
	if err := c.Call(ctx, MethodStatus, nil, nil); err != nil {
		t.Fatalf("after local failures: %v", err)
	}

	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.Call(ctx, MethodStatus, nil, nil); err == nil {
		t.Fatal("call on a closed client succeeded")
	}
}

func TestClientWriteFailsWithoutPendingResponse(t *testing.T) {
	cli, srv := net.Pipe()
	srv.Close()
	c := NewClient(cli)
	defer c.Close()
	if _, err := c.Status(context.Background()); err == nil {
		t.Fatal("write to a closed peer succeeded")
	}
}

func TestDialMissingSocket(t *testing.T) {
	if _, err := Dial(sockPath(t)); err == nil {
		t.Fatal("dialled a socket that does not exist")
	}
}
