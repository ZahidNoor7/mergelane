package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func TestParseRequest(t *testing.T) {
	tests := []struct {
		name, line string
		code       Code   // "" = valid
		id         string // id the result carries, valid or not
		msg        string // part of the error message
		params     string // valid only: the params kept
	}{
		{name: "minimal", line: `{"v":1,"id":"1","method":"status"}`, id: "1"},
		{name: "newline", line: "{\"v\":1,\"id\":\"1\",\"method\":\"status\"}\n", id: "1"},
		{name: "crlf", line: "{\"v\":1,\"id\":\"1\",\"method\":\"status\"}\r\n", id: "1"},
		{name: "params", line: `{"v":1,"id":"a","method":"setLimit","params":{"link":"en0","mbps":5}}`, id: "a", params: `{"link":"en0","mbps":5}`},
		{name: "null params", line: `{"v":1,"id":"1","method":"status","params":null}`, id: "1"},
		{name: "unknown envelope field ignored", line: `{"v":1,"id":"1","method":"status","trace":true}`, id: "1"},
		{name: "v as 1.0", line: `{"v":1.0,"id":"1","method":"status"}`, id: "1"},
		{name: "unknown method parses", line: `{"v":1,"id":"1","method":"reboot"}`, id: "1"},
		{name: "not json", line: `not json`, code: CodeBadRequest, msg: "not a JSON object"},
		{name: "empty", line: ``, code: CodeBadRequest},
		{name: "array", line: `[1]`, code: CodeBadRequest},
		{name: "null", line: `null`, code: CodeBadRequest},
		{name: "string", line: `"x"`, code: CodeBadRequest},
		{name: "trailing data", line: `{"v":1,"id":"1","method":"status"} {}`, code: CodeBadRequest},
		{name: "empty object", line: `{}`, code: CodeBadRequest, msg: "id must be a string"},
		{name: "numeric id", line: `{"v":1,"id":7,"method":"status"}`, code: CodeBadRequest, msg: "id must be a string"},
		{name: "empty id", line: `{"v":1,"id":"","method":"status"}`, code: CodeBadRequest, msg: "id must not be empty"},
		{name: "bad id beats bad version", line: `{"v":2,"id":7}`, code: CodeBadRequest},
		{name: "missing v", line: `{"id":"1","method":"status"}`, code: CodeBadRequest, id: "1", msg: "missing"},
		{name: "null v", line: `{"v":null,"id":"1","method":"status"}`, code: CodeBadRequest, id: "1", msg: "missing"},
		{name: "huge v", line: `{"v":1e400,"id":"1","method":"status"}`, code: CodeUnsupportedVersion, id: "1"},
		{name: "string v", line: `{"v":"1","id":"1","method":"status"}`, code: CodeBadRequest, id: "1", msg: "must be a number"},
		{name: "v 2", line: `{"v":2,"id":"1","method":"status"}`, code: CodeUnsupportedVersion, id: "1", msg: "version 2 is not supported"},
		{name: "v 0", line: `{"v":0,"id":"1","method":"status"}`, code: CodeUnsupportedVersion, id: "1"},
		{name: "missing method", line: `{"v":1,"id":"1"}`, code: CodeBadRequest, id: "1", msg: "method"},
		{name: "numeric method", line: `{"v":1,"id":"1","method":5}`, code: CodeBadRequest, id: "1", msg: "method"},
		{name: "array params", line: `{"v":1,"id":"1","method":"status","params":[1]}`, code: CodeBadRequest, id: "1", msg: "params"},
		{name: "string params", line: `{"v":1,"id":"1","method":"status","params":"x"}`, code: CodeBadRequest, id: "1", msg: "params"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, err := ParseRequest([]byte(tc.line))
			if req.ID != tc.id {
				t.Errorf("id %q, want %q", req.ID, tc.id)
			}
			if tc.code == "" {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				if req.V != ProtocolVersion || req.Method == "" {
					t.Fatalf("got %+v", req)
				}
				if string(req.Params) != tc.params {
					t.Fatalf("params %q, want %q", req.Params, tc.params)
				}
				return
			}
			e, ok := errors.AsType[*Error](err)
			if !ok || e.Code != tc.code {
				t.Fatalf("error %v, want code %s", err, tc.code)
			}
			if !strings.Contains(e.Message, tc.msg) {
				t.Fatalf("message %q does not mention %q", e.Message, tc.msg)
			}
		})
	}
}

