package engine

import (
	"bytes"
	"crypto/tls"
	"net"
	"os"
	"testing"
	"time"
)

// clientHello is what Go's own TLS client sends first for host ("" sends no server_name),
// captured from a pipe: real bytes, not hand-made ones.
func clientHello(t testing.TB, host string) []byte {
	t.Helper()
	client, server := net.Pipe()
	defer server.Close()
	go func() {
		c := tls.Client(client, &tls.Config{ServerName: host, InsecureSkipVerify: host == ""})
		_ = c.Handshake() // fails once the pipe closes; only the ClientHello matters
		client.Close()
	}()
	var got []byte
	buf := make([]byte, 4096)
	_ = server.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		n, err := server.Read(buf)
		got = append(got, buf[:n]...)
		if _, res := serverName(got); res != sniMore || err != nil {
			return got
		}
	}
}

func TestServerNameFromARealClientHello(t *testing.T) {
	for _, name := range []string{"www.example.com", "Login.Example.COM", "a-b_c.example.co.uk."} {
		hello := clientHello(t, name)
		got, res := serverName(hello)
		want, _ := cleanHost(name)
		if res != sniFound || got != want {
			t.Fatalf("serverName(%s) = %q, %v; want %q, found", name, got, res, want)
		}
		// Arriving a byte at a time, every prefix asks for more until the record is whole.
		for i := 1; i < len(hello); i++ {
			if _, res := serverName(hello[:i]); res != sniMore {
				t.Fatalf("%s: a %d-byte prefix of %d gave %v, want more", name, i, len(hello), res)
			}
		}
	}
}

func TestServerNameNone(t *testing.T) {
	// No server name: an IP address, or none asked for (Go sends none for an IP).
	if got, res := serverName(clientHello(t, "")); res != sniNone || got != "" {
		t.Fatalf("a ClientHello without a name gave %q, %v", got, res)
	}
	cases := map[string][]byte{
		"plain HTTP":           []byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"),
		"SSH":                  []byte("SSH-2.0-OpenSSH_9.9\r\n"),
		"not version 3":        {22, 2, 0, 0, 5, 1, 0, 0, 1, 0},
		"empty record":         {22, 3, 1, 0, 0},
		"record too long":      {22, 3, 1, 0x40, 0x01},
		"not a ClientHello":    {22, 3, 3, 0, 4, 2, 0, 0, 0},
		"handshake cut short":  {22, 3, 3, 0, 2, 1, 0},
		"no room for random":   {22, 3, 3, 0, 6, 1, 0, 0, 2, 3, 3},
		"application data":     {23, 3, 3, 0, 1, 0},
		"change cipher spec":   {20, 3, 3, 0, 1, 1},
		"alert":                {21, 3, 3, 0, 2, 2, 40},
		"zero bytes of record": {22, 3, 3},
	}
	for name, b := range cases {
		got, res := serverName(b)
		if name == "zero bytes of record" {
			if res != sniMore {
				t.Errorf("%s: %v, want more", name, res)
			}
			continue
		}
		if res != sniNone || got != "" {
			t.Errorf("%s: %q, %v; want none", name, got, res)
		}
	}
	if _, res := serverName(nil); res != sniMore {
		t.Errorf("no bytes yet: %v, want more", res)
	}
}

