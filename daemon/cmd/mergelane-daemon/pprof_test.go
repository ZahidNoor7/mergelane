package main

import (
	"net"
	"net/http"
	"testing"
)

func TestStartPprofServesOnLoopbackOnly(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	if err := startPprof(addr); err != nil {
		t.Fatal(err)
	}
	res, err := http.Get("http://" + addr + "/debug/pprof/")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("pprof = %v, %v", res, err)
	}
	res.Body.Close()
	if err := startPprof(addr); err == nil {
		t.Fatal("a port in use must fail")
	}
	for _, bad := range []string{"0.0.0.0:6060", "192.0.2.1:6060", "localhost:6060", "nonsense"} {
		if startPprof(bad) == nil {
			t.Errorf("startPprof(%q) must refuse", bad)
		}
	}
}
