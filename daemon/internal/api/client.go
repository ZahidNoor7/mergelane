package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"
)

// maxResponseBytes is the longest response line a Client reads. Responses are small (a stats
// result for a dozen links is about 2 KiB); the cap only stops a broken peer from filling memory.
const maxResponseBytes = 1 << 20

// Client talks to the daemon over one connection. Calls are serialised; a Client is safe for
// concurrent use. After a transport error, a cancelled call or a connection-level error (one with
// id "", such as NOT_AUTHORIZED) the stream cannot be trusted any more, and every later call fails.
type Client struct {
	mu   sync.Mutex
	conn net.Conn
	r    *bufio.Reader
	next uint64
	err  error // sticky; set once the connection is unusable
}

// Dial connects to the daemon's socket at path (normally SocketPath).
func Dial(path string) (*Client, error) {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, fmt.Errorf("api: %w", err)
	}
	return NewClient(conn), nil
}

// NewClient wraps an open connection.
func NewClient(conn net.Conn) *Client {
	return &Client{conn: conn, r: bufio.NewReaderSize(conn, maxResponseBytes)}
}

// Close closes the connection.
func (c *Client) Close() error { return c.conn.Close() }

// Call sends one request and waits for its response. params may be nil (no params); result may be
// nil (result ignored) or a pointer to decode the result into. A response with ok false is
// returned as an *Error; ctx's cancellation and deadline abort the call.
func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.next++
	req := Request{V: ProtocolVersion, ID: strconv.FormatUint(c.next, 10), Method: method}
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("api: encoding %s params: %w", method, err)
		}
		req.Params = b
	}
	line, _ := json.Marshal(req) // cannot fail: every field is a string, an int or valid JSON
	if len(line) > MaxLineBytes {
		return fmt.Errorf("api: %s request is %d bytes, more than the %d the daemon reads", method, len(line), MaxLineBytes)
	}
	line = append(line, '\n')

	resp, err := c.roundTrip(ctx, line)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			err = ctxErr
		}
		c.err = fmt.Errorf("api: connection unusable after an earlier error: %w", err)
		return fmt.Errorf("api: %s: %w", method, err)
	}
	if resp.ID != req.ID && (resp.ID != "" || resp.OK) { // id "" only carries connection-level errors
		c.err = fmt.Errorf("api: response id %q does not match request id %q", resp.ID, req.ID)
		return c.err
	}
	if !resp.OK {
		if resp.ID == "" {
			c.err = resp.Error
		}
		return resp.Error
	}
	if result != nil {
		if err := json.Unmarshal(resp.Result, result); err != nil {
			return fmt.Errorf("api: decoding %s result: %w", method, err)
		}
	}
	return nil
}

// roundTrip writes line and reads one response, honouring ctx.
func (c *Client) roundTrip(ctx context.Context, line []byte) (Response, error) {
	// Clear the past deadline an earlier call's ctx may have left. ctx's own deadline needs no
	// conn deadline: ctx is done when it passes, and AfterFunc interrupts the call then.
	if err := c.conn.SetDeadline(time.Time{}); err != nil {
		return Response{}, err
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		c.conn.SetDeadline(time.Unix(1, 0)) // in the past: wakes the blocked read or write
		close(interrupted)
	})
	defer func() {
		if !stop() {
			<-interrupted // let it finish before the next call sets its own deadline
		}
	}()

	if _, werr := c.conn.Write(line); werr != nil {
		// The daemon may have refused this peer and closed before the request arrived. Its
		// NOT_AUTHORIZED line can still be waiting to be read, and says more than EPIPE does.
		if resp, err := c.readResponse(); err == nil && resp.ID == "" {
			return resp, nil
		}
		return Response{}, werr
	}
	return c.readResponse()
}

func (c *Client) readResponse() (Response, error) {
	b, err := c.r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return Response{}, fmt.Errorf("response is longer than %d bytes", maxResponseBytes)
	}
	if err != nil {
		return Response{}, err
	}
	return ParseResponse(b)
}

// Status calls status.
func (c *Client) Status(ctx context.Context) (Status, error) {
	var s Status
	err := c.Call(ctx, MethodStatus, nil, &s)
	return s, err
}

// Enable calls enable.
func (c *Client) Enable(ctx context.Context) (Status, error) {
	var s Status
	err := c.Call(ctx, MethodEnable, nil, &s)
	return s, err
}

// Disable calls disable; reason may be empty.
func (c *Client) Disable(ctx context.Context, reason string) (Status, error) {
	var s Status
	err := c.Call(ctx, MethodDisable, DisableParams{Reason: reason}, &s)
	return s, err
}

// Links calls links.
func (c *Client) Links(ctx context.Context) (LinksResult, error) {
	var l LinksResult
	err := c.Call(ctx, MethodLinks, nil, &l)
	return l, err
}

// Stats calls stats.
func (c *Client) Stats(ctx context.Context) (Stats, error) {
	var s Stats
	err := c.Call(ctx, MethodStats, nil, &s)
	return s, err
}

// SetLimit calls setLimit; mbps 0 removes the cap.
func (c *Client) SetLimit(ctx context.Context, link string, mbps float64) (SetLimitResult, error) {
	var r SetLimitResult
	err := c.Call(ctx, MethodSetLimit, SetLimitParams{Link: link, Mbps: mbps}, &r)
	return r, err
}

// SetAutoResume calls setAutoResume. An older daemon answers UNKNOWN_METHOD.
func (c *Client) SetAutoResume(ctx context.Context, enabled bool) (Status, error) {
	var s Status
	err := c.Call(ctx, MethodSetAutoResume, SetAutoResumeParams{Enabled: enabled}, &s)
	return s, err
}

// SetStickySites calls setStickySites. An older daemon answers UNKNOWN_METHOD.
func (c *Client) SetStickySites(ctx context.Context, enabled bool) (Status, error) {
	var s Status
	err := c.Call(ctx, MethodSetStickySites, SetStickySitesParams{Enabled: enabled}, &s)
	return s, err
}

// Events calls events. An older daemon answers UNKNOWN_METHOD.
func (c *Client) Events(ctx context.Context) (EventsResult, error) {
	var r EventsResult
	err := c.Call(ctx, MethodEvents, nil, &r)
	return r, err
}
