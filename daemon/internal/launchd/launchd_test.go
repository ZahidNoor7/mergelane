package launchd

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// Expected launchctl argv, spelled out rather than built from the package constants.
var (
	argvPrint   = []string{"/bin/launchctl", "print", "system/io.github.zahidnoor7.mergelane.daemon"}
	argvBootout = []string{"/bin/launchctl", "bootout", "system/io.github.zahidnoor7.mergelane.daemon"}
	argvEnable  = []string{"/bin/launchctl", "enable", "system/io.github.zahidnoor7.mergelane.daemon"}
)

func argvBootstrap(plist string) []string {
	return []string{"/bin/launchctl", "bootstrap", "system", plist}
}

// printOutput is shaped like `launchctl print system/com.apple.syslogd` on macOS 27.0.1: the service's
// properties are indented by one tab, nested blocks by two.
func printOutput(pid int) []byte {
	var b strings.Builder
	b.WriteString("system/io.github.zahidnoor7.mergelane.daemon = {\n")
	b.WriteString("\tactive count = 1\n\tpath = /Library/LaunchDaemons/io.github.zahidnoor7.mergelane.daemon.plist\n")
	b.WriteString("\ttype = LaunchDaemon\n\tstate = running\n\n")
	b.WriteString("\targuments = {\n\t\t/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon\n\t\trun\n\t}\n\n")
	b.WriteString("\tdomain = system\n\truns = 1\n")
	if pid > 0 {
		fmt.Fprintf(&b, "\tpid = %d\n", pid)
	}
	b.WriteString("\tresource coalition = {\n\t\tID = 1186\n\t\tstate = active\n\t}\n}\n")
	return []byte(b.String())
}

type reply struct {
	res Result
	err error
}

var (
	replyLoaded = reply{res: Result{Stdout: printOutput(0)}}
	// What `launchctl print` printed and returned for a service that is not loaded, on macOS 27.0.1.
	replyNotFound = reply{res: Result{ExitCode: 113, Stdout: []byte("Bad request.\n"),
		Stderr: []byte("Could not find service \"io.github.zahidnoor7.mergelane.daemon\" in domain for system\n")}}
	replyOK       = reply{}
	errStart      = errors.New("fork/exec /bin/launchctl: simulated start failure")
	replyNoLaunch = reply{res: Result{ExitCode: -1}, err: errStart}
)

func replyExit(code int, stderr string) reply {
	return reply{res: Result{ExitCode: code, Stderr: []byte(stderr)}}
}

// fakeLaunchd records every command and plays a small launchd: bootstrap loads, bootout unloads, print reports.
// Replies queued with script are used first, in order, for their subcommand. The exit statuses it uses for
// bootout-when-not-loaded (3) and bootstrap-when-loaded (5) are stand-ins: launchctl(1) does not document them.
type fakeLaunchd struct {
	t      *testing.T
	calls  [][]string
	loaded bool
	pid    int
	queue  map[string][]reply
}

func (f *fakeLaunchd) script(sub string, rs ...reply) { f.queue[sub] = append(f.queue[sub], rs...) }

func (f *fakeLaunchd) Run(_ context.Context, name string, args ...string) (Result, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	if name != "/bin/launchctl" {
		f.t.Errorf("ran %q %q, want only /bin/launchctl", name, args)
	}
	if len(args) == 0 {
		f.t.Fatal("launchctl run without a subcommand")
	}
	if q := f.queue[args[0]]; len(q) > 0 {
		f.queue[args[0]] = q[1:]
		return q[0].res, q[0].err
	}
	switch args[0] {
	case "print":
		if f.loaded {
			return Result{Stdout: printOutput(f.pid)}, nil
		}
		return replyNotFound.res, nil
	case "bootout":
		if !f.loaded {
			return replyExit(3, "Boot-out failed: 3: No such process\n").res, nil
		}
		f.loaded, f.pid = false, 0
		return Result{}, nil
	case "bootstrap":
		if f.loaded {
			return replyExit(5, "Bootstrap failed: 5: Input/output error\n").res, nil
		}
		f.loaded, f.pid = true, 4242
		return Result{}, nil
	case "enable":
		return Result{}, nil
	}
	f.t.Errorf("unexpected launchctl %q", args)
	return Result{ExitCode: 64}, nil
}

