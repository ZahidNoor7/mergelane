package launchd

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestExecRunnerExitStatus(t *testing.T) {
	ctx := context.Background()
	res, err := ExecRunner{}.Run(ctx, "/bin/echo", "hello", "world")
	if err != nil || res.ExitCode != 0 || string(res.Stdout) != "hello world\n" {
		t.Errorf("echo: res = %+v, err = %v", res, err)
	}
	res, err = ExecRunner{}.Run(ctx, "/usr/bin/false")
	if err != nil || res.ExitCode != 1 {
		t.Errorf("false: exit = %d, err = %v; want exit 1 and no error", res.ExitCode, err)
	}
}

func TestExecRunnerDoesNotUseAShell(t *testing.T) {
	// With a shell, "$HOME" would be expanded; exec passes it through untouched.
	res, err := ExecRunner{}.Run(context.Background(), "/bin/echo", "$HOME;", "`id`")
	if err != nil || string(res.Stdout) != "$HOME; `id`\n" {
		t.Errorf("res = %q, err = %v", res.Stdout, err)
	}
}

func TestExecRunnerStartAndSignalErrors(t *testing.T) {
	res, err := ExecRunner{}.Run(context.Background(), "/nonexistent/mergelane-launchctl")
	if err == nil || res.ExitCode != -1 {
		t.Errorf("missing program: exit = %d, err = %v; want -1 and an error", res.ExitCode, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	res, err = ExecRunner{}.Run(ctx, "/bin/sleep", "5")
	if err == nil || res.ExitCode != -1 {
		t.Errorf("killed by ctx: exit = %d, err = %v; want -1 and an error", res.ExitCode, err)
	}
}

func TestOptionsDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	if _, ok := o.Runner.(ExecRunner); !ok {
		t.Errorf("Runner = %T, want ExecRunner", o.Runner)
	}
	if o.Geteuid == nil || o.Geteuid() != os.Geteuid() {
		t.Error("Geteuid default is not os.Geteuid")
	}
	if o.Chown == nil || o.Sleep == nil {
		t.Error("Chown or Sleep has no default")
	}
	o.Sleep(0)
	if o.Cleanup != nil {
		t.Error("Cleanup must default to nil (not run)")
	}
}
