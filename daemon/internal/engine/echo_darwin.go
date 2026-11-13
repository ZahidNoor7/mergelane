package engine

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

func init() { openEcho = openEchoDarwin }

// openEchoDarwin opens a datagram ICMP socket, the unprivileged kind macOS gives ping, pinned to one
// adapter like every other flow the daemon sends:
//   - IP_BOUND_IF, so the TUN's capture routes can't take the echo back into the TUN (nics.ForceEgress);
//   - bound to the adapter's address, and connected to dst, so the kernel only hands this socket that
//     host's ICMP;
//   - IP_STRIPHDR, so reads start at the ICMP header, as x/net/icmp sets it on Darwin.
//
// The fd is handed to net.FileConn, as x/net/icmp hands its own to net.FilePacketConn, so reads and
// writes go through Go's poller and honour deadlines.
func openEchoDarwin(idx int, src, dst net.IP) (net.Conn, error) {
	src4, dst4 := src.To4(), dst.To4()
	if src4 == nil || dst4 == nil {
		return nil, fmt.Errorf("ping over adapter %d: need IPv4 addresses, got %v and %v", idx, src, dst)
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_ICMP)
	if err != nil {
		return nil, os.NewSyscallError("socket", err)
	}
	unix.CloseOnExec(fd)
	fail := func(call string, err error) (net.Conn, error) {
		unix.Close(fd)
		return nil, os.NewSyscallError(call, err)
	}
	if err := unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_STRIPHDR, 1); err != nil {
		return fail("setsockopt IP_STRIPHDR", err)
	}
	if idx > 0 {
		if err := unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_BOUND_IF, idx); err != nil {
			return fail("setsockopt IP_BOUND_IF", err)
		}
	}
	local := &unix.SockaddrInet4{}
	copy(local.Addr[:], src4)
	if err := unix.Bind(fd, local); err != nil {
		return fail("bind", err)
	}
	remote := &unix.SockaddrInet4{}
	copy(remote.Addr[:], dst4)
	if err := unix.Connect(fd, remote); err != nil {
		return fail("connect", err)
	}
	f := os.NewFile(uintptr(fd), "mergelane-ping")
	defer f.Close() // FileConn holds its own duplicate of the fd
	return net.FileConn(f)
}
