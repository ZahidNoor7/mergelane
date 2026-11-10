// Spike S1 fake VPN: opens a utun interface and adds the 0/1 + 128/1 capture routes the way
// full-tunnel VPN clients do, then waits to be killed. Run as root.
//
// Constants from the macOS SDK: sys/sys_domain.h (SYSPROTO_CONTROL = 2) and
// net/if_utun.h (UTUN_CONTROL_NAME, UTUN_OPT_IFNAME = 2).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	sysprotoControl = 2
	utunOptIfname   = 2
	utunControlName = "com.apple.net.utun_control"
)

func must(err error, what string) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakevpn: %s: %v\n", what, err)
		os.Exit(1)
	}
}

func run(args ...string) {
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	fmt.Printf("+ %v\n%s", args, out)
	must(err, args[0])
}

func main() {
	addr := "10.200.0.1"
	if len(os.Args) > 1 {
		addr = os.Args[1]
	}
	fd, err := unix.Socket(unix.AF_SYSTEM, unix.SOCK_DGRAM, sysprotoControl)
	must(err, "socket")
	info := &unix.CtlInfo{}
	copy(info.Name[:], utunControlName)
	must(unix.IoctlCtlInfo(fd, info), "CTLIOCGINFO")
	// Unit 0 lets the kernel pick the next free utunN.
	must(unix.Connect(fd, &unix.SockaddrCtl{ID: info.Id, Unit: 0}), "connect")
	name, err := unix.GetsockoptString(fd, sysprotoControl, utunOptIfname)
	must(err, "UTUN_OPT_IFNAME")

	run("/sbin/ifconfig", name, "inet", addr, addr, "up")
	run("/sbin/route", "-q", "-n", "add", "-inet", "0.0.0.0/1", "-interface", name)
	run("/sbin/route", "-q", "-n", "add", "-inet", "128.0.0.0/1", "-interface", name)
	fmt.Printf("FAKEVPN_READY %s pid=%d\n", name, os.Getpid())

	// Packets routed to the utun are read and dropped, like a VPN that is up but unreachable.
	go func() {
		buf := make([]byte, 65536)
		for {
			if _, err := unix.Read(fd, buf); err != nil {
				return
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}
