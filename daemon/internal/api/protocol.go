// Package api is the versioned control protocol between Mergelane.app and mergelane-daemon
// (docs/DECISIONS.md ADR-0005). The TypeScript mirror is shared/daemon-api.ts, and both sides test
// against the example messages in shared/fixtures/daemon-api/.
//
// Protocol v1 is newline-delimited JSON over a Unix stream socket. Every line a client sends is one
// request, and the daemon answers each one with exactly one line, in order, echoing its id:
//
//	{"v":1,"id":"7","method":"setLimit","params":{"link":"en0","mbps":50}}
//	{"v":1,"id":"7","ok":true,"result":{"link":"en0","mbps":50}}
//	{"v":1,"id":"7","ok":false,"error":{"code":"VPN_ACTIVE","message":"..."}}
//
// A connection may carry any number of requests. An error that does not belong to one request (a
// peer that is not allowed, a line that is not JSON, a line that is too long) is answered with id "".
//
// Versions. "v" is the wire format's version, and a daemon accepts only its own (UNSUPPORTED_VERSION
// otherwise), so the oldest app protocol a daemon accepts is always the one status reports as protocol.
// Within v1 changes are additive only: a new method, a new optional param, a new result field. An app
// that uses a newer method must expect UNKNOWN_METHOD from an older daemon (setAutoResume and events
// arrived in M2.4) and should read status.version, the daemon's build version (-X main.version), to
// offer a helper update. Anything that is not additive needs protocol v2.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"
)

// ProtocolVersion is the "v" every message carries.
const ProtocolVersion = 1

// SocketPath is where the daemon listens (ADR-0005).
const SocketPath = "/var/run/mergelane/daemon.sock"

// MaxLineBytes is the longest request line the daemon reads, not counting the newline. A longer
// line is answered with BAD_REQUEST and the connection is closed, because the stream can no longer
// be split into messages reliably.
const MaxLineBytes = 64 << 10

// MaxLimitMbps is the largest per-link cap setLimit accepts, in Mbit/s. It is the same ceiling the
// engine and limits.json accept.
const MaxLimitMbps = 1e6

// The methods of protocol v1. setAutoResume and events were added in M2.4; an older daemon answers
// them with UNKNOWN_METHOD.
const (
	MethodStatus        = "status"
	MethodEnable        = "enable"
	MethodDisable       = "disable"
	MethodLinks         = "links"
	MethodStats         = "stats"
	MethodSetLimit      = "setLimit"
	MethodSetAutoResume = "setAutoResume"
	MethodEvents        = "events"
)

var methods = [...]string{
	MethodStatus, MethodEnable, MethodDisable, MethodLinks, MethodStats, MethodSetLimit,
	MethodSetAutoResume, MethodEvents,
}

// Methods lists every method of protocol v1.
func Methods() []string { return slices.Clone(methods[:]) }

// Code is a stable, machine-readable error code. Codes never change meaning within a protocol
// version; adding one means a new protocol version.
type Code string

// The error codes of protocol v1.
const (
	CodeBadRequest         Code = "BAD_REQUEST"         // malformed, oversized or invalid request
	CodeUnsupportedVersion Code = "UNSUPPORTED_VERSION" // "v" is not ProtocolVersion
	CodeUnknownMethod      Code = "UNKNOWN_METHOD"      // "method" is not one of Methods()
	CodeNotAuthorized      Code = "NOT_AUTHORIZED"      // the peer's uid may not control the daemon
	CodeVPNActive          Code = "VPN_ACTIVE"          // another VPN owns the routes; merge refuses
	CodeNoUsableLinks      Code = "NO_USABLE_LINKS"     // no link can carry traffic right now
	CodeNotRoot            Code = "NOT_ROOT"            // the daemon lacks the privileges it needs
	CodeInternal           Code = "INTERNAL"            // anything else; the message says what
)

var codes = [...]Code{
	CodeBadRequest, CodeUnsupportedVersion, CodeUnknownMethod, CodeNotAuthorized,
	CodeVPNActive, CodeNoUsableLinks, CodeNotRoot, CodeInternal,
}

// Codes lists every error code of protocol v1.
func Codes() []Code { return slices.Clone(codes[:]) }

// Valid reports whether c is one of Codes().
func (c Code) Valid() bool { return slices.Contains(codes[:], c) }

