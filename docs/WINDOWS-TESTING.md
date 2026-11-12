# Testing Mergelane on Windows

Claude builds everything on the owner's Mac and can't run Windows code. So Windows is tested in two places
(ADR-0054, `docs/WINDOWS-PLAN.md`, "How Windows is tested"):

- **On the Mac:** unit tests with recorded Windows data, Go cross-builds for `windows/amd64` and `windows/arm64`,
  and the Windows test kit's own tests.
- **On the owner's Windows laptop:** the Windows test kit. The owner runs it and pastes its report back into the
  chat.

## The Windows test kit

### What it does on the laptop

- Reads which Windows, which chip (x64 or arm64) and which Smart App Control setting the PC has. Read only.
- Notes the names, sizes and dates of the files in the Downloads folder before and after, to prove the tests never
  write there. It opens nothing.
- Runs Mergelane's Go test programs that the PC's chip can run, after checking that each one is the file that was
  built (SHA-256).
- For each chip the PC can run, installs Mergelane from the kit's installer (W4), silently and into the kit's
  `results` folder, and then:
  - checks that the installer added Mergelane to **Open with** for `.torrent` and `.nzb`, pointing at the program it
    installed;
  - opens Mergelane once with a throwaway profile in the `results` folder (Electron's `--user-data-dir`), waits up
    to 90 seconds for its window, then up to 30 seconds for the browser bridge to answer on its pipe, and closes
    it. Anything still running from the app's folder afterwards is stopped;
  - runs both helpers inside the app (`mergelane-daemon.exe version`, `mergelane-nmhost.exe --version`) and checks
    that they say the app's version, as the Mac's packaging test does. The Mac can't read that stamp itself;
  - uninstalls it silently and checks that nothing is left: the program, the Apps list entry, the Start menu and
    desktop shortcuts, and the Open with entries.

  It never installs over a Mergelane already installed for the user: it skips the step and says why. A run with its
  own `--user-data-dir` doesn't register `mergelane://` links or the browser host (`app/src/main/index.ts`), so the
  test copy never takes them over. A kit built with `--unpacked` carries the unpacked app instead, which is only
  opened and checked, not installed.
- Writes `report.txt` in the kit folder and copies it to the clipboard.

What it never does: it needs no administrator rights (it stops if it has them), changes no settings, and writes
nothing outside its own folder. The one exception is Mergelane's own per-user installer: while the test copy is
installed, it adds a Start menu entry, a desktop shortcut, an Apps list entry and the Open with entries, all for the
current user only, and its uninstaller removes them (the kit checks). The test programs use the TEMP folder and clean
up after themselves. `scripts/windows/kit.test.mjs` checks the script for commands that would change the system.

### Build it (on the Mac)

```sh
node scripts/windows/build-helpers.mjs     # mergelane-daemon.exe and mergelane-nmhost.exe, both chips
cd app && npm run fetch:media-tools:win    # yt-dlp, Deno and FFmpeg for Windows, both chips (ADR-0057)
                                           # (build-helpers.mjs above also puts wintun.dll beside the helpers)
npm run build:win && cd ..                 # the two installers, one per chip, in app/dist
node scripts/windows/check-build.mjs --version "$(node -p 'require("./app/package.json").version')"
node scripts/windows/kit.mjs
```

`check-build.mjs` reads the build without running it: each installer is there, every program in each chip's app is
built for that chip, the app says the right version, and its Electron fuses are the ones `electron-builder.yml`
asks for. For a kit with the unpacked app instead, build with `npm run build:win:dir` and pass `--unpacked`.

The Windows app is built with `electron-builder.win.yml`, which extends `electron-builder.yml` with the file
rules only Windows needs (Windows' own native-module builds instead of the Mac's). Plain `electron-builder --win`
without it would pack the Mac's native modules, so always use `npm run build:win` or `build:win:dir`.

The kit builder writes `dist/windows-kit/` and `dist/mergelane-windows-kit.zip` (both ignored by git). Options:
`--arch x64` or `--arch arm64` to build one chip only, `--out <dir>` for another folder, `--no-zip`, `--unpacked`
(the unpacked app instead of the installer), `--no-app` (Go test programs only). The builder replaces only a folder that is empty or an earlier kit.

### Run it (on the laptop)

1. Copy `mergelane-windows-kit.zip` to the laptop, for example with a USB stick or a cloud drive.
2. Right-click the zip, choose **Extract All…**, and extract it (for example to the Desktop).
3. In the extracted `windows-kit` folder, double-click **Run test kit.cmd**. Not "Run as administrator".
   If Windows warns about the file first, choose to run it ("Run", or "More info" and then "Run anyway"): the kit
   isn't signed, so Windows doesn't know it yet.
4. Wait for **Done**. The report is on the clipboard and in `report.txt`.
5. Paste the report into the chat. Press a key to close the window.
6. To remove the kit, delete the folder (and the zip).

### Read the report (on the Mac)

Save the pasted text to a file, or pipe it:

```sh
node scripts/windows/report.mjs report.txt
pbpaste | node scripts/windows/report.mjs
```

It prints, in plain words: the Windows version and chip, Smart App Control, whether Downloads stayed unchanged,
each test program's result, the coverage of the Windows-only Go files (`*_windows.go`), and for each chip's app how
the install, the window, the bridge, the helpers, Open with and the uninstall went. Exit code 0 means
everything that must pass passed; 1 means something failed or Downloads changed; 2 means no readable report.

### The System merge test (W5, administrator, opt-in)

The kit also carries `system-merge-test.ps1`, its starter `Run system merge test (administrator).cmd`, and each
chip's helper and `wintun.dll` in `helper\<chip>\`. Unlike the rest of the kit, it changes the PC, on purpose and
only after the owner types YES (ADR-0059):

1. it checks it runs as administrator, that the helper files match the kit (SHA-256), that no Mergelane helper is
   installed already (it leaves an installed one alone), and that the internet works;
2. it installs the helper as the Windows service, the way the app does after Windows' administrator prompt, and
   checks the service runs and answers on its pipe;
3. it turns System merge on, checks the two capture routes on the `mergelane` adapter and that the internet
   still works, and records `stats` and `links`;
4. it kills the helper's process: Windows must restart the service, and the restarted helper must remove the
   crashed run's routes, with the internet working and merging off (auto-resume is off by default);
5. whatever happened, it removes the helper (`uninstall`, and `cleanup` if routes are left), then checks that no
   service, program, route or adapter is left, that every adapter's settings are as before, and that the internet
   works. It writes `system-merge-report.txt` and copies it to the clipboard.

Turn any VPN off first: System merge refuses to start next to one, and the test then reports that step as failed.

**If the internet stops** and doesn't come back: restart the PC, since the helper's routes never outlive a
restart. Or, in PowerShell as administrator: `& "<kit>\helper\<chip>\mergelane-daemon.exe" cleanup`.
`route print -4` shows any leftover `0.0.0.0` / `128.0.0.0` routes with mask `128.0.0.0`; Device Manager ›
Network adapters lists the `Mergelane` (Wintun) adapter if one is left, and Uninstall device removes it.

### The hardware run (W6, as yourself)

`hardware-test.ps1`, with its starter `Run hardware test.cmd`, is the Windows counterpart of the Mac's real-hardware
suite (`docs/HARDWARE.md`). Run it as yourself, not as administrator, once Mergelane and its helper are installed
from the app, with two or more networks connected (Wi-Fi and a phone over USB, Ethernet if there is one) and any VPN
off. It talks to the helper over its pipe and:

- caps every network at 16 Mbit/s while it measures, and turns System merge on, checking its two routes;
- downloads 8 × 10 MB from Cloudflare's speed test with sticky sites off (two or more networks must carry 10% or
  more of the bytes) and on (only one may carry 15% or more), reading the helper's per-network stats;
