package api

import (
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

// xucredVersion is XUCRED_VERSION from the macOS SDK's <sys/ucred.h>; x/sys/unix does not define it.
const xucredVersion = 0

// peerUID returns the effective uid of the process at the other end of c, as the kernel recorded it
// when the connection was made: getsockopt(SOL_LOCAL, LOCAL_PEERCRED) fills a struct xucred
// (<sys/un.h>, <sys/ucred.h>). The peer cannot forge it.
func peerUID(c *net.UnixConn) (uint32, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *unix.Xucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, fmt.Errorf("LOCAL_PEERCRED: %w", credErr)
	}
	return xucredUID(cred)
}

// xucredUID checks the structure's layout version before trusting its uid.
func xucredUID(cred *unix.Xucred) (uint32, error) {
	if cred.Version != xucredVersion {
		return 0, fmt.Errorf("LOCAL_PEERCRED: xucred version %d, want %d", cred.Version, xucredVersion)
	}
	return cred.Uid, nil
}