func TestDispatch(t *testing.T) {
	type result = string // expected result JSON
	tests := []struct {
		name, method, params string
		h                    *fakeHandler
		want                 result
		code                 Code
		msg                  string
	}{
		{name: "status", method: MethodStatus,
			want: `{"state":"on","since":"2026-11-10T09:30:00Z","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "status empty params", method: MethodStatus, params: `{}`,
			want: `{"state":"on","since":"2026-11-10T09:30:00Z","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "status unknown param", method: MethodStatus, params: `{"x":1}`, code: CodeBadRequest, msg: `unknown param "x"`},
		{name: "status params not an object", method: MethodStatus, params: `[1]`, code: CodeBadRequest, msg: "JSON object"},
		{name: "status protocol is stamped", method: MethodStatus,
			h:    &fakeHandler{statusFn: func(context.Context) (Status, error) { return Status{State: StateOff, Version: "v", Protocol: 7}, nil }},
			want: `{"state":"off","version":"v","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "enable", method: MethodEnable, want: `{"state":"starting","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "links nil is empty array", method: MethodLinks, want: `{"links":[]}`},
		{name: "links", method: MethodLinks,
			h:    &fakeHandler{links: []Link{{Name: "en0", Index: 4, Up: true, State: LinkUp, LimitMbps: 5}}},
			want: `{"links":[{"name":"en0","index":4,"up":true,"state":"up","limitMbps":5}]}`},
		{name: "stats nil is empty array", method: MethodStats, want: `{"at":"2026-11-10T09:30:00Z","links":[]}`},
		{name: "stats", method: MethodStats,
			h:    &fakeHandler{stats: []LinkStats{{Name: "en0", RxBps: 1, TxBps: 2, LinkRxBps: 3, LinkTxBps: 4, ActiveFlows: 5, TotalFlows: 6, Weight: 0.5, Failed: 7}}},
			want: `{"at":"2026-11-10T09:30:00Z","links":[{"name":"en0","rxBps":1,"txBps":2,"linkRxBps":3,"linkTxBps":4,"activeFlows":5,"totalFlows":6,"weight":0.5,"failed":7}]}`},
		{name: "stats NaN is internal", method: MethodStats,
			h:    &fakeHandler{stats: []LinkStats{{Name: "en0", Weight: math.NaN()}}},
			code: CodeInternal, msg: "encoding the stats result"},
		{name: "disable", method: MethodDisable, want: `{"state":"off","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "disable reason", method: MethodDisable, params: `{"reason":"VPN"}`,
			want: `{"state":"off","reason":"VPN","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "disable null reason", method: MethodDisable, params: `{"reason":null}`,
			want: `{"state":"off","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "disable numeric reason", method: MethodDisable, params: `{"reason":5}`, code: CodeBadRequest, msg: "reason"},
		{name: "disable unknown param", method: MethodDisable, params: `{"why":"x"}`, code: CodeBadRequest, msg: `unknown param "why"`},
		{name: "setLimit", method: MethodSetLimit, params: `{"link":"en0","mbps":50}`, want: `{"link":"en0","mbps":50}`},
		{name: "setLimit zero keeps mbps", method: MethodSetLimit, params: `{"link":"en0","mbps":0}`, want: `{"link":"en0","mbps":0}`},
		{name: "setLimit max", method: MethodSetLimit, params: `{"link":"en0","mbps":1000000}`, want: `{"link":"en0","mbps":1000000}`},
		{name: "setLimit negative", method: MethodSetLimit, params: `{"link":"en0","mbps":-1}`, code: CodeBadRequest, msg: "between 0 and 1000000"},
		{name: "setLimit too big", method: MethodSetLimit, params: `{"link":"en0","mbps":1000000.5}`, code: CodeBadRequest, msg: "between"},
		{name: "setLimit no params", method: MethodSetLimit, code: CodeBadRequest, msg: "link"},
		{name: "setLimit missing link", method: MethodSetLimit, params: `{"mbps":5}`, code: CodeBadRequest, msg: "link"},
		{name: "setLimit numeric link", method: MethodSetLimit, params: `{"link":5,"mbps":5}`, code: CodeBadRequest, msg: "link"},
		{name: "setLimit empty link", method: MethodSetLimit, params: `{"link":"","mbps":5}`, code: CodeBadRequest, msg: "link name"},
		{name: "setLimit missing mbps", method: MethodSetLimit, params: `{"link":"en0"}`, code: CodeBadRequest, msg: "mbps"},
		{name: "setLimit null mbps", method: MethodSetLimit, params: `{"link":"en0","mbps":null}`, code: CodeBadRequest, msg: "mbps"},
		{name: "setLimit string mbps", method: MethodSetLimit, params: `{"link":"en0","mbps":"5"}`, code: CodeBadRequest, msg: "mbps"},
		{name: "setLimit extra param", method: MethodSetLimit, params: `{"link":"en0","mbps":5,"burst":1}`, code: CodeBadRequest, msg: "burst"},
		{name: "setAutoResume on", method: MethodSetAutoResume, params: `{"enabled":true}`,
			want: `{"state":"off","version":"test","protocol":1,"autoResume":true,"stickySites":false}`},
		{name: "setAutoResume off", method: MethodSetAutoResume, params: ` { "enabled" : false } `,
			want: `{"state":"off","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "setAutoResume no params", method: MethodSetAutoResume, code: CodeBadRequest, msg: "enabled, a boolean"},
		{name: "setAutoResume null", method: MethodSetAutoResume, params: `{"enabled":null}`, code: CodeBadRequest, msg: "enabled"},
		{name: "setAutoResume string", method: MethodSetAutoResume, params: `{"enabled":"true"}`, code: CodeBadRequest, msg: "enabled"},
		{name: "setAutoResume number", method: MethodSetAutoResume, params: `{"enabled":1}`, code: CodeBadRequest, msg: "enabled"},
		{name: "setAutoResume extra param", method: MethodSetAutoResume, params: `{"enabled":true,"now":true}`, code: CodeBadRequest, msg: `unknown param "now"`},
		{name: "setAutoResume params not an object", method: MethodSetAutoResume, params: `true`, code: CodeBadRequest, msg: "JSON object"},
		{name: "setAutoResume handler error", method: MethodSetAutoResume, params: `{"enabled":true}`,
			h: &fakeHandler{err: Errorf(CodeInternal, "disk full")}, code: CodeInternal, msg: "disk full"},
		{name: "setStickySites off", method: MethodSetStickySites, params: `{"enabled":false}`,
			want: `{"state":"off","version":"test","protocol":1,"autoResume":false,"stickySites":false}`},
		{name: "setStickySites on", method: MethodSetStickySites, params: `{"enabled":true}`,
			want: `{"state":"off","version":"test","protocol":1,"autoResume":false,"stickySites":true}`},
		{name: "setStickySites no params", method: MethodSetStickySites, code: CodeBadRequest, msg: "setStickySites needs enabled, a boolean"},
		{name: "setStickySites string", method: MethodSetStickySites, params: `{"enabled":"on"}`, code: CodeBadRequest, msg: "enabled"},
		{name: "setStickySites extra param", method: MethodSetStickySites, params: `{"enabled":true,"sites":1}`, code: CodeBadRequest, msg: `unknown param "sites"`},
		{name: "setStickySites handler error", method: MethodSetStickySites, params: `{"enabled":true}`,
			h: &fakeHandler{err: Errorf(CodeInternal, "disk full")}, code: CodeInternal, msg: "disk full"},
		{name: "events nil is empty array", method: MethodEvents, want: `{"events":[]}`},
		{name: "events", method: MethodEvents,
			h: &fakeHandler{events: []LinkEvent{
				{At: testTime, Link: "en0", From: LinkUp, To: LinkDown, Reason: EventProbeFailed},
				{At: testTime.Add(time.Second), Link: "en7", From: LinkGone, To: LinkUnknown, Reason: EventReturned},
			}},
			want: `{"events":[{"at":"2026-11-10T09:30:00Z","link":"en0","from":"up","to":"down","reason":"probe-failed"},` +
				`{"at":"2026-11-10T09:30:01Z","link":"en7","from":"gone","to":"unknown","reason":"returned"}]}`},
		{name: "events unknown param", method: MethodEvents, params: `{"since":"x"}`, code: CodeBadRequest, msg: `unknown param "since"`},
		{name: "events handler error", method: MethodEvents, h: &fakeHandler{err: errors.New("boom")}, code: CodeInternal, msg: "boom"},
		{name: "unknown method", method: "reboot", code: CodeUnknownMethod, msg: `"reboot"`},
		{name: "api error", method: MethodEnable, h: &fakeHandler{err: Errorf(CodeVPNActive, "utun4 has the default route")},
			code: CodeVPNActive, msg: "utun4 has the default route"},
		{name: "wrapped api error", method: MethodEnable, h: &fakeHandler{err: fmt.Errorf("enable: %w", Errorf(CodeNoUsableLinks, "none"))},
			code: CodeNoUsableLinks, msg: "none"},
		{name: "plain error is internal", method: MethodLinks, h: &fakeHandler{err: errors.New("boom")},
			code: CodeInternal, msg: "boom"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := tc.h
			if h == nil {
				h = &fakeHandler{}
			}
			req := Request{V: ProtocolVersion, ID: "id-1", Method: tc.method}
			if tc.params != "" {
				req.Params = json.RawMessage(tc.params)
			}
			resp := Dispatch(context.Background(), h, req)
			if tc.code != "" {
				expectCode(t, resp, "id-1", tc.code)
				if !strings.Contains(resp.Error.Message, tc.msg) {
					t.Fatalf("message %q does not mention %q", resp.Error.Message, tc.msg)
				}
				if resp.Result != nil {
					t.Fatalf("error response carries a result: %s", resp.Result)
				}
				return
			}
			if !resp.OK || resp.ID != "id-1" || resp.Error != nil {
				t.Fatalf("got %+v (error %v)", resp, resp.Error)
			}
			if !jsonEqual(t, resp.Result, []byte(tc.want)) {
				t.Fatalf("result %s, want %s", resp.Result, tc.want)
			}
		})
	}
}

func TestDispatchPassesParams(t *testing.T) {
	h := &fakeHandler{}
	ctx := context.Background()
	Dispatch(ctx, h, Request{V: 1, ID: "1", Method: MethodDisable, Params: json.RawMessage(`{"reason":"bye"}`)})
	Dispatch(ctx, h, Request{V: 1, ID: "2", Method: MethodSetLimit, Params: json.RawMessage(`{"link":"en7","mbps":12.5}`)})
	Dispatch(ctx, h, Request{V: 1, ID: "3", Method: MethodSetAutoResume, Params: json.RawMessage(`{"enabled":true}`)})
	Dispatch(ctx, h, Request{V: 1, ID: "4", Method: MethodSetAutoResume, Params: json.RawMessage(`{"enabled":false}`)})
	Dispatch(ctx, h, Request{V: 1, ID: "5", Method: MethodSetStickySites, Params: json.RawMessage(`{"enabled":false}`)})
	if len(h.disables) != 1 || h.disables[0].Reason != "bye" {
		t.Fatalf("disable params %+v", h.disables)
	}
	if len(h.limits) != 1 || h.limits[0] != (SetLimitParams{Link: "en7", Mbps: 12.5}) {
		t.Fatalf("setLimit params %+v", h.limits)
	}
	if len(h.resumes) != 2 || !h.resumes[0].Enabled || h.resumes[1].Enabled {
		t.Fatalf("setAutoResume params %+v", h.resumes)
	}
	if len(h.stickies) != 1 || h.stickies[0].Enabled {
		t.Fatalf("setStickySites params %+v", h.stickies)
	}
}

func TestSetLimitParamsValidate(t *testing.T) {
	for _, p := range []SetLimitParams{
		{Link: "en0", Mbps: math.NaN()},
		{Link: "en0", Mbps: math.Inf(1)},
		{Link: "en0", Mbps: -0.001},
		{Link: "", Mbps: 1},
	} {
		if err := p.Validate(); err == nil {
			t.Errorf("%+v: no error", p)
		}
	}
	for _, p := range []SetLimitParams{{Link: "en0"}, {Link: "en0", Mbps: MaxLimitMbps}, {Link: "en0", Mbps: 0.1}} {
		if err := p.Validate(); err != nil {
			t.Errorf("%+v: %v", p, err)
		}
	}
}

func TestErrorAndCodes(t *testing.T) {
	e := Errorf(CodeVPNActive, "utun%d is up", 4)
	if e.Error() != "VPN_ACTIVE: utun4 is up" {
		t.Fatalf("Error() = %q", e.Error())
	}
	if AsError(nil) != nil {
		t.Fatal("AsError(nil) is not nil")
	}
	if got := AsError(fmt.Errorf("ctx: %w", e)); got != e {
		t.Fatalf("AsError lost the wrapped *Error: %+v", got)
	}
	if got := AsError(errors.New("disk full")); got.Code != CodeInternal || got.Message != "disk full" {
		t.Fatalf("plain error mapped to %+v", got)
	}
	if !CodeNotRoot.Valid() || Code("NOPE").Valid() || Code("").Valid() {
		t.Fatal("Code.Valid is wrong")
	}
	if len(Codes()) != 8 || len(Methods()) != 9 || len(EventReasons()) != 6 {
		t.Fatalf("%d codes, %d methods, %d event reasons", len(Codes()), len(Methods()), len(EventReasons()))
	}
	m := Methods()
	m[0] = "changed"
	c := Codes()
	c[0] = "changed"
	r := EventReasons()
	r[0] = "changed"
	if Methods()[0] != MethodStatus || Codes()[0] != CodeBadRequest || EventReasons()[0] != EventFound {
		t.Fatal("Methods/Codes/EventReasons return shared slices")
	}
	for _, code := range Codes() {
		if !code.Valid() || strings.ToUpper(string(code)) != string(code) {
			t.Errorf("code %q", code)
		}
	}
}

func TestOKResponse(t *testing.T) {
	resp, err := OKResponse("9", SetLimitResult{Link: "en0"})
	if err != nil || !resp.OK || resp.ID != "9" || string(resp.Result) != `{"link":"en0","mbps":0}` {
		t.Fatalf("%+v %v", resp, err)
	}
	for _, bad := range []any{5, []int{1}, nil, math.Inf(-1)} {
		if _, err := OKResponse("9", bad); err == nil {
			t.Errorf("%v: no error", bad)
		}
	}
}

func TestErrorResponse(t *testing.T) {
	resp := ErrorResponse("3", nil)
	expectCode(t, resp, "3", CodeInternal)
	orig := Errorf(CodeNotRoot, "x")
	resp = ErrorResponse("3", orig)
	expectCode(t, resp, "3", CodeNotRoot)
	if resp.Error == orig {
		t.Fatal("ErrorResponse shares the handler's *Error")
	}
}

func TestEncodeResponse(t *testing.T) {
	b, err := EncodeResponse(ErrorResponse("", Errorf(CodeNotAuthorized, "no")))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"id":"","ok":false,"error":{"code":"NOT_AUTHORIZED","message":"no"}}` + "\n"
	if string(b) != want {
		t.Fatalf("got %q, want %q", b, want)
	}
	if strings.Count(string(b), "\n") != 1 {
		t.Fatal("a response must be exactly one line")
	}
	if _, err := EncodeResponse(Response{V: 1, ID: "1", OK: true, Result: json.RawMessage(`{`)}); err == nil {
		t.Fatal("invalid result encoded")
	}
}

func TestParseResponse(t *testing.T) {
	valid := []string{
		`{"v":1,"id":"1","ok":true,"result":{}}`,
		`{"v":1,"id":"1","ok":true,"result":{"x":1},"extra":2}` + "\n",
		`{"v":1,"id":"1","ok":true,"result":{},"error":null}`,
		`{"v":1,"id":"","ok":false,"error":{"code":"NOT_AUTHORIZED","message":"no"}}`,
	}
	for _, line := range valid {
		if _, err := ParseResponse([]byte(line)); err != nil {
			t.Errorf("%s: %v", line, err)
		}
	}
	invalid := []string{
		``,
		`nope`,
		`[1]`,
		`{"v":1,"id":"1","ok":true,"result":{}} x`,
		`{"v":2,"id":"1","ok":true,"result":{}}`,
		`{"id":"1","ok":true,"result":{}}`,
		`{"v":1,"id":"1","ok":true}`,
		`{"v":1,"id":"1","ok":true,"result":5}`,
		`{"v":1,"id":"1","ok":true,"result":{},"error":{"code":"INTERNAL","message":"x"}}`,
		`{"v":1,"id":"1","ok":false}`,
		`{"v":1,"id":"1","ok":false,"error":{"code":"NOPE","message":"x"}}`,
		`{"v":1,"id":"1","ok":false,"error":{"code":"INTERNAL","message":""}}`,
		`{"v":1,"id":"1","ok":false,"error":{"code":"INTERNAL","message":"x"},"result":{}}`,
	}
	for _, line := range invalid {
		_, err := ParseResponse([]byte(line))
		if err == nil {
			t.Errorf("%s: no error", line)
			continue
		}
		if _, isAPI := errors.AsType[*Error](err); isAPI {
			t.Errorf("%s: a malformed response must not look like a daemon error: %v", line, err)
		}
	}
}