- asks you whether Mergelane's own download shows traffic on every network;
- for each network you choose: you unplug it while downloads run (the helper must see it go within 30 s, merging
  stays on, a new download gets through, a running one finishes), then plug it back (up again within 2 minutes);
- if you say yes: sleep and wake (the helper answers, merging on, routes once, internet works); a VPN turned on
  (merging goes off with a reason, turning it on is refused, no route left) and off again (merging turns on); a
  crash, with the one `Stop-Process` command it shows for an administrator PowerShell window (Windows starts the
  helper again within 30 s, the routes match its state, internet works);
- puts System merge, sticky sites and every network's limit back as they were, whatever happened.

It downloads about 160 MB, plus about 50 MB per network unplugged, and writes `hardware-report.txt`.

### Adding Go packages

`GO_PACKAGES` in `scripts/windows/kit.mjs` lists the daemon packages the kit runs. Add a package once it builds
for Windows. Give it `until: 'W<n>'` while its tests aren't expected to pass on Windows yet; remove `until` when
that milestone lands, and from then on a failure fails the run. Since W5 no package waits: the daemon command's and
the API's tests run over the named pipe on Windows.

### Known limits

- **Smart App Control On** blocks unsigned programs, the kit's included, with no way round it (ADR-0053). The
  report says so.
- **No `-race` on Windows:** the race detector needs cgo, which the cross-build leaves off. `go test -race` keeps
  running on the Mac.
- **x64 programs on an arm64 PC** run only on Windows 11 (emulation); on Windows 10 on Arm the kit skips them.
- **The PowerShell scripts are checked statically on the Mac**, not run, until PowerShell 7 is installed here
  (the owner's decision). Their first real run is on the laptop.
