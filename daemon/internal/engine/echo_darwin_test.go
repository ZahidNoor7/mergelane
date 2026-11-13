package engine

import (
	"errors"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

// When the daemon is out of file descriptors, a ping fails with the reason and leaks nothing. The
// test lowers its own process's open-file limit to the descriptors already in use, for a moment.
func TestOpenEchoDarwinReportsNoSocket(t *testing.T) {
	lo := loopbackNic(t)
	var old syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &old); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(os.DevNull) // the lowest free descriptor: every one below it is in use
	if err != nil {
		t.Fatal(err)
	}
	next := uint64(f.Fd())
	f.Close()
	low := old
	low.Cur = next
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &low); err != nil {
		t.Skipf("cannot lower the open-file limit: %v", err)
	}
	c, err := openEcho(lo.Index, lo.IP, net.ParseIP("127.0.0.1"))
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &old); err != nil {
		t.Fatalf("restoring the open-file limit: %v", err)
	}
	if err == nil {
		c.Close()
		t.Fatal("a ping socket opened with no descriptor free")
	}
	if !errors.Is(err, syscall.EMFILE) {
		t.Errorf("open = %v, want EMFILE", err)
	}
	f, err = os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if uint64(f.Fd()) != next {
		t.Errorf("descriptor %d free after the failure, want %d: something leaked", f.Fd(), next)
	}
}

// The real socket: unprivileged, pinned and connected over lo0 (no root, no route change). Whether
// lo0 answers depends on the firewall (stealth mode drops every ping, loopback included), so this
// checks what the daemon controls: the socket opens pinned, sends, honours deadlines, and pinning
// to an adapter that isn't there fails rather than sending some other way.
func TestOpenEchoDarwinPinsARealSocket(t *testing.T) {
	if !EchoSupported() {
		t.Fatal("macOS has no ping opener")
	}
	lo := loopbackNic(t)
	c, err := openEcho(lo.Index, lo.IP, net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatalf("open over lo0 = %v", err)
	}
	defer c.Close()
	msg := echoMsg(icmpEchoRequest, 0x4d4c, 1, "mergelane")
	if n, err := c.Write(msg); err != nil || n != len(msg) {
		t.Fatalf("send = %d, %v", n, err)
	}
	c.SetDeadline(time.Now().Add(300 * time.Millisecond))
	buf := make([]byte, 1500)
	for {
		n, err := c.Read(buf)
		if err != nil {
			break // stealth mode: nothing comes back, and the deadline ends the read
		}
		// Whatever arrives starts at the ICMP header (IP_STRIPHDR), not at an IPv4 header (0x45).
		if n >= icmpHeaderLen && buf[0] == icmpEchoReply && string(buf[4:8]) == string(msg[4:8]) {
			if string(buf[icmpHeaderLen:n]) != "mergelane" {
				t.Errorf("reply data %q, want the request's", buf[icmpHeaderLen:n])
			}
			break
		}
		if buf[0] == 0x45 {
			t.Fatalf("read an IP header: IP_STRIPHDR is not set")
		}
	}

	if c, err := openEcho(1<<20, lo.IP, net.ParseIP("127.0.0.1")); err == nil {
		c.Close()
		t.Error("a ping pinned to a missing interface index opened")
	}
	if c, err := openEcho(lo.Index, net.ParseIP("192.0.2.1"), net.ParseIP("127.0.0.1")); err == nil {
		c.Close()
		t.Error("a ping bound to an address the Mac doesn't have opened")
	}
	if _, err := openEcho(lo.Index, net.ParseIP("::1"), net.ParseIP("127.0.0.1")); err == nil {
		t.Error("an IPv6 source was accepted")
	}
	if c, err := openEcho(0, lo.IP, net.ParseIP("127.0.0.1")); err != nil {
		t.Errorf("unpinned open (index 0) = %v", err)
	} else {
		c.Close()
	}
}
