package api

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// fixtureDir holds the contract examples shared with shared/daemon-api.ts. Names are
// <method>[.<variant>].request.json, <method>[.<variant>].response.json and
// error.<code in kebab case>.response.json.
const fixtureDir = "../../../shared/fixtures/daemon-api"

type fixture struct {
	name   string // file name
	stem   string // name without .request.json / .response.json
	method string // first name part; "error" for error responses
	kind   string // "request" or "response"
	data   []byte
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatal(err)
	}
	var out []fixture
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			t.Fatalf("unexpected entry %s in %s", name, fixtureDir)
		}
		parts := strings.Split(strings.TrimSuffix(name, ".json"), ".")
		if len(parts) < 2 || len(parts) > 3 {
			t.Fatalf("fixture %s is not named <method>[.<variant>].request|response.json", name)
		}
		kind := parts[len(parts)-1]
		if kind != "request" && kind != "response" {
			t.Fatalf("fixture %s is neither a request nor a response", name)
		}
		data, err := os.ReadFile(filepath.Join(fixtureDir, name))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, fixture{
			name: name, stem: strings.Join(parts[:len(parts)-1], "."),
			method: parts[0], kind: kind, data: data,
		})
	}
	if len(out) == 0 {
		t.Fatal("no fixtures")
	}
	return out
}

// newResult returns a pointer to the result type of method.
func newResult(t *testing.T, method string) any {
	switch method {
	case MethodStatus, MethodEnable, MethodDisable, MethodSetAutoResume, MethodSetStickySites:
		return new(Status)
	case MethodEvents:
		return new(EventsResult)
	case MethodLinks:
		return new(LinksResult)
	case MethodStats:
		return new(Stats)
	case MethodSetLimit:
		return new(SetLimitResult)
	}
	t.Fatalf("no result type for method %q", method)
	return nil
}

// decodeStrict decodes JSON into v, refusing fields the Go type does not have, so a fixture cannot
// carry a field one side silently drops.
func decodeStrict(t *testing.T, data []byte, v any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("%s: %v", data, err)
	}
}

// requestParams decodes a request's params the way Dispatch does; nil for methods without params.
func requestParams(t *testing.T, req Request) any {
	t.Helper()
	var p any
	var err error
	switch req.Method {
	case MethodDisable:
		p, err = parseDisable(req.Params)
	case MethodSetLimit:
		p, err = parseSetLimit(req.Params)
	case MethodSetAutoResume:
		p, err = parseSetAutoResume(req.Params)
	case MethodSetStickySites:
		p, err = parseSetStickySites(req.Params)
	default:
		_, err = paramFields(req.Params)
	}
	if err != nil {
		t.Fatalf("params %s: %v", req.Params, err)
	}
	return p
}

func TestFixturesRoundTrip(t *testing.T) {
	reqs, resps, codes := map[string]bool{}, map[string]bool{}, map[Code]bool{}
	for _, f := range loadFixtures(t) {
		t.Run(f.name, func(t *testing.T) {
			if f.kind == "request" {
				decodeStrict(t, f.data, new(Request))
			} else {
				decodeStrict(t, f.data, new(Response))
			}
			var again []byte
			switch {
			case f.kind == "request":
				req, err := ParseRequest(f.data)
				if err != nil {
					t.Fatal(err)
				}
				if req.Method != f.method {
					t.Fatalf("method %q in a fixture named for %q", req.Method, f.method)
				}
				if p := requestParams(t, req); p != nil && req.Params != nil {
					decodeStrict(t, req.Params, reflect.New(reflect.TypeOf(p)).Interface())
					req.Params = mustJSON(t, p)
				}
				again = mustJSON(t, req)
				reqs[f.method] = true

			case f.method == "error":
				resp, err := ParseResponse(f.data)
				if err != nil {
					t.Fatal(err)
				}
				if resp.OK {
					t.Fatal("an error fixture with ok true")
				}
				slug := strings.ToLower(strings.ReplaceAll(string(resp.Error.Code), "_", "-"))
				if f.stem != "error."+slug {
					t.Fatalf("code %s belongs in error.%s.response.json", resp.Error.Code, slug)
				}
				again = mustJSON(t, resp)
				codes[resp.Error.Code] = true

			default:
				resp, err := ParseResponse(f.data)
				if err != nil {
					t.Fatal(err)
				}
				if !resp.OK {
					t.Fatal("a method response fixture must be ok; error examples are error.*.response.json")
				}
				result := newResult(t, f.method)
				decodeStrict(t, resp.Result, result)
				resp.Result = mustJSON(t, result)
				again = mustJSON(t, resp)
				resps[f.method] = true
			}
			if !jsonEqual(t, f.data, again) {
				t.Fatalf("round trip changed the message:\n got  %s\n want %s", again, f.data)
			}
		})
	}
	for _, m := range Methods() {
		if !reqs[m] || !resps[m] {
			t.Errorf("method %s needs a %s.request.json and a %s.response.json fixture", m, m, m)
		}
	}
	for _, c := range Codes() {
		if !codes[c] {
			t.Errorf("error code %s has no fixture", c)
		}
	}
}

// fixtureHandler answers with a fixed result and records the params it got.
type fixtureHandler struct {
	result any
	params any
}