// Error is a protocol error: a stable code plus a message a person can read. Handlers return one
// (directly or wrapped) to choose the code the client sees; any other error becomes INTERNAL.
type Error struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

// Errorf builds an *Error with a formatted message.
func Errorf(code Code, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// AsError maps err to the *Error the client sees: the *Error inside err if there is one, otherwise
// INTERNAL with err's text. It returns nil for a nil err.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := errors.AsType[*Error](err); ok && e != nil {
		return e
	}
	return &Error{Code: CodeInternal, Message: err.Error()}
}

// Request is one request line.
type Request struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is one response line. Exactly one of Result (OK true) and Error (OK false) is set.
type Response struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// State is whether system-wide merging is on.
type State string

// The daemon states.
const (
	StateOff      State = "off"
	StateOn       State = "on"
	StateStarting State = "starting"
	StateStopping State = "stopping"
)

// Status is the result of status, enable, disable and setAutoResume.
type Status struct {
	State State `json:"state"`
	// Reason says why merging is off when it did not go off on request, for example a VPN
	// conflict or the restart after a crash, or that it came back on by itself after a crash.
	// Empty otherwise.
	Reason string `json:"reason,omitempty"`
	// Since is when State last changed; zero if unknown. Sent as RFC 3339.
	Since time.Time `json:"since,omitzero"`
	// Version is the daemon's build version (-X main.version at build time, "dev" otherwise).
	Version string `json:"version"`
	// Protocol is always ProtocolVersion; Dispatch fills it in.
	Protocol int `json:"protocol"`
	// AutoResume is the "turn system merge back on after a crash" setting (setAutoResume). Always
	// sent since M2.4; older daemons leave it out.
	AutoResume bool `json:"autoResume"`
}

// DisableParams are disable's params.
type DisableParams struct {
	// Reason is shown as Status.Reason afterwards. Empty means the user asked.
	Reason string `json:"reason,omitempty"`
}

// LinkState is the result of a link's internet probe.
type LinkState string

// The link states.
const (
	LinkUp      LinkState = "up"
	LinkUnknown LinkState = "unknown" // not probed yet
	LinkDown    LinkState = "down"
)

// Link is one network link the daemon can use.
type Link struct {
	Name  string `json:"name"`  // BSD name, e.g. "en0"
	Index int    `json:"index"` // interface index
	// Kind is System Settings' name for the hardware port, e.g. "Wi-Fi" or "iPhone USB".
	Kind string `json:"kind,omitempty"`
	IPv4 string `json:"ipv4,omitempty"`
	IPv6 string `json:"ipv6,omitempty"`
	// Up is the interface flag; State is whether the internet is reachable through it.
	Up    bool      `json:"up"`
	State LinkState `json:"state"`
	// LimitMbps is the link's cap in Mbit/s; absent (0) means no cap.
	LimitMbps float64 `json:"limitMbps,omitempty"`
}

// LinksResult is the result of links.
type LinksResult struct {
	Links []Link `json:"links"`
}

// LinkStats is one link's traffic. Rates are in bytes per second.
type LinkStats struct {
	Name string `json:"name"`
	// RxBps and TxBps count only traffic that system merging sent through this link.
	RxBps float64 `json:"rxBps"`
	TxBps float64 `json:"txBps"`
	// LinkRxBps and LinkTxBps count everything on the interface, from the OS's counters.
	LinkRxBps   float64 `json:"linkRxBps"`
	LinkTxBps   float64 `json:"linkTxBps"`
	ActiveFlows int64   `json:"activeFlows"`
	TotalFlows  int64   `json:"totalFlows"`
	// Weight is the link's share in the balancer.
	Weight float64 `json:"weight"`
	// Failed counts flows that could not be connected through this link.
	Failed int64 `json:"failed"`
}

// Stats is the result of stats.
type Stats struct {
	At    time.Time   `json:"at"`
	Links []LinkStats `json:"links"`
}

// SetLimitParams are setLimit's params.
type SetLimitParams struct {
	Link string  `json:"link"`
	Mbps float64 `json:"mbps"` // 0 removes the cap
}