// hello builds a ClientHello record around extensions, to reach the branches a real client doesn't.
func hello(extensions []byte) []byte {
	body := []byte{3, 3}
	body = append(body, make([]byte, 32)...) // random
	body = append(body, 0)                   // session_id
	body = append(body, 0, 2, 0x13, 0x01)    // one cipher suite
	body = append(body, 1, 0)                // null compression
	body = append(body, byte(len(extensions)>>8), byte(len(extensions)))
	body = append(body, extensions...)
	hs := append([]byte{1, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
	return append([]byte{22, 3, 1, byte(len(hs) >> 8), byte(len(hs))}, hs...)
}

func ext(typ int, data []byte) []byte {
	return append([]byte{byte(typ >> 8), byte(typ), byte(len(data) >> 8), byte(len(data))}, data...)
}

func sniExt(entries ...[]byte) []byte {
	var list []byte
	for _, e := range entries {
		list = append(list, e...)
	}
	return ext(0, append([]byte{byte(len(list) >> 8), byte(len(list))}, list...))
}

func entry(kind byte, name string) []byte {
	return append([]byte{kind, byte(len(name) >> 8), byte(len(name))}, name...)
}

func TestServerNameEdges(t *testing.T) {
	cases := []struct {
		name string
		b    []byte
		want string
		res  sniResult
	}{
		{"after another extension", hello(append(ext(10, []byte{0, 2, 0, 29}), sniExt(entry(0, "example.org"))...)), "example.org", sniFound},
		{"a non-host entry first", hello(sniExt(entry(7, "x"), entry(0, "example.org"))), "example.org", sniFound},
		{"no extensions", hello(nil), "", sniNone},
		{"only other extensions", hello(ext(10, []byte{0, 2, 0, 29})), "", sniNone},
		{"an empty server name list", hello(sniExt()), "", sniNone},
		{"only non-host entries", hello(sniExt(entry(7, "x"))), "", sniNone},
		{"a bad host name", hello(sniExt(entry(0, "exa mple.org"))), "", sniNone},
		{"a host name with an empty label", hello(sniExt(entry(0, "a..org"))), "", sniNone},
		{"a host name starting with a dot", hello(sniExt(entry(0, ".org"))), "", sniNone},
		{"a host name ending in two dots", hello(sniExt(entry(0, "example.org.."))), "", sniNone},
		{"an empty host name", hello(sniExt(entry(0, ""))), "", sniNone},
		{"a cut extension", hello([]byte{0, 0, 0, 9, 0}), "", sniNone},
		{"a cut server name list", hello(ext(0, []byte{0, 9, 0})), "", sniNone},
		{"a cut entry", hello(ext(0, []byte{0, 3, 0, 0, 9})), "", sniNone},
		{"a server name list without its length", hello(ext(0, []byte{0})), "", sniNone},
	}
	for _, c := range cases {
		got, res := serverName(c.b)
		if got != c.want || res != c.res {
			t.Errorf("%s: %q, %v; want %q, %v", c.name, got, res, c.want, c.res)
		}
	}
	long := make([]byte, 254)
	for i := range long {
		long[i] = 'a'
	}
	if _, ok := cleanHost(string(long)); ok {
		t.Error("a 254-byte host name was accepted")
	}
}

// FuzzServerName: nothing a client sends can make the parser panic, and a name it returns is clean.
func FuzzServerName(f *testing.F) {
	f.Add(clientHello(f, "www.example.com"))
	f.Add(hello(sniExt(entry(0, "example.org"))))
	f.Add([]byte("GET / HTTP/1.1\r\n"))
	f.Fuzz(func(t *testing.T, b []byte) {
		name, res := serverName(b)
		if res == sniFound {
			if clean, ok := cleanHost(name); !ok || clean != name {
				t.Fatalf("returned an unclean name %q", name)
			}
		} else if name != "" {
			t.Fatalf("returned %q with %v", name, res)
		}
	})
}

// slowConn hands out its bytes a few at a time, then times out like a read deadline would.
type slowConn struct {
	data     []byte
	step     int
	deadline time.Time
	cleared  bool
}

func (c *slowConn) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, os.ErrDeadlineExceeded
	}
	n := min(c.step, len(p), len(c.data))
	copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

func (c *slowConn) SetReadDeadline(t time.Time) error {
	c.deadline = t
	c.cleared = t.IsZero()
	return nil
}

func TestSniffServerNameReadsUntilTheRecordIsWhole(t *testing.T) {
	h := clientHello(t, "api.example.net")
	after := []byte("rest of the stream")
	c := &slowConn{data: append(bytes.Clone(h), after...), step: 100}
	name, read := SniffServerName(c, time.Second)
	if name != "api.example.net" {
		t.Fatalf("name = %q", name)
	}
	if !bytes.HasPrefix(read, h) || !c.cleared {
		t.Fatalf("read %d bytes (want the %d-byte ClientHello first), deadline cleared %v", len(read), len(h), c.cleared)
	}
	// What it read and what follows make up the stream, unchanged.
	if got := append(bytes.Clone(read), c.data...); !bytes.Equal(got, append(bytes.Clone(h), after...)) {
		t.Fatal("bytes were lost or reordered")
	}
}

func TestSniffServerNameGivesUp(t *testing.T) {
	// A client that sends half a ClientHello and stops: no name, and the half is handed back.
	h := clientHello(t, "example.com")
	c := &slowConn{data: bytes.Clone(h[:40]), step: 7}
	if name, read := SniffServerName(c, time.Millisecond); name != "" || !bytes.Equal(read, h[:40]) {
		t.Fatalf("got %q and %d bytes", name, len(read))
	}
	// Not TLS: it stops at the first bytes.
	c = &slowConn{data: []byte("SSH-2.0-x\r\n"), step: 4}
	if name, read := SniffServerName(c, time.Second); name != "" || string(read) != "SSH-" {
		t.Fatalf("got %q and %q", name, read)
	}
	// A client that sends nothing at all.
	c = &slowConn{}
	if name, read := SniffServerName(c, time.Millisecond); name != "" || len(read) != 0 {
		t.Fatalf("got %q and %d bytes", name, len(read))
	}
}