func (h *fixtureHandler) status() (Status, error) { return *h.result.(*Status), nil }
func (h *fixtureHandler) Status(context.Context) (Status, error) {
	return h.status()
}
func (h *fixtureHandler) Enable(context.Context) (Status, error) { return h.status() }
func (h *fixtureHandler) Disable(_ context.Context, p DisableParams) (Status, error) {
	h.params = p
	return h.status()
}
func (h *fixtureHandler) Links(context.Context) (LinksResult, error) {
	return *h.result.(*LinksResult), nil
}
func (h *fixtureHandler) Stats(context.Context) (Stats, error) { return *h.result.(*Stats), nil }
func (h *fixtureHandler) SetLimit(_ context.Context, p SetLimitParams) (SetLimitResult, error) {
	h.params = p
	return *h.result.(*SetLimitResult), nil
}
func (h *fixtureHandler) SetAutoResume(_ context.Context, p SetAutoResumeParams) (Status, error) {
	h.params = p
	return h.status()
}
func (h *fixtureHandler) SetStickySites(_ context.Context, p SetStickySitesParams) (Status, error) {
	h.params = p
	return h.status()
}
func (h *fixtureHandler) Events(context.Context) (EventsResult, error) {
	return *h.result.(*EventsResult), nil
}

// TestFixturesMatchDispatch feeds every request fixture that has a response fixture of the same
// name through Dispatch, and checks the daemon would send exactly that response.
func TestFixturesMatchDispatch(t *testing.T) {
	byStem := map[string]map[string]fixture{}
	for _, f := range loadFixtures(t) {
		if byStem[f.stem] == nil {
			byStem[f.stem] = map[string]fixture{}
		}
		byStem[f.stem][f.kind] = f
	}
	pairs := 0
	for stem, pair := range byStem {
		reqF, ok1 := pair["request"]
		respF, ok2 := pair["response"]
		if !ok1 || !ok2 {
			continue
		}
		pairs++
		t.Run(stem, func(t *testing.T) {
			req, err := ParseRequest(reqF.data)
			if err != nil {
				t.Fatal(err)
			}
			want, err := ParseResponse(respF.data)
			if err != nil {
				t.Fatal(err)
			}
			h := &fixtureHandler{result: newResult(t, req.Method)}
			decodeStrict(t, want.Result, h.result)
			got := Dispatch(context.Background(), h, req)
			if !jsonEqual(t, mustJSON(t, got), respF.data) {
				t.Fatalf("Dispatch sent %s, fixture says %s", mustJSON(t, got), respF.data)
			}
			if p := requestParams(t, req); p != nil && !reflect.DeepEqual(h.params, p) {
				t.Fatalf("handler got params %+v, want %+v", h.params, p)
			}
		})
	}
	if pairs < len(Methods()) {
		t.Fatalf("only %d request/response pairs", pairs)
	}
}

// TestServerMatchesErrorFixtures checks that the daemon's own protocol errors are word for word the
// ones in the fixtures, so the TypeScript side tests against real output.
func TestServerMatchesErrorFixtures(t *testing.T) {
	fixtures := map[string][]byte{}
	for _, f := range loadFixtures(t) {
		fixtures[f.name] = f.data
	}
	s := startServer(t, &fakeHandler{}, allowAll)
	rc := dialRaw(t, s.Path())
	for _, tc := range []struct{ send, fixture string }{
		{`{"v":2,"id":"10","method":"status"}`, "error.unsupported-version.response.json"},
		{`{"v":1,"id":"11","method":"reboot"}`, "error.unknown-method.response.json"},
		{`{"v":1,"id":"9","method":"setLimit","params":{"link":"en0","mbps":2000000}}`, "error.bad-request.response.json"},
	} {
		rc.send(tc.send + "\n")
		if got := rc.line(); !jsonEqual(t, got, fixtures[tc.fixture]) {
			t.Errorf("sent %s for %s, fixture says %s", got, tc.send, fixtures[tc.fixture])
		}
	}

	refused := startServer(t, &fakeHandler{}, func(uint32) bool { return false })
	if got := dialRaw(t, refused.Path()).line(); !jsonEqual(t, got, fixtures["error.not-authorized.response.json"]) {
		t.Errorf("refusal %s differs from its fixture", got)
	}
}

// TestEventFixturesUseKnownValues checks the values Go's string types would let through: every
// event's states and reason are ones the daemon sends.
func TestEventFixturesUseKnownValues(t *testing.T) {
	states := []LinkState{LinkUp, LinkUnknown, LinkDown, LinkGone}
	seen := 0
	for _, f := range loadFixtures(t) {
		if f.method != MethodEvents || f.kind != "response" {
			continue
		}
		resp, err := ParseResponse(f.data)
		if err != nil {
			t.Fatal(err)
		}
		var res EventsResult
		decodeStrict(t, resp.Result, &res)
		for _, e := range res.Events {
			seen++
			if !slices.Contains(states, e.From) || !slices.Contains(states, e.To) || e.From == e.To {
				t.Errorf("%s: event %+v has an unknown or unchanged state", f.name, e)
			}
			if !slices.Contains(EventReasons(), e.Reason) || e.Link == "" || e.At.IsZero() {
				t.Errorf("%s: event %+v", f.name, e)
			}
		}
	}
	if seen == 0 {
		t.Fatal("no event fixture has events")
	}
}
