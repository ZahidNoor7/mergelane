package api

import (
	"net"
	"testing"
)

func TestPipeSDDL(t *testing.T) {
	for _, sid := range []string{"S-1-5-21-1004336348-1177238915-682003330-1001", "S-1-12-1-1234567890-1234567890-1234567890-1234567890"} {
		got, err := PipeSDDL(sid)
		want := "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + sid + ")"
		if err != nil || got != want {
			t.Errorf("PipeSDDL(%q) = %q, %v; want %q", sid, got, err, want)
		}
	}
	for _, bad := range []string{"", "S-1-1-0", "S-1-5-32-545", "S-1-5-18", "S-1-5-21-1-2-3", "S-1-5-21-1-2-3-4-5",
		"S-1-5-21-1-2-3-4)(A;;GA;;;WD", "s-1-5-21-1-2-3-4", " S-1-5-21-1-2-3-4", "S-1-5-21-12345678901-2-3-4"} {
		if got, err := PipeSDDL(bad); err == nil {
			t.Errorf("PipeSDDL(%q) = %q, want an error", bad, got)
		}
	}
}

// A connection that isn't a Unix socket has no peer uid to give.
func TestUnixPeerUIDNeedsAUnixSocket(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, err := unixPeerUID(a); err == nil {
		t.Error("unixPeerUID took a pipe")
	}
}