// Validate checks the ranges setLimit accepts.
func (p SetLimitParams) Validate() error {
	if p.Link == "" {
		return Errorf(CodeBadRequest, "setLimit needs a link name")
	}
	// The negated form also rejects NaN, which JSON cannot carry but a Go caller can.
	if !(p.Mbps >= 0 && p.Mbps <= MaxLimitMbps) {
		return Errorf(CodeBadRequest, "mbps must be between 0 and %.0f", float64(MaxLimitMbps))
	}
	return nil
}

// SetLimitResult is the result of setLimit: the cap now in force.
type SetLimitResult struct {
	Link string  `json:"link"`
	Mbps float64 `json:"mbps"`
}

// SetAutoResumeParams are setAutoResume's params.
type SetAutoResumeParams struct {
	// Enabled turns "turn system merge back on after a crash" on or off. It is saved, and takes
	// effect at the daemon's next start after a crash.
	Enabled bool `json:"enabled"`
}

// LinkGone is a link's state in events while its interface is not there (unplugged, asleep, or
// without an address or default route). links never reports it: a gone link is not listed.
const LinkGone LinkState = "gone"

// LinkEventReason says why a link's state changed. Like the error codes, the set is closed within a
// protocol version: the app's guard refuses a reason it does not know, so a new one means protocol v2.
type LinkEventReason string

// The link event reasons.
const (
	EventFound       LinkEventReason = "found"        // a link the daemon had not seen appeared
	EventLost        LinkEventReason = "lost"         // the interface, its address or its default route went away
	EventReturned    LinkEventReason = "returned"     // a link that had gone came back, perhaps with a new index
	EventAddress     LinkEventReason = "address"      // its address changed, so it is checked again
	EventProbeOK     LinkEventReason = "probe-ok"     // the internet check through it passed
	EventProbeFailed LinkEventReason = "probe-failed" // the internet check through it failed
)

var eventReasons = [...]LinkEventReason{EventFound, EventLost, EventReturned, EventAddress, EventProbeOK, EventProbeFailed}

// EventReasons lists every link event reason.
func EventReasons() []LinkEventReason { return slices.Clone(eventReasons[:]) }

// LinkEvent is one change in a link's state, for the failover history.
type LinkEvent struct {
	At   time.Time `json:"at"`   // RFC 3339
	Link string    `json:"link"` // BSD name, e.g. "en0"
	// From and To are LinkUp, LinkUnknown, LinkDown or LinkGone. The state is the one links reports:
	// the IPv4 internet check, or the IPv6 one on a link without IPv4.
	From   LinkState       `json:"from"`
	To     LinkState       `json:"to"`
	Reason LinkEventReason `json:"reason"`
}

// MaxEvents is how many link events the daemon keeps; older ones are dropped.
const MaxEvents = 50

// EventsResult is the result of events: the most recent link changes, oldest first, at most
// MaxEvents. The daemon keeps them in memory only, so they start empty at every daemon start.
type EventsResult struct {
	Events []LinkEvent `json:"events"`
}

// Handler carries out the methods. The daemon's controller implements it. ctx is cancelled when the
// server closes. A returned *Error (also wrapped) reaches the client with its code; any other error
// is sent as INTERNAL.
type Handler interface {
	Status(ctx context.Context) (Status, error)
	Enable(ctx context.Context) (Status, error)
	Disable(ctx context.Context, p DisableParams) (Status, error)
	Links(ctx context.Context) (LinksResult, error)
	Stats(ctx context.Context) (Stats, error)
	SetLimit(ctx context.Context, p SetLimitParams) (SetLimitResult, error)
	SetAutoResume(ctx context.Context, p SetAutoResumeParams) (Status, error)
	Events(ctx context.Context) (EventsResult, error)
}

// wireRequest is a request as sent, before its fields are checked.
type wireRequest struct {
	V      json.RawMessage `json:"v"`
	ID     json.RawMessage `json:"id"`
	Method json.RawMessage `json:"method"`
	Params json.RawMessage `json:"params"`
}