type chownCall struct {
	path     string
	uid, gid int
}

type env struct {
	t      *testing.T
	root   string
	src    string
	paths  Paths
	fake   *fakeLaunchd
	chowns []chownCall
	// chownErr, when set, decides whether a chown fails.
	chownErr func(path string) error
	sleeps   int
	opts     Options
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, root: t.TempDir(), fake: &fakeLaunchd{t: t, queue: map[string][]reply{}}}
	e.src = filepath.Join(t.TempDir(), "mergelane-daemon")
	e.writeSource("binary v1")
	var err error
	if e.paths, err = PathsFor(e.root); err != nil {
		t.Fatal(err)
	}
	e.opts = Options{
		Root:    e.root,
		Source:  e.src,
		UID:     501,
		Runner:  e.fake,
		Geteuid: func() int { return 0 },
		Chown: func(path string, uid, gid int) error {
			e.chowns = append(e.chowns, chownCall{path, uid, gid})
			if e.chownErr != nil {
				return e.chownErr(path)
			}
			return nil
		},
		Sleep: func(time.Duration) { e.sleeps++ },
	}
	return e
}

func (e *env) writeSource(content string) {
	e.t.Helper()
	if err := os.WriteFile(e.src, []byte(content), 0o700); err != nil {
		e.t.Fatal(err)
	}
}

// install runs Install and then forgets the calls it made.
func (e *env) install() {
	e.t.Helper()
	if err := Install(context.Background(), e.opts); err != nil {
		e.t.Fatalf("Install: %v", err)
	}
	e.fake.calls, e.chowns = nil, nil
}

func (e *env) wantCalls(want ...[]string) {
	e.t.Helper()
	if !reflect.DeepEqual(e.fake.calls, want) {
		e.t.Errorf("launchctl calls:\n got %q\nwant %q", e.fake.calls, want)
	}
}

