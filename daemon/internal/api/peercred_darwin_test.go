package api

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestXucredVersionChecked(t *testing.T) {
	if uid, err := xucredUID(&unix.Xucred{Version: xucredVersion, Uid: 501}); err != nil || uid != 501 {
		t.Fatalf("got %d, %v", uid, err)
	}
	if _, err := xucredUID(&unix.Xucred{Version: 1, Uid: 0}); err == nil {
		t.Fatal("an unknown xucred layout was trusted")
	}
}