// ParseRequest decodes and checks one request line (with or without its newline). Unknown
// top-level fields are ignored; params are checked by Dispatch. The error is always an *Error, and
// the returned Request carries the id whenever it could be read, so the error response can echo it.
func ParseRequest(line []byte) (Request, error) {
	var req Request
	var w wireRequest
	if !isObject(line) || json.Unmarshal(line, &w) != nil {
		return req, Errorf(CodeBadRequest, "the request is not a JSON object")
	}
	if !isString(w.ID) {
		return req, Errorf(CodeBadRequest, "id must be a string")
	}
	_ = json.Unmarshal(w.ID, &req.ID) // cannot fail: w.ID is a valid JSON string
	if req.ID == "" {
		return req, Errorf(CodeBadRequest, "id must not be empty")
	}
	if isNull(w.V) {
		return req, Errorf(CodeBadRequest, "v (the protocol version) is missing")
	}
	var v any
	_ = json.Unmarshal(w.V, &v) // w.V is valid JSON; an out-of-range number is simply not 1
	n, isNum := v.(float64)
	if !isNum {
		return req, Errorf(CodeBadRequest, "v (the protocol version) must be a number")
	}
	if n != ProtocolVersion {
		return req, Errorf(CodeUnsupportedVersion,
			"protocol version %s is not supported; this daemon speaks version %d", w.V, ProtocolVersion)
	}
	req.V = ProtocolVersion
	if !isString(w.Method) {
		return req, Errorf(CodeBadRequest, "method must be a string")
	}
	_ = json.Unmarshal(w.Method, &req.Method) // cannot fail: w.Method is a valid JSON string
	if !isNull(w.Params) {
		if !isObject(w.Params) {
			return req, Errorf(CodeBadRequest, "params must be a JSON object")
		}
		req.Params = w.Params
	}
	return req, nil
}

// ParseResponse decodes and checks one response line (with or without its newline). Unknown
// fields, also inside result, are ignored. Its errors are plain errors, never *Error: a malformed
// response is the client's problem to report, not a code the daemon sent.
func ParseResponse(line []byte) (Response, error) {
	var resp Response
	if !isObject(line) || json.Unmarshal(line, &resp) != nil {
		return Response{}, errors.New("the response is not a valid JSON object")
	}
	if resp.V != ProtocolVersion {
		return Response{}, fmt.Errorf("the response has protocol version %d; this client speaks version %d",
			resp.V, ProtocolVersion)
	}
	if resp.OK {
		if !isObject(resp.Result) || resp.Error != nil {
			return Response{}, errors.New("an ok response needs a result object and no error")
		}
		return resp, nil
	}
	if resp.Error == nil || !resp.Error.Code.Valid() || resp.Error.Message == "" || len(resp.Result) > 0 {
		return Response{}, errors.New("a failed response needs an error with a known code and a message, and no result")
	}
	return resp, nil
}

// OKResponse builds the success response for id. It fails only if result cannot be encoded as JSON
// (a NaN or infinite number, for example).
func OKResponse(id string, result any) (Response, error) {
	b, err := json.Marshal(result)
	if err != nil {
		return Response{}, err
	}
	if !isObject(b) {
		return Response{}, fmt.Errorf("a result must be a JSON object, not %s", b)
	}
	return Response{V: ProtocolVersion, ID: id, OK: true, Result: b}, nil
}

// ErrorResponse builds the error response for id, mapping err with AsError.
func ErrorResponse(id string, err error) Response {
	e := AsError(err)
	if e == nil {
		e = &Error{Code: CodeInternal, Message: "unknown error"}
	}
	return Response{V: ProtocolVersion, ID: id, Error: &Error{Code: e.Code, Message: e.Message}}
}

