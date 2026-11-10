// Package launchd installs, uninstalls and inspects mergelane-daemon as a system LaunchDaemon.
//
// The app runs this once, as root, through an admin-password prompt (CLAUDE.md, Architecture). The binary goes
// to /Library/PrivilegedHelperTools/<Label>, the job definition to /Library/LaunchDaemons/<Label>.plist and the
// daemon's stdout and stderr to /Library/Logs/Mergelane/daemon.log. Every path hangs off Options.Root ("/" in
// production) so tests can use a temporary directory, and every launchctl call goes through a Runner so tests
// can record them instead of touching launchd.
//
// launchctl subcommands, as documented in launchctl(1) on macOS 27.0.1:
//
//   - print system/<Label>: "Prints information about the specified service". Anyone may query the system
//     domain, so Status works without root. The service is loaded when it exits 0. For a service that is not
//     loaded it exited 113 ("Could not find service ... in domain for system"; `launchctl error 113` is
//     "Could not find specified service") on macOS 27.0.1. The man page says its output "is NOT API", so the
//     pid it reports is best effort.
//   - bootout system/<Label>: removes the service from the system domain. The man page does not document the
//     exit status for a service that is not loaded, so this package never matches exit codes for that case:
//     it asks `print` first, and if bootout fails it asks `print` again and treats "no longer loaded" as success.
//   - enable system/<Label>: "Once a service is disabled, it cannot be loaded in the specified domain until it
//     is once again enabled. This state persists across boots." Install therefore enables before it
//     bootstraps; enabling afterwards could not rescue a bootstrap that a stale disable had already refused.
//   - bootstrap system <plist path>: loads the job; RunAtLoad starts it at once.
//
// The plist keys are described where they are written, in plist.go.
package launchd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// Label is the launchd job label. launchd.plist(5) expects the plist to be named <Label>.plist.
	Label = "io.github.zahidnoor7.mergelane.daemon"
	// AppBundleID is Mergelane.app's bundle identifier (app/electron-builder.yml `appId`).
	AppBundleID = "io.github.zahidnoor7.mergelane"
	// LaunchctlPath is launchctl's absolute path, so a root process never resolves it through $PATH.
	LaunchctlPath = "/bin/launchctl"
	// Domain is the launchd domain the daemon lives in.
	Domain = "system"
	// ServiceTarget is the launchctl(1) service-target for the daemon: system/<Label>.
	ServiceTarget = Domain + "/" + Label

	// ThrottleInterval is the restart throttle in seconds. ADR-0017: with 1 s, launchd restarted the daemon
	// one second after `kill -9` on the CI runner.
	ThrottleInterval = 1

	rootUID    = 0 // root
	wheelGID   = 0 // wheel: `dscl . -read /Groups/wheel PrimaryGroupID` prints 0
	dirMode    = 0o755
	binaryMode = 0o755
	plistMode  = 0o644 // launchctl(1): launchd plists "must disallow group and world writes"

	// After a successful bootout, Install and Uninstall wait for `print` to stop finding the service.
	// launchctl(1) does not say whether bootout returns before the job is gone.
	unloadPolls        = 100
	unloadPollInterval = 100 * time.Millisecond
)

// Errors returned (wrapped in a *StepError) when a precondition fails.
var (
	ErrNotRoot    = errors.New("must run as root")
	ErrInvalidUID = errors.New("uid must be a non-root user id (1 to 4294967294)")
)

// CleanupHint tells the caller that route cleanup is still its job.
const CleanupHint = "route cleanup was not run: run `mergelane-daemon cleanup` as root " +
	"(for example the copy inside Mergelane.app) to remove any routes a crashed daemon left behind"

// Step names the stage of Install, Uninstall or Status that failed.
type Step string

// Steps, in the order Install and Uninstall run them.
const (
	StepOptions        Step = "check options"
	StepCheckRoot      Step = "check root"
	StepValidateUID    Step = "validate uid"
	StepValidateSource Step = "validate source binary"
	StepProbe          Step = "launchctl print"
	StepBootout        Step = "launchctl bootout"
	StepWaitUnloaded   Step = "wait for unload"
	StepCreateDirs     Step = "create directories"
	StepCopyBinary     Step = "copy binary"
	StepWritePlist     Step = "write plist"
	StepEnable         Step = "launchctl enable"
	StepBootstrap      Step = "launchctl bootstrap"
	StepCleanup        Step = "route cleanup"
	StepRemovePlist    Step = "remove plist"
	StepRemoveBinary   Step = "remove binary"
	StepCheckFiles     Step = "check files"
)

