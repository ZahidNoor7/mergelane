package engine

import (
	"strings"
	"time"
)

// Reading the server name a TLS client asks for (the "server_name" extension, RFC 6066 section 3)
// from its ClientHello, the first thing a client sends on an HTTPS connection (RFC 8446 section
// 4.1.2; the same layout in RFC 5246 section 7.4.1.2). Sticky-per-site uses it to tell which site a
// flow belongs to (ADR-0048). Only the first TLS record is read: a ClientHello fits in one record
// (at most 16 KiB, RFC 8446 section 5.1) even when its key shares make it span several packets.

// sniResult says what the bytes read so far gave.
type sniResult int

const (
	sniNone  sniResult = iota // not a TLS ClientHello, or one without a server name: stop reading
	sniMore                   // a ClientHello's record isn't complete yet: read more
	sniFound                  // the server name was found
)

const (
	tlsRecordHeader    = 5
	tlsMaxRecord       = 16 << 10
	tlsHandshake       = 22
	tlsClientHello     = 1
	tlsExtServerName   = 0
	tlsServerNameHost  = 0
	maxServerNameBytes = 253
)

// serverName reads the server name from the start of a TLS connection, b being what the client
// sent so far. The name is lower-cased and without a trailing dot.
func serverName(b []byte) (string, sniResult) {
	if len(b) == 0 {
		return "", sniMore
	}
	if b[0] != tlsHandshake {
		return "", sniNone
	}
	if len(b) < tlsRecordHeader {
		return "", sniMore
	}
	if b[1] != 3 { // every TLS version's record says 3.x
		return "", sniNone
	}
	n := int(b[3])<<8 | int(b[4])
	if n == 0 || n > tlsMaxRecord {
		return "", sniNone
	}
	if len(b) < tlsRecordHeader+n {
		return "", sniMore
	}
	r := reader(b[tlsRecordHeader : tlsRecordHeader+n])
	if t, ok := r.u8(); !ok || t != tlsClientHello {
		return "", sniNone
	}
	if _, ok := r.u24(); !ok {
		return "", sniNone
	}
	// client_version (2), random (32), then session_id, cipher_suites and compression_methods.
	if !r.skip(2+32) || !r.skipVec8() || !r.skipVec16() || !r.skipVec8() {
		return "", sniNone
	}
	exts, ok := r.vec16()
	if !ok {
		return "", sniNone
	}
	for len(exts) > 0 {
		typ, ok1 := exts.u16()
		data, ok2 := exts.vec16()
		if !ok1 || !ok2 {
			return "", sniNone
		}
		if typ != tlsExtServerName {
			continue
		}
		list, ok := data.vec16()
		if !ok {
			return "", sniNone
		}
		for len(list) > 0 {
			kind, ok1 := list.u8()
			name, ok2 := list.vec16()
			if !ok1 || !ok2 {
				return "", sniNone
			}
			if kind == tlsServerNameHost {
				if host, ok := cleanHost(string(name)); ok {
					return host, sniFound
				}
				return "", sniNone
			}
		}
		return "", sniNone
	}
	return "", sniNone
}

// cleanHost accepts a DNS host name (letters, digits, hyphens, underscores and dots), lower-cased
// and without a trailing dot.
func cleanHost(name string) (string, bool) {
	name = strings.TrimSuffix(strings.ToLower(name), ".") // one trailing dot: a fully qualified name
	if name == "" || len(name) > maxServerNameBytes || strings.HasPrefix(name, ".") ||
		strings.HasSuffix(name, ".") || strings.Contains(name, "..") {
		return "", false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return "", false
		}
	}
	return name, true
}

// reader takes big-endian fields off the front of a byte slice.
type reader []byte

func (r *reader) u8() (byte, bool) {
	if len(*r) < 1 {
		return 0, false
	}
	v := (*r)[0]
	*r = (*r)[1:]
	return v, true
}

func (r *reader) u16() (int, bool) {
	if len(*r) < 2 {
		return 0, false
	}
	v := int((*r)[0])<<8 | int((*r)[1])
	*r = (*r)[2:]
	return v, true
}

func (r *reader) u24() (int, bool) {
	if len(*r) < 3 {
		return 0, false
	}
	v := int((*r)[0])<<16 | int((*r)[1])<<8 | int((*r)[2])
	*r = (*r)[3:]
	return v, true
}

func (r *reader) skip(n int) bool {
	if len(*r) < n {
		return false
	}
	*r = (*r)[n:]
	return true
}

func (r *reader) vec16() (reader, bool) {
	n, ok := r.u16()
	if !ok || len(*r) < n {
		return nil, false
	}
	v := (*r)[:n]
	*r = (*r)[n:]
	return v, true
}

func (r *reader) skipVec8() bool {
	n, ok := r.u8()
	return ok && r.skip(int(n))
}

func (r *reader) skipVec16() bool {
	_, ok := r.vec16()
	return ok
}

// SniffServerName reads what a client sends first on c, for up to wait, until it holds a whole TLS
// record or is clearly not a ClientHello, and returns the server name it asked for ("" if none) with
// every byte read, which the caller must hand on before anything else c gives. It changes c's read
// deadline and clears it before returning.
func SniffServerName(c interface {
	Read([]byte) (int, error)
	SetReadDeadline(time.Time) error
}, wait time.Duration) (string, []byte) {
	_ = c.SetReadDeadline(time.Now().Add(wait))
	defer c.SetReadDeadline(time.Time{})
	buf := make([]byte, 0, 2048)
	chunk := make([]byte, 2048)
	for len(buf) < tlsRecordHeader+tlsMaxRecord {
		n, err := c.Read(chunk)
		buf = append(buf, chunk[:n]...)
		name, res := serverName(buf)
		if res != sniMore {
			return name, buf
		}
		if err != nil {
			break
		}
	}
	return "", buf
}