// EncodeResponse returns resp as one line, newline included.
func EncodeResponse(resp Response) ([]byte, error) {
	b, err := json.Marshal(resp)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// Dispatch checks req's params, calls the matching Handler method and builds the response. req
// must have passed ParseRequest.
func Dispatch(ctx context.Context, h Handler, req Request) Response {
	result, err := call(ctx, h, req)
	if err != nil {
		return ErrorResponse(req.ID, err)
	}
	resp, err := OKResponse(req.ID, result)
	if err != nil {
		return ErrorResponse(req.ID, fmt.Errorf("encoding the %s result: %w", req.Method, err))
	}
	return resp
}

func call(ctx context.Context, h Handler, req Request) (any, error) {
	switch req.Method {
	case MethodStatus, MethodEnable, MethodLinks, MethodStats, MethodEvents:
		if _, err := paramFields(req.Params); err != nil {
			return nil, err
		}
	}
	switch req.Method {
	case MethodStatus:
		return withProtocol(h.Status(ctx))
	case MethodEnable:
		return withProtocol(h.Enable(ctx))
	case MethodDisable:
		p, err := parseDisable(req.Params)
		if err != nil {
			return nil, err
		}
		return withProtocol(h.Disable(ctx, p))
	case MethodLinks:
		res, err := h.Links(ctx)
		if res.Links == nil {
			res.Links = []Link{} // the TypeScript side expects an array, never null
		}
		return res, err
	case MethodStats:
		res, err := h.Stats(ctx)
		if res.Links == nil {
			res.Links = []LinkStats{}
		}
		return res, err
	case MethodSetLimit:
		p, err := parseSetLimit(req.Params)
		if err != nil {
			return nil, err
		}
		return h.SetLimit(ctx, p)
	case MethodSetAutoResume:
		p, err := parseSetAutoResume(req.Params)
		if err != nil {
			return nil, err
		}
		return withProtocol(h.SetAutoResume(ctx, p))
	case MethodEvents:
		res, err := h.Events(ctx)
		if res.Events == nil {
			res.Events = []LinkEvent{}
		}
		return res, err
	}
	return nil, Errorf(CodeUnknownMethod, "unknown method %q", req.Method)
}

// withProtocol stamps the protocol version on a status result, so a handler cannot get it wrong.
func withProtocol(s Status, err error) (any, error) {
	s.Protocol = ProtocolVersion
	return s, err
}

// paramFields splits params into its fields and refuses any field not in allowed. Params are
// strict, unlike the envelope: a misspelt "mbps" must not quietly mean "no cap".
func paramFields(raw json.RawMessage, allowed ...string) (map[string]json.RawMessage, error) {
	fields := map[string]json.RawMessage{}
	if !isNull(raw) {
		if !isObject(raw) || json.Unmarshal(raw, &fields) != nil {
			return nil, Errorf(CodeBadRequest, "params must be a JSON object")
		}
	}
	for _, k := range slices.Sorted(maps.Keys(fields)) {
		if !slices.Contains(allowed, k) {
			return nil, Errorf(CodeBadRequest, "unknown param %q", k)
		}
	}
	return fields, nil
}

func parseDisable(raw json.RawMessage) (DisableParams, error) {
	var p DisableParams
	f, err := paramFields(raw, "reason")
	if err != nil {
		return p, err
	}
	if r := f["reason"]; !isNull(r) {
		if !isString(r) {
			return p, Errorf(CodeBadRequest, "reason must be a string")
		}
		_ = json.Unmarshal(r, &p.Reason) // cannot fail: r is a valid JSON string
	}
	return p, nil
}

func parseSetLimit(raw json.RawMessage) (SetLimitParams, error) {
	var p SetLimitParams
	f, err := paramFields(raw, "link", "mbps")
	if err != nil {
		return p, err
	}
	if !isString(f["link"]) {
		return p, Errorf(CodeBadRequest, "setLimit needs link, a string")
	}
	_ = json.Unmarshal(f["link"], &p.Link) // cannot fail: a valid JSON string
	m := f["mbps"]
	if isNull(m) || json.Unmarshal(m, &p.Mbps) != nil {
		return p, Errorf(CodeBadRequest, "setLimit needs mbps, a number")
	}
	return p, p.Validate()
}

func parseSetAutoResume(raw json.RawMessage) (SetAutoResumeParams, error) {
	var p SetAutoResumeParams
	f, err := paramFields(raw, "enabled")
	if err != nil {
		return p, err
	}
	if !isBool(f["enabled"]) {
		return p, Errorf(CodeBadRequest, "setAutoResume needs enabled, a boolean")
	}
	_ = json.Unmarshal(f["enabled"], &p.Enabled) // cannot fail: a JSON true or false
	return p, nil
}

// isNull reports whether raw is absent or the JSON null literal.
func isNull(raw []byte) bool {
	t := bytes.TrimSpace(raw)
	return len(t) == 0 || string(t) == "null"
}

// isObject and isString look at the first byte only; callers have already parsed raw as JSON.
func isObject(raw []byte) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

func isString(raw []byte) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '"'
}

// isBool reports whether raw is the JSON true or false literal.
func isBool(raw []byte) bool {
	t := string(bytes.TrimSpace(raw))
	return t == "true" || t == "false"
}