// StepError reports which step failed. Use errors.As to read Step and errors.Is to match the cause.
type StepError struct {
	Step Step
	Err  error
}

func (e *StepError) Error() string { return "launchd: " + string(e.Step) + ": " + e.Err.Error() }
func (e *StepError) Unwrap() error { return e.Err }

// CommandError is a command that ran and exited with a non-zero status.
type CommandError struct {
	Argv   []string
	Result Result
}

func (e *CommandError) Error() string {
	s := fmt.Sprintf("%s exited with status %d", strings.Join(e.Argv, " "), e.Result.ExitCode)
	msg := strings.TrimSpace(string(e.Result.Stderr))
	if msg == "" {
		msg = strings.TrimSpace(string(e.Result.Stdout))
	}
	if msg != "" {
		s += ": " + msg
	}
	return s
}

// Paths are the files the daemon is installed as, under Root.
type Paths struct {
	Root   string // "/" in production
	Binary string // <Root>/Library/PrivilegedHelperTools/<Label>
	Plist  string // <Root>/Library/LaunchDaemons/<Label>.plist
	LogDir string // <Root>/Library/Logs/Mergelane
	Log    string // <Root>/Library/Logs/Mergelane/daemon.log, the daemon's stdout and stderr
}

// PathsFor returns the install paths under root. An empty root means "/". root must be absolute because
// launchd.plist(5) requires absolute program paths.
func PathsFor(root string) (Paths, error) {
	if root == "" {
		root = "/"
	}
	if !filepath.IsAbs(root) {
		return Paths{}, fmt.Errorf("root %q is not an absolute path", root)
	}
	root = filepath.Clean(root)
	logDir := filepath.Join(root, "Library", "Logs", "Mergelane")
	return Paths{
		Root:   root,
		Binary: filepath.Join(root, "Library", "PrivilegedHelperTools", Label),
		Plist:  filepath.Join(root, "Library", "LaunchDaemons", Label+".plist"),
		LogDir: logDir,
		Log:    filepath.Join(logDir, "daemon.log"),
	}, nil
}

// CleanupArgv is the command that removes the daemon's routes with the installed binary. It only works while
// that binary exists, which is why Uninstall runs Options.Cleanup before it removes any file.
func (p Paths) CleanupArgv() []string { return []string{p.Binary, "cleanup"} }

// Options configure Install, Uninstall and Status. The zero value is production: root "/", real launchctl,
// the real euid and real chown.
type Options struct {
	// Root is the filesystem root the install paths hang off. Empty means "/".
	Root string
	// Source is the mergelane-daemon binary to install (Install only), usually the copy inside the app bundle.
	Source string
	// UID is the console user allowed to control the daemon (Install only; ADR-0005). The app passes its own uid.
	UID int
	// Runner runs launchctl. Nil means ExecRunner.
	Runner Runner
	// Geteuid reports the effective uid. Nil means os.Geteuid.
	Geteuid func() int
	// Chown sets the owner of a file or directory this package creates (always root:wheel). Nil means os.Lchown.
	// Tests that are not root replace it.
	Chown func(path string, uid, gid int) error
	// Sleep waits between unload polls. Nil means time.Sleep.
	Sleep func(time.Duration)
	// Cleanup (Uninstall only) runs route cleanup with argv = Paths.CleanupArgv(). Uninstall calls it after
	// the daemon is booted out and before the binary is removed. Nil means "not run"; Uninstall then returns
	// CleanupHint.
	Cleanup func(ctx context.Context, argv []string) error
}

func (o Options) withDefaults() Options {
	if o.Runner == nil {
		o.Runner = ExecRunner{}
	}
	if o.Geteuid == nil {
		o.Geteuid = os.Geteuid
	}
	if o.Chown == nil {
		o.Chown = os.Lchown
	}
	if o.Sleep == nil {
		o.Sleep = time.Sleep
	}
	return o
}

type job struct {
	opts  Options
	paths Paths
}

