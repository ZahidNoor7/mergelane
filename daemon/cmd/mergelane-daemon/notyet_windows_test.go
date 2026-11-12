package main

import (
	"bytes"
	"testing"
)

func TestWindowsRefusesTheHelperCommands(t *testing.T) {
	for _, cmd := range []string{"run", "install", "uninstall"} {
		var out, errb bytes.Buffer
		code := dispatch(cmd, nil, &out, &errb)
		if code != 1 || out.Len() != 0 || errb.String() != "error: System merge is not available on Windows yet\n" {
			t.Errorf("%s: exit %d, %q / %q", cmd, code, out.String(), errb.String())
		}
	}
	if _, ok := notYet["cleanup"]; ok {
		t.Error("cleanup is refused; it must always run")
	}
}