// tree lists every path under root, relative to it, with its type and permission bits.
func (e *env) tree() []string {
	e.t.Helper()
	var out []string
	err := filepath.WalkDir(e.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == e.root {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(e.root, path)
		out = append(out, fmt.Sprintf("%s %v", rel, fi.Mode()))
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

var installedTree = []string{
	"Library drwxr-xr-x",
	"Library/LaunchDaemons drwxr-xr-x",
	"Library/LaunchDaemons/io.github.zahidnoor7.mergelane.daemon.plist -rw-r--r--",
	"Library/Logs drwxr-xr-x",
	"Library/Logs/Mergelane drwxr-xr-x",
	"Library/PrivilegedHelperTools drwxr-xr-x",
	"Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon -rwxr-xr-x",
}

func (e *env) wantTree(want []string) {
	e.t.Helper()
	if got := e.tree(); !reflect.DeepEqual(got, want) {
		e.t.Errorf("files under root:\n got %q\nwant %q", got, want)
	}
}

func (e *env) wantFile(path, content string) {
	e.t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatal(err)
	}
	if string(got) != content {
		e.t.Errorf("%s = %q, want %q", path, got, content)
	}
}

func (e *env) wantPlist(uid int) {
	e.t.Helper()
	want, err := PlistXML(e.paths, uid)
	if err != nil {
		e.t.Fatal(err)
	}
	e.wantFile(e.paths.Plist, string(want))
}

func wantStep(t *testing.T, err error, step Step) *StepError {
	t.Helper()
	var se *StepError
	if !errors.As(err, &se) {
		t.Fatalf("err = %v, want a *StepError at %q", err, step)
	}
	if se.Step != step {
		t.Fatalf("failed at step %q, want %q (err: %v)", se.Step, step, err)
	}
	return se
}

func wantExit(t *testing.T, err error, code int) {
	t.Helper()
	var ce *CommandError
	if !errors.As(err, &ce) || ce.Result.ExitCode != code {
		t.Errorf("err = %v, want a *CommandError with exit status %d", err, code)
	}
}

func TestInstallFresh(t *testing.T) {
	e := newEnv(t)
	if err := Install(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.wantCalls(argvPrint, argvEnable, argvBootstrap(e.paths.Plist))
	e.wantTree(installedTree)
	e.wantFile(e.paths.Binary, "binary v1")
	e.wantPlist(501)

	// Every directory and file this package created was handed to root:wheel. Files are chowned as their
	// temporary name, in the directory they are renamed within.
	wantDirs := []string{"Library", "Library/PrivilegedHelperTools", "Library/LaunchDaemons", "Library/Logs", "Library/Logs/Mergelane"}
	if len(e.chowns) != len(wantDirs)+2 {
		t.Fatalf("chown calls = %v, want %d dirs then 2 files", e.chowns, len(wantDirs))
	}
	for i, c := range e.chowns {
		if c.uid != 0 || c.gid != 0 {
			t.Errorf("chown %s to %d:%d, want 0:0", c.path, c.uid, c.gid)
		}
		if i < len(wantDirs) && c.path != filepath.Join(e.root, wantDirs[i]) {
			t.Errorf("chown #%d = %s, want %s", i, c.path, wantDirs[i])
		}
	}
	for i, final := range []string{e.paths.Binary, e.paths.Plist} {
		c := e.chowns[len(wantDirs)+i]
		if filepath.Dir(c.path) != filepath.Dir(final) || !strings.HasPrefix(filepath.Base(c.path), "."+filepath.Base(final)+".tmp-") {
			t.Errorf("chown %s, want a temporary file next to %s", c.path, final)
		}
	}
	if !e.fake.loaded {
		t.Error("daemon not bootstrapped")
	}
}

func TestInstallTwiceIsIdempotent(t *testing.T) {
	e := newEnv(t)
	e.install()

	e.writeSource("binary v2")
	e.opts.UID = 502
	if err := Install(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	// Loaded: boot out, confirm it is gone, then load the new files.
	e.wantCalls(argvPrint, argvBootout, argvPrint, argvEnable, argvBootstrap(e.paths.Plist))
	e.wantTree(installedTree)
	e.wantFile(e.paths.Binary, "binary v2")
	e.wantPlist(502)
	// Existing directories are not touched again; only the two new files are chowned.
	if len(e.chowns) != 2 {
		t.Errorf("chown calls = %v, want only the two files", e.chowns)
	}
	if e.sleeps != 0 {
		t.Errorf("slept %d times, want 0", e.sleeps)
	}
}

func TestInstallSourceMayBeTheInstalledBinary(t *testing.T) {
	e := newEnv(t)
	e.install()
	e.opts.Source = e.paths.Binary
	if err := Install(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.wantFile(e.paths.Binary, "binary v1")
	e.wantTree(installedTree)
}

func TestInstallRefusesNonRoot(t *testing.T) {
	e := newEnv(t)
	e.opts.Geteuid = func() int { return 501 }
	err := Install(context.Background(), e.opts)
	wantStep(t, err, StepCheckRoot)
	if !errors.Is(err, ErrNotRoot) {
		t.Errorf("err = %v, want ErrNotRoot", err)
	}
	e.wantCalls()
	e.wantTree(nil)
}

func TestInstallRejectsInvalidUID(t *testing.T) {
	for _, uid := range []int{0, -1, 1 << 32} {
		e := newEnv(t)
		e.opts.UID = uid
		err := Install(context.Background(), e.opts)
		wantStep(t, err, StepValidateUID)
		if !errors.Is(err, ErrInvalidUID) {
			t.Errorf("uid %d: err = %v, want ErrInvalidUID", uid, err)
		}
		e.wantCalls()
		e.wantTree(nil)
	}
}

func TestInstallRejectsBadSource(t *testing.T) {
	for name, src := range map[string]string{
		"missing":   filepath.Join(t.TempDir(), "nope"),
		"directory": t.TempDir(),
		"empty":     "",
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			e.opts.Source = src
			wantStep(t, Install(context.Background(), e.opts), StepValidateSource)
			e.wantCalls()
			e.wantTree(nil)
		})
	}
}

func TestRelativeRootIsRejected(t *testing.T) {
	e := newEnv(t)
	e.opts.Root = "relative/root"
	ctx := context.Background()
	wantStep(t, Install(ctx, e.opts), StepOptions)
	_, err := Uninstall(ctx, e.opts)
	wantStep(t, err, StepOptions)
	_, err = Status(ctx, e.opts)
	wantStep(t, err, StepOptions)
	e.wantCalls()
}

func TestInstallToleratesBootoutOfServiceThatIsNotLoaded(t *testing.T) {
	e := newEnv(t)
	// print says loaded, but the service is gone by the time bootout runs.
	e.fake.script("print", replyLoaded, replyNotFound)
	e.fake.script("bootout", replyExit(3, "Boot-out failed: 3: No such process\n"))
	if err := Install(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.wantCalls(argvPrint, argvBootout, argvPrint, argvEnable, argvBootstrap(e.paths.Plist))
	e.wantTree(installedTree)
}

func TestInstallBootoutFailureWhileStillLoaded(t *testing.T) {
	e := newEnv(t)
	e.fake.script("print", replyLoaded, replyLoaded)
	e.fake.script("bootout", replyExit(1, "Boot-out failed: 1: Operation not permitted\n"))
	err := Install(context.Background(), e.opts)
	wantStep(t, err, StepBootout)
	wantExit(t, err, 1)
	if !strings.Contains(err.Error(), "Operation not permitted") {
		t.Errorf("err = %v, want launchctl's message", err)
	}
	e.wantCalls(argvPrint, argvBootout, argvPrint)
	e.wantTree(nil)
}

func TestInstallBootoutFailureAndProbeFailure(t *testing.T) {
	e := newEnv(t)
	e.fake.script("print", replyLoaded, replyNoLaunch)
	e.fake.script("bootout", replyExit(1, "Boot-out failed\n"))
	err := Install(context.Background(), e.opts)
	wantStep(t, err, StepBootout)
	wantExit(t, err, 1)
	if !errors.Is(err, errStart) {
		t.Errorf("err = %v, want it to include the print failure", err)
	}
}

func TestInstallWaitsUntilUnloaded(t *testing.T) {
	e := newEnv(t)
	e.fake.loaded = true
	e.fake.script("print", replyLoaded, replyLoaded, replyLoaded, replyNotFound)
	if err := Install(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.wantCalls(argvPrint, argvBootout, argvPrint, argvPrint, argvPrint, argvEnable, argvBootstrap(e.paths.Plist))
	if e.sleeps != 2 {
		t.Errorf("slept %d times, want 2", e.sleeps)
	}
}

func TestInstallGivesUpWhenServiceStaysLoaded(t *testing.T) {
	e := newEnv(t)
	e.fake.loaded = true
	e.fake.script("bootout", replyOK) // succeeds but the fake keeps the service loaded
	err := Install(context.Background(), e.opts)
	wantStep(t, err, StepWaitUnloaded)
	if got, want := len(e.fake.calls), 2+unloadPolls; got != want {
		t.Errorf("%d launchctl calls, want %d", got, want)
	}
	if e.sleeps != unloadPolls-1 {
		t.Errorf("slept %d times, want %d", e.sleeps, unloadPolls-1)
	}
	e.wantTree(nil)
}

func TestInstallLaunchctlFailures(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(*fakeLaunchd)
		step   Step
		exit   int  // CommandError exit status, or 0 when the runner itself fails
		files  bool // whether the new files are in place afterwards
		nCalls int
	}{
		{"print cannot start", func(f *fakeLaunchd) { f.script("print", replyNoLaunch) }, StepProbe, 0, false, 1},
		{"wait print cannot start", func(f *fakeLaunchd) {
			f.loaded = true
			f.script("print", replyLoaded, replyNoLaunch)
		}, StepWaitUnloaded, 0, false, 3},
		{"bootout cannot start", func(f *fakeLaunchd) {
			f.loaded = true
			f.script("bootout", replyNoLaunch)
		}, StepBootout, 0, false, 3},
		{"enable fails", func(f *fakeLaunchd) { f.script("enable", replyExit(1, "nope")) }, StepEnable, 1, true, 2},
		{"enable cannot start", func(f *fakeLaunchd) { f.script("enable", replyNoLaunch) }, StepEnable, 0, true, 2},
		{"bootstrap fails", func(f *fakeLaunchd) {
			f.script("bootstrap", replyExit(5, "Bootstrap failed: 5: Input/output error\n"))
		}, StepBootstrap, 5, true, 3},
		{"bootstrap cannot start", func(f *fakeLaunchd) { f.script("bootstrap", replyNoLaunch) }, StepBootstrap, 0, true, 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			c.setup(e.fake)
			err := Install(context.Background(), e.opts)
			wantStep(t, err, c.step)
			if c.exit != 0 {
				wantExit(t, err, c.exit)
			} else if !errors.Is(err, errStart) {
				t.Errorf("err = %v, want the runner's error", err)
			}
			if len(e.fake.calls) != c.nCalls {
				t.Errorf("launchctl calls = %q, want %d", e.fake.calls, c.nCalls)
			}
			if c.files {
				e.wantTree(installedTree)
			} else {
				e.wantTree(nil)
			}
		})
	}
}

func TestInstallDirectoryFailures(t *testing.T) {
	t.Run("a file where a directory belongs", func(t *testing.T) {
		e := newEnv(t)
		if err := os.WriteFile(filepath.Join(e.root, "Library"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		wantStep(t, Install(context.Background(), e.opts), StepCreateDirs)
		e.wantCalls(argvPrint)
	})
	t.Run("chown fails", func(t *testing.T) {
		e := newEnv(t)
		errChown := errors.New("chown: operation not permitted")
		e.chownErr = func(string) error { return errChown }
		err := Install(context.Background(), e.opts)
		wantStep(t, err, StepCreateDirs)
		if !errors.Is(err, errChown) {
			t.Errorf("err = %v, want the chown error", err)
		}
	})
}

// listTemps returns leftover temporary files in dir.
func listTemps(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var temps []string
	for _, de := range entries {
		if strings.Contains(de.Name(), ".tmp-") {
			temps = append(temps, de.Name())
		}
	}
	return temps
}

func TestInstallCopyFailureKeepsOldBinary(t *testing.T) {
	e := newEnv(t)
	e.install()
	oldPlist, _ := os.ReadFile(e.paths.Plist)

	e.writeSource("binary v2")
	errChown := errors.New("chown: operation not permitted")
	e.chownErr = func(path string) error {
		if filepath.Dir(path) == filepath.Dir(e.paths.Binary) {
			return errChown
		}
		return nil
	}
	err := Install(context.Background(), e.opts)
	wantStep(t, err, StepCopyBinary)
	if !errors.Is(err, errChown) {
		t.Errorf("err = %v, want the chown error", err)
	}
	e.wantFile(e.paths.Binary, "binary v1")
	e.wantFile(e.paths.Plist, string(oldPlist))
	if temps := listTemps(t, filepath.Dir(e.paths.Binary)); temps != nil {
		t.Errorf("temporary files left behind: %q", temps)
	}
	e.wantTree(installedTree)
	e.wantCalls(argvPrint, argvBootout, argvPrint)
}

func TestInstallPlistWriteFailures(t *testing.T) {
	t.Run("rename onto a directory", func(t *testing.T) {
		e := newEnv(t)
		// A non-empty directory at the plist path makes rename(2) fail.
		if err := os.MkdirAll(filepath.Join(e.paths.Plist, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		wantStep(t, Install(context.Background(), e.opts), StepWritePlist)
		if temps := listTemps(t, filepath.Dir(e.paths.Plist)); temps != nil {
			t.Errorf("temporary files left behind: %q", temps)
		}
		e.wantFile(e.paths.Binary, "binary v1")
		e.wantCalls(argvPrint)
	})
	t.Run("chown fails", func(t *testing.T) {
		e := newEnv(t)
		e.install()
		e.opts.UID = 777
		e.chownErr = func(path string) error {
			if filepath.Dir(path) == filepath.Dir(e.paths.Plist) {
				return errors.New("chown failed")
			}
			return nil
		}
		wantStep(t, Install(context.Background(), e.opts), StepWritePlist)
		e.wantPlist(501) // the old plist is untouched
		if temps := listTemps(t, filepath.Dir(e.paths.Plist)); temps != nil {
			t.Errorf("temporary files left behind: %q", temps)
		}
	})
}

func TestUninstallRunsCleanupBeforeRemovingFiles(t *testing.T) {
	e := newEnv(t)
	e.install()
	ran := false
	e.opts.Cleanup = func(_ context.Context, argv []string) error {
		ran = true
		want := []string{filepath.Join(e.root, "Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon"), "cleanup"}
		if !reflect.DeepEqual(argv, want) {
			t.Errorf("cleanup argv = %q, want %q", argv, want)
		}
		if e.fake.loaded {
			t.Error("cleanup ran while the daemon was still loaded")
		}
		if ok, _ := regularFile(argv[0]); !ok {
			t.Error("cleanup ran after the binary was removed")
		}
		if ok, _ := regularFile(e.paths.Plist); !ok {
			t.Error("cleanup ran after the plist was removed")
		}
		return nil
	}
	res, err := Uninstall(context.Background(), e.opts)
	if err != nil {
		t.Fatal(err)
	}
	if !ran || !res.CleanupRan || res.Hint != "" {
		t.Errorf("result = %+v, cleanup ran = %v; want cleanup to have run and no hint", res, ran)
	}
	if !reflect.DeepEqual(res.CleanupArgv, e.paths.CleanupArgv()) {
		t.Errorf("CleanupArgv = %q", res.CleanupArgv)
	}
	e.wantCalls(argvPrint, argvBootout, argvPrint)
	e.wantTree([]string{
		"Library drwxr-xr-x",
		"Library/LaunchDaemons drwxr-xr-x",
		"Library/Logs drwxr-xr-x",
		"Library/Logs/Mergelane drwxr-xr-x",
		"Library/PrivilegedHelperTools drwxr-xr-x",
	})
}

func TestUninstallWithoutCleanupReturnsHint(t *testing.T) {
	e := newEnv(t)
	e.install()
	res, err := Uninstall(context.Background(), e.opts)
	if err != nil {
		t.Fatal(err)
	}
	if res.CleanupRan || res.Hint != CleanupHint || !strings.Contains(res.Hint, "mergelane-daemon cleanup") {
		t.Errorf("result = %+v, want CleanupHint", res)
	}
	if ok, _ := regularFile(e.paths.Binary); ok {
		t.Error("binary not removed")
	}
	if ok, _ := regularFile(e.paths.Plist); ok {
		t.Error("plist not removed")
	}
}

func TestUninstallTwiceIsIdempotent(t *testing.T) {
	e := newEnv(t)
	e.install()
	calls := 0
	e.opts.Cleanup = func(context.Context, []string) error { calls++; return nil }
	if _, err := Uninstall(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.fake.calls = nil
	res, err := Uninstall(context.Background(), e.opts)
	if err != nil {
		t.Fatal(err)
	}
	// Not loaded: one print, no bootout. No binary: cleanup cannot run, so the hint comes back.
	e.wantCalls(argvPrint)
	if calls != 1 || res.CleanupRan || res.Hint != CleanupHint {
		t.Errorf("cleanup calls = %d, result = %+v; want 1 call in total and the hint", calls, res)
	}
}

func TestUninstallRefusesNonRoot(t *testing.T) {
	e := newEnv(t)
	e.install()
	e.opts.Geteuid = func() int { return 501 }
	_, err := Uninstall(context.Background(), e.opts)
	wantStep(t, err, StepCheckRoot)
	e.wantCalls()
	e.wantTree(installedTree)
}

func TestUninstallCleanupFailureKeepsFiles(t *testing.T) {
	e := newEnv(t)
	e.install()
	errCleanup := errors.New("cleanup exited 1")
	e.opts.Cleanup = func(context.Context, []string) error { return errCleanup }
	res, err := Uninstall(context.Background(), e.opts)
	wantStep(t, err, StepCleanup)
	if !errors.Is(err, errCleanup) || res.CleanupRan || res.Hint != CleanupHint {
		t.Errorf("err = %v, result = %+v", err, res)
	}
	e.wantTree(installedTree)
}

func TestUninstallBootoutFailureKeepsFiles(t *testing.T) {
	e := newEnv(t)
	e.install()
	e.fake.script("bootout", replyExit(1, "Boot-out failed: 1: Operation not permitted\n"))
	e.opts.Cleanup = func(context.Context, []string) error {
		t.Error("cleanup must not run when bootout failed")
		return nil
	}
	_, err := Uninstall(context.Background(), e.opts)
	wantStep(t, err, StepBootout)
	wantExit(t, err, 1)
	e.wantCalls(argvPrint, argvBootout, argvPrint)
	e.wantTree(installedTree)
}

func TestUninstallToleratesBootoutOfServiceThatIsNotLoaded(t *testing.T) {
	e := newEnv(t)
	e.install()
	e.fake.script("print", replyLoaded, replyNotFound)
	e.fake.script("bootout", replyExit(113, "Could not find specified service\n"))
	if _, err := Uninstall(context.Background(), e.opts); err != nil {
		t.Fatal(err)
	}
	e.wantCalls(argvPrint, argvBootout, argvPrint)
}

func TestUninstallRemoveFailures(t *testing.T) {
	t.Run("plist", func(t *testing.T) {
		e := newEnv(t)
		if err := os.MkdirAll(filepath.Join(e.paths.Plist, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := Uninstall(context.Background(), e.opts)
		wantStep(t, err, StepRemovePlist)
	})
	t.Run("binary", func(t *testing.T) {
		e := newEnv(t)
		if err := os.MkdirAll(filepath.Join(e.paths.Binary, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		e.opts.Cleanup = func(context.Context, []string) error {
			t.Error("cleanup must not run when the binary is not a regular file")
			return nil
		}
		_, err := Uninstall(context.Background(), e.opts)
		wantStep(t, err, StepRemoveBinary)
	})
}

func TestStatus(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)

	s, err := Status(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	if s != (ServiceStatus{}) {
		t.Errorf("before install: %+v, want all false", s)
	}
	e.wantCalls(argvPrint)

	e.install()
	s, err = Status(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	if want := (ServiceStatus{PlistPresent: true, BinaryPresent: true, Installed: true, Loaded: true, PID: 4242}); s != want {
		t.Errorf("after install: %+v, want %+v", s, want)
	}

	// Loaded but not running: no pid line.
	e.fake.script("print", replyLoaded)
	if s, _ = Status(ctx, e.opts); !s.Loaded || s.PID != 0 {
		t.Errorf("loaded, not running: %+v", s)
	}

	// Only the plist: not installed. Status needs no root.
	if err := os.Remove(e.paths.Binary); err != nil {
		t.Fatal(err)
	}
	e.opts.Geteuid = func() int { return 501 }
	e.fake.loaded = false
	s, err = Status(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	if want := (ServiceStatus{PlistPresent: true}); s != want {
		t.Errorf("plist only: %+v, want %+v", s, want)
	}

	e.fake.script("print", replyNoLaunch)
	_, err = Status(ctx, e.opts)
	wantStep(t, err, StepProbe)
	if !errors.Is(err, errStart) {
		t.Errorf("err = %v, want the runner's error", err)
	}
}

func TestStatusFileCheckErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	for _, dir := range []string{"LaunchDaemons", "PrivilegedHelperTools"} {
		t.Run(dir, func(t *testing.T) {
			e := newEnv(t)
			e.install()
			locked := filepath.Join(e.root, "Library", dir)
			if err := os.Chmod(locked, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
			_, err := Status(context.Background(), e.opts)
			wantStep(t, err, StepCheckFiles)
			if !errors.Is(err, fs.ErrPermission) {
				t.Errorf("err = %v, want a permission error", err)
			}
		})
	}
}

func TestParsePID(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want int
	}{
		{"running", string(printOutput(379)), 379},
		{"not running", string(printOutput(0)), 0},
		{"nested pid only", "svc = {\n\tstate = running\n\tblock = {\n\t\tpid = 7\n\t}\n}\n", 0},
		{"nested before top level", "svc = {\n\tblock = {\n\t\tpid = 7\n\t}\n\tpid = 5780\n}\n", 5780},
		{"trailing space and CRLF", "svc = {\r\n\tpid = 12 \r\n}\r\n", 12},
		{"zero", "\tpid = 0\n", 0},
		{"overflow", "\tpid = 99999999999999999999999\n", 0},
		{"not a number", "\tpid = abc\n", 0},
		{"empty", "", 0},
	}
	for _, c := range cases {
		if got := parsePID([]byte(c.out)); got != c.want {
			t.Errorf("%s: parsePID = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestErrorMessages(t *testing.T) {
	ce := &CommandError{Argv: []string{"/bin/launchctl", "bootstrap", "system", "/x.plist"},
		Result: Result{ExitCode: 5, Stderr: []byte("Bootstrap failed: 5: Input/output error\n")}}
	if got, want := ce.Error(), "/bin/launchctl bootstrap system /x.plist exited with status 5: Bootstrap failed: 5: Input/output error"; got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
	ce.Result = Result{ExitCode: 113, Stdout: []byte("Bad request.\n")}
	if got := ce.Error(); !strings.HasSuffix(got, "status 113: Bad request.") {
		t.Errorf("stdout fallback: %q", got)
	}
	ce.Result = Result{ExitCode: 1}
	if got := ce.Error(); !strings.HasSuffix(got, "status 1") {
		t.Errorf("no output: %q", got)
	}

	se := &StepError{Step: StepBootstrap, Err: ce}
	if got := se.Error(); !strings.HasPrefix(got, "launchd: launchctl bootstrap: /bin/launchctl bootstrap") {
		t.Errorf("StepError: %q", got)
	}
	if !errors.Is(se, ce) {
		t.Error("StepError does not unwrap")
	}
}

func TestPathsFor(t *testing.T) {
	p, err := PathsFor("")
	if err != nil {
		t.Fatal(err)
	}
	want := Paths{
		Root:   "/",
		Binary: "/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon",
		Plist:  "/Library/LaunchDaemons/io.github.zahidnoor7.mergelane.daemon.plist",
		LogDir: "/Library/Logs/Mergelane",
		Log:    "/Library/Logs/Mergelane/daemon.log",
	}
	if p != want {
		t.Errorf("PathsFor(\"\") = %+v\nwant %+v", p, want)
	}
	if got, _ := PathsFor("/tmp/x/"); got.Binary != "/tmp/x/Library/PrivilegedHelperTools/"+Label {
		t.Errorf("trailing slash: %+v", got)
	}
	if got := p.CleanupArgv(); !reflect.DeepEqual(got, []string{want.Binary, "cleanup"}) {
		t.Errorf("CleanupArgv = %q", got)
	}
}