func newJob(opts Options) (*job, error) {
	paths, err := PathsFor(opts.Root)
	if err != nil {
		return nil, &StepError{StepOptions, err}
	}
	return &job{opts: opts.withDefaults(), paths: paths}, nil
}

func (j *job) requireRoot() error {
	if j.opts.Geteuid() != 0 {
		return &StepError{StepCheckRoot, ErrNotRoot}
	}
	return nil
}

func validUID(uid int) error {
	if uid <= 0 || int64(uid) >= math.MaxUint32 {
		return fmt.Errorf("%w, got %d", ErrInvalidUID, uid)
	}
	return nil
}

// openSource opens the binary to install and checks, on the open descriptor, that it is a regular file.
// Install keeps it open so the file it validated is the file it copies.
func openSource(path string) (*os.File, error) {
	if path == "" {
		return nil, errors.New("no source binary given")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	return f, nil
}

func (j *job) launchctl(ctx context.Context, args ...string) error {
	res, err := j.opts.Runner.Run(ctx, LaunchctlPath, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return &CommandError{Argv: append([]string{LaunchctlPath}, args...), Result: res}
	}
	return nil
}

// loaded reports whether launchd has the service loaded: `launchctl print system/<Label>` exits 0.
func (j *job) loaded(ctx context.Context) (Result, bool, error) {
	res, err := j.opts.Runner.Run(ctx, LaunchctlPath, "print", ServiceTarget)
	if err != nil {
		return res, false, err
	}
	return res, res.ExitCode == 0, nil
}

// stop boots the service out of the system domain if it is loaded and waits until launchd no longer has it.
// A service that is not loaded, or that disappears while bootout fails, is not an error.
func (j *job) stop(ctx context.Context) error {
	_, up, err := j.loaded(ctx)
	if err != nil {
		return &StepError{StepProbe, err}
	}
	if !up {
		return nil
	}
	if err := j.launchctl(ctx, "bootout", ServiceTarget); err != nil {
		// launchctl(1) does not document bootout's status for "not loaded", so ask launchd instead.
		_, still, perr := j.loaded(ctx)
		if perr != nil {
			return &StepError{StepBootout, errors.Join(err, perr)}
		}
		if still {
			return &StepError{StepBootout, err}
		}
		return nil
	}
	for i := 1; ; i++ {
		_, still, err := j.loaded(ctx)
		if err != nil {
			return &StepError{StepWaitUnloaded, err}
		}
		if !still {
			return nil
		}
		if i == unloadPolls {
			return &StepError{StepWaitUnloaded, fmt.Errorf("%s still loaded after bootout (%d checks)", ServiceTarget, i)}
		}
		j.opts.Sleep(unloadPollInterval)
	}
}

// Install copies opts.Source to the helper-tools path, writes the plist and loads the daemon. It must run as
// root. Running it again replaces both files and reloads the daemon. In order:
//
//  1. check root, opts.UID and that opts.Source is a regular file; nothing is touched before these pass;
//  2. if the service is loaded, boot it out and wait until it is gone;
//  3. create missing parent directories (0755 root:wheel; existing ones are left alone);
//  4. copy the binary (0755 root:wheel) and write the plist (0644 root:wheel), each to a temporary file in the
//     same directory that is renamed into place, so neither path ever holds a partial file;
//  5. launchctl enable system/<Label>, then launchctl bootstrap system <plist>.
func Install(ctx context.Context, opts Options) error {
	j, err := newJob(opts)
	if err != nil {
		return err
	}
	if err := j.requireRoot(); err != nil {
		return err
	}
	plist, err := PlistXML(j.paths, opts.UID)
	if err != nil {
		return &StepError{StepValidateUID, err}
	}
	src, err := openSource(opts.Source)
	if err != nil {
		return &StepError{StepValidateSource, err}
	}
	defer src.Close()

	if err := j.stop(ctx); err != nil {
		return err
	}
	for _, dir := range []string{filepath.Dir(j.paths.Binary), filepath.Dir(j.paths.Plist), j.paths.LogDir} {
		if err := j.ensureDir(dir); err != nil {
			return &StepError{StepCreateDirs, err}
		}
	}
	if err := j.writeAtomic(j.paths.Binary, binaryMode, func(w io.Writer) error {
		_, err := io.Copy(w, src)
		return err
	}); err != nil {
		return &StepError{StepCopyBinary, err}
	}
	if err := j.writeAtomic(j.paths.Plist, plistMode, func(w io.Writer) error {
		_, err := w.Write(plist)
		return err
	}); err != nil {
		return &StepError{StepWritePlist, err}
	}
	if err := j.launchctl(ctx, "enable", ServiceTarget); err != nil {
		return &StepError{StepEnable, err}
	}
	if err := j.launchctl(ctx, "bootstrap", Domain, j.paths.Plist); err != nil {
		return &StepError{StepBootstrap, err}
	}
	return nil
}

// UninstallResult says whether route cleanup ran.
type UninstallResult struct {
	// CleanupArgv is the route-cleanup command for the installed binary (Paths.CleanupArgv).
	CleanupArgv []string
	// CleanupRan is true when Options.Cleanup ran and succeeded.
	CleanupRan bool
	// Hint is CleanupHint when route cleanup did not run, otherwise empty.
	Hint string
}

// Uninstall stops the daemon and removes its plist and binary. It must run as root. In order:
//
//  1. boot the service out (not loaded is fine) and wait until launchd no longer has it, so KeepAlive cannot
//     restart it and it cannot add routes again;
//  2. if opts.Cleanup is set and the installed binary exists, call it with Paths.CleanupArgv(). This is the
//     last moment that binary exists. If it fails, Uninstall stops and leaves both files, so it can be retried;
//  3. remove the plist, then the binary. Files that are already gone are fine.
//
// The log directory is kept. When cleanup did not run, the result carries CleanupHint and the caller must run
// `mergelane-daemon cleanup` itself.
func Uninstall(ctx context.Context, opts Options) (UninstallResult, error) {
	j, err := newJob(opts)
	if err != nil {
		return UninstallResult{}, err
	}
	res := UninstallResult{CleanupArgv: j.paths.CleanupArgv(), Hint: CleanupHint}
	if err := j.requireRoot(); err != nil {
		return res, err
	}
	if err := j.stop(ctx); err != nil {
		return res, err
	}
	if fi, err := os.Stat(j.paths.Binary); opts.Cleanup != nil && err == nil && fi.Mode().IsRegular() {
		if err := opts.Cleanup(ctx, res.CleanupArgv); err != nil {
			return res, &StepError{StepCleanup, err}
		}
		res.CleanupRan, res.Hint = true, ""
	}
	if err := removeIfPresent(j.paths.Plist); err != nil {
		return res, &StepError{StepRemovePlist, err}
	}
	if err := removeIfPresent(j.paths.Binary); err != nil {
		return res, &StepError{StepRemoveBinary, err}
	}
	return res, nil
}

// ServiceStatus is what Status found.
type ServiceStatus struct {
	PlistPresent  bool
	BinaryPresent bool
	Installed     bool // both files present
	Loaded        bool // launchd has the job (`launchctl print` exits 0)
	PID           int  // the running process, or 0; best effort, see the package comment
}

// Status reports whether the daemon is installed, loaded and running. It does not need root.
func Status(ctx context.Context, opts Options) (ServiceStatus, error) {
	var s ServiceStatus
	j, err := newJob(opts)
	if err != nil {
		return s, err
	}
	if s.PlistPresent, err = regularFile(j.paths.Plist); err != nil {
		return s, &StepError{StepCheckFiles, err}
	}
	if s.BinaryPresent, err = regularFile(j.paths.Binary); err != nil {
		return s, &StepError{StepCheckFiles, err}
	}
	s.Installed = s.PlistPresent && s.BinaryPresent
	res, loaded, err := j.loaded(ctx)
	if err != nil {
		return s, &StepError{StepProbe, err}
	}
	s.Loaded = loaded
	if loaded {
		s.PID = parsePID(res.Stdout)
	}
	return s, nil
}

// pidLine matches the service's own pid property. In `launchctl print system/<label>` output the service's
// properties are indented by one tab ("\tpid = 379" for com.apple.syslogd on macOS 27.0.1, "\tpid = 5780" in
// spike S1); nested blocks use two or more tabs and are not matched.
var pidLine = regexp.MustCompile(`(?m)^\tpid = ([0-9]+)[ \t]*\r?$`)

func parsePID(out []byte) int {
	m := pidLine.FindSubmatch(out)
	if m == nil {
		return 0
	}
	pid, err := strconv.Atoi(string(m[1]))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
