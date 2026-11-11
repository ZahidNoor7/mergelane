package launchd

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
)

// Result is what a command that ran to completion produced.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// Runner runs a program directly, never through a shell.
//
// Run returns a nil error when the program ran and exited, whatever its exit status, which is in
// Result.ExitCode. A non-nil error means the program could not be started or did not exit on its own (it was
// killed by a signal, or ctx was cancelled).
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (Result, error)
}

// ExecRunner runs commands with os/exec. name should be an absolute path.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) (Result, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	res := Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if err == nil {
		return res, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.Exited() && ctx.Err() == nil {
		res.ExitCode = ee.ExitCode()
		return res, nil
	}
	res.ExitCode = -1
	return res, err
}
