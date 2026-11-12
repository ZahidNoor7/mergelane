# Mergelane for Windows: plan

Owner decisions of 2026-11-12 (ADR-0053):

- Windows 10 and Windows 11, on x64 (Intel/AMD) and arm64 PCs, next to the Apple-silicon Mac app.
- Free tools and services only.
- CI paused for both macOS and Windows.
- Windows starts now, ahead of the Safari extension.
- All of it on the `windows` branch.

## How the work is done

- **Branches:**
  - `windows` is the long-lived branch, made from `main` after 0.3.5 and PR #73.
  - Each milestone below gets its own branch from `windows` (for example `w1-app`) and a pull request into
    `windows`. The owner says "merge" for each one.
  - `windows` takes `main` in regularly (`git merge main`), so Mac fixes reach it.
  - Merging `windows` into `main` is the owner's decision, made once Windows is ready to release.
- **Where:** everything is written and built on the owner's Mac, in the `mergelane-windows` worktree (a separate
  folder on the `windows` branch, so it never disturbs the Mac release work in `mergelane`). The owner installs the
  builds on their Windows laptop and tests them there. Claude never runs on the laptop. Every macOS test must keep
  passing.
- **CI is paused:** never trigger a GitHub workflow. Each pull request lists the commands it ran locally, on which
  computer, and their results.
- **Tests:** the same rules as on macOS (CLAUDE.md, "Testing"):
  - 90% line coverage of the code a change touches (Vitest `COVERED` list, `node --test`, Go cover);
  - Playwright for Electron for the e2e tests;
  - `go test -race`, `go vet` and `staticcheck` for the daemon;
  - nothing weakened or skipped to make a number.
- **Safety on the laptop:** CLAUDE.md, "Safety when running on the owner's Windows laptop". Ask before anything that
  needs administrator rights, services, drivers or adapters, routes, DNS, the firewall, `HKLM`, or Windows Security
  settings. Tests never touch the owner's real Downloads folder.
- **Verify against official docs** (Microsoft Learn, Electron, electron-builder, Go, Wintun) before each change, and
  name the source in the pull request.

## How Windows is tested

Claude can't run Windows code, so each Windows check comes in two parts.

**On the Mac (Claude):**

- Platform logic sits behind small seams, such as "list the adapters", "set a socket option" and "read the
  registry". It is unit-tested with recorded Windows data and fakes, to the usual 90% line coverage.
- Go packages build for `windows/amd64` and `windows/arm64`. `go vet` runs for both, and so does `staticcheck`
  with `GOOS=windows`.
- Go tests are cross-compiled into Windows test programs: `GOOS=windows GOARCH=<arch> go test -c -o <pkg>.test.exe`.

**On the laptop (the owner), with the Windows test kit:**

- A folder with the installer, the Go test programs and a PowerShell script (`scripts/windows/test-kit.ps1`).
  It uses Windows PowerShell, which comes with Windows, so nothing has to be installed.
- The script:
  - checks the Windows version, the chip and the Smart App Control state;
  - runs the Go test programs;
  - installs the build into a test location, launches it and checks that it is ready (the app's existing ready
    signal);
  - walks the owner through a short checklist for what needs eyes and hands (the tray icon, a download over two
    networks, unplugging);
  - uninstalls the build, and checks that nothing is left behind;
  - writes a report the owner pastes back into the session.
- It follows CLAUDE.md's laptop safety rules. A step that needs administrator rights (from W5) says so first and
  waits for the owner.
- Keep the script small. Its logic that can run anywhere (reading the report, the steps' order) is tested on the
  Mac. How to test the PowerShell parts is chosen from Microsoft's docs in W1 and recorded in an ADR.

Playwright for Electron needs Node.js on the machine, so the Windows e2e suite can't run without installing it on
the laptop. That is the owner's decision. Until then, the kit's checklist and the ready check stand in for it, and
each pull request says which e2e tests were not run on Windows.

**Building Windows installers on the Mac:** electron-builder 26.16.1 (the version installed) has a macOS path for
NSIS installers, using helper tools that electron-builder downloads itself (`app-builder-lib`: `NsisTarget`,
`WineVm`, `toolsets.wine`). It is proven only once W4 builds one. If it fails on Apple silicon, the fallback is
the owner's decision (for example, building the installer on the laptop).

## Starting point (measured 2026-11-12, on the Mac)

- **Daemon cross-compile:** `GOOS=windows GOARCH=amd64 go build ./...` (and `arm64`) fails only where the Windows
  files were removed:
  - `internal/platform` has no Windows file;
  - `internal/nics` lacks `adapterInfo` / `adapterInfos`;
  - `internal/state` lacks `replaceFile`;
  - `internal/api`'s tests use `syscall.Umask`.
- **`cmd/mergelane-nmhost`** (the browser bridge's helper) already builds for Windows.
- **koffi 2.16.3** ships prebuilds for `win32_x64`, `win32_arm64` and `win32_ia32`. `electron-builder.yml`
  currently keeps only `darwin_arm64` (`docs/UPSTREAM.md`).
- **macOS-specific app code** (main process):
  - `daemon/daemon.ts`, `daemon/removal.ts`, `loginItem.ts`, `menuBar.ts` and `windowBackground.ts`;
  - `network/deviceBinding.ts` and `network/interfaces.ts`;
  - `media/youtube/proxy.ts`, `updater.ts`, `openLinks.ts`, `diagnostics.ts` and `ipc/handlers.ts`;
  - `index.ts` and `testKnobs.ts`.
- **macOS-specific daemon files:** `api/peercred_darwin.go`; `nics/{counters,egress,info}_darwin.go`;
  `platform/platform_darwin.go`; `rib/read_darwin.go`; `tun/tun_darwin.go`; `vpnguard/read_darwin.go`; and the
  `launchd` and `routemark` packages.
- **Upstream Windows code to re-import** (pinned commits in `docs/UPSTREAM.md`):
  - **Net Merge `2b333a3`:**
    - `internal/tun/tun_windows.go`;
    - `internal/nics/{counters,egress,info}_windows.go`;
    - `internal/platform/platform_windows.go`;
    - `internal/state/replace_windows.go`;
    - `scripts/fetch-wintun.ps1` and `scripts/windows-smoke.ps1`.
    - Not wanted: the tray and autostart files, which Mergelane replaced.
  - **Plexo `2e44a2f`:** the Windows branches removed from the main process, the Windows and NSIS targets in
    `electron-builder.yml`, `build/installer.nsh`, `build/icon.ico`, and the sparse-file module.
  - Record each import in `docs/UPSTREAM.md`.

## Milestones

### W1: the app runs on Windows, and downloads merge networks inside the app

The most useful part: Mergelane's own downloads use every network, with no helper.

**Pull requests** (each a branch from `windows`, merged on the owner's word). Proposed order: a, b, g, then c to f,
so that each later piece can be tried on the laptop through the unpacked build as it lands.

| PR | Branch | What |
|---|---|---|
| a | `w1-test-kit` | The Windows test kit (`scripts/windows/`, ADR-0054, `docs/WINDOWS-TESTING.md`) and the Go test programs for the packages that already build for Windows. |
| b | `w1-daemon-builds` | The daemon and the browser-bridge helper build and vet for `windows/amd64` and `arm64`: Net Merge's Windows files re-imported (`docs/UPSTREAM.md`), macOS-only tests behind build tags, and every package in the kit. The Wintun engine (`tun_windows.go`) waits for W5: until then the Windows daemon refuses `run`, `install` and `uninstall`, and never creates an adapter or a route. |
| g | `w1-unpacked-build` | `electron-builder --win --dir` for both chips on the Mac, koffi's `win32` builds kept; a kit step that starts it with a test profile and checks that it is ready. |
| c | `w1-networks` | The network list on Windows: kinds, and virtual adapters hidden. |
| d | `w1-pinning` | Pinning download sockets with `IP_UNICAST_IF` / `IPV6_UNICAST_IF`. First check, from Node's and Microsoft's docs, whether Node on Windows can take a socket made outside it (the macOS approach); the answer decides the design, in an ADR. |
| e | `w1-paths` | Windows file names, the Downloads folder, and sparse files. |
| f | `w1-windows-habits` | The tray icon, Ctrl shortcuts, the title bar, Open at login, notifications and the Windows 11 materials. |

- **Windows test kit, first version:** `scripts/windows/test-kit.ps1` and a way to build the kit folder on the Mac.
  Before the installer exists (W4), the kit runs the Go test programs and the unpacked app (electron-builder's
  `--win --dir` output, if it builds on the Mac). Document it in `docs/WINDOWS-TESTING.md`.
- **Electron and `npm ci`:**
  - `patch-package` and `install-electron` must work on Windows;
  - keep koffi's `win32_x64` and `win32_arm64` prebuilds.
- **Networks** (`network/interfaces.ts`):
  - list Windows adapters with their kind: Wi-Fi, Ethernet, iPhone USB (Apple Mobile Device Ethernet), Android
    USB (RNDIS / NCM), Bluetooth PAN;
  - hide virtual adapters: Hyper-V vEthernet, WSL, VPN adapters, Wintun, TAP, loopback.
  - Check the API in Microsoft's docs first (`GetAdaptersAddresses` through koffi, or a Node built-in).
- **Pinning** (`network/deviceBinding.ts`):
  - pin each download socket to its network with `IP_UNICAST_IF` (an IPv4 interface index in network byte order)
    and `IPV6_UNICAST_IF` (host byte order), through koffi on `ws2_32.dll`, following the macOS `IP_BOUND_IF`
    code;
  - tests like the macOS ones.
- **Paths and files:**
  - Windows file-name rules (reserved names such as `CON`, characters such as `<>:"/\|?*`, trailing dots and
    spaces, long paths);
  - the Downloads folder (`app.getPath('downloads')`);
  - Plexo's sparse-file module, if pre-allocation needs it.
- **Windows habits:**
  - a notification-area (tray) icon instead of the menu-bar item, with the merged speed in its tooltip;
  - Ctrl instead of Cmd in shortcuts and labels;
  - window controls on the right, and Electron's Windows title-bar overlay instead of the Mac's traffic lights;
  - Open at login through Electron's `setLoginItemSettings`, which supports Windows;
  - notifications.
- **Liquid Glass:** `win.setBackgroundMaterial('mica' | 'acrylic')` needs Windows 11 22H2 or later (Electron's
  BrowserWindow docs). Windows 10 and older Windows 11 builds get the solid look. The appearance settings say which
  is in use.
- **Tests:**
  - Vitest and `node --test` on the Mac, with Windows behaviour behind seams and recorded Windows data;
  - mac-only e2e tests marked by platform, never deleted;
  - the test kit's checklist on the laptop for in-app merging over Wi-Fi plus a phone.

### W2: browser extension bridge

- `mergelane-nmhost.exe` registered per user under:
  - Chrome: `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`;
  - Edge: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\<name>`;
  - Firefox: `HKCU\Software\Mozilla\NativeMessagingHosts\<name>`.
- The default value of each key is the path to the manifest (Chrome's, Microsoft's and MDN's native-messaging docs).
- The host uses binary-mode stdin and stdout. Chrome passes `--parent-window` on Windows.
- **The app side of the bridge:** the macOS bridge is a 0600 Unix socket. On Windows, use a named pipe that only
  the current user can open, or a Unix socket with an equivalent ACL. Check the Windows and Node docs first.
- **Settings › Browser extensions:**
  - find Chrome, Edge, Chromium, Brave and Firefox on Windows;
  - install steps that show the folder in File Explorer.
- The extension's own code doesn't change.
- **Tests:** unit tests on the Mac (registry paths, manifests), the host's Go test program in the kit, and a kit
  step that loads the extension in Chrome or Edge on the laptop and hands over a download.

### W3: video and media tools

- `scripts/media-tools/` fetches the official Windows yt-dlp and Deno builds for x64 and arm64, pinned by SHA-256 in
  `tools.json`.
- **FFmpeg:**
  - our own minimal LGPL build for Windows x64 and arm64, from the same pinned, signed source;
  - cross-compile it on the Mac (a mingw-w64 toolchain that targets both x86_64 and aarch64, for example
    llvm-mingw), chosen from FFmpeg's and the toolchain's docs, and recorded in an ADR;
  - the same configure options and the same "stream copy only" rule as `build-ffmpeg.sh`.
- The licence texts and release sources are the same as on macOS (ADR-0027).
- **Tests:** the media tests on the Mac, and a kit step that downloads a local HLS fixture and a YouTube link on
  the laptop.

### W4: installer, updates, and releases

- **Installer:**
  - electron-builder's NSIS target for x64 and arm64: one installer per architecture, or one for both, chosen from
    electron-builder's docs;
  - installs per user by default, with no administrator rights for the app itself;
  - registers `mergelane://`, `magnet:` (as an option, never taking over an existing client), `.torrent` and
    `.nzb`;
  - an uninstaller that removes the app, its `HKCU` keys and, after asking, the helper.
- **Unsigned for now** (ADR-0053):
  - the README's Windows section explains SmartScreen's **More info › Run anyway**;
  - it says plainly that Smart App Control **On** blocks unsigned apps;
  - it never tells users to turn that off.
  - The electron-builder config is ready for free signing later, switched on by config only.
- **Updates:**
  - Settings › Updates picks the asset for this platform and architecture from the GitHub release;
  - it checks the SHA-256 from `SHA256SUMS` and runs the installer (ADR-0036's "download, verify, open",
    Windows-style).
- **Release script:**
  - `scripts/release/local-release.mjs` gets a Windows mode, run on the Mac;
  - it builds both architectures and attaches the installers, `SHA256SUMS` and the Windows media-tool sources to
    the same draft release as the Mac files.
- **Packaging test:**
  - install the NSIS build into a test folder;
  - launch it and check that it reaches the ready state;
  - uninstall it, and check that nothing is left behind.
- **First Windows beta:** in-app merging, the extension, video, updates. No system-wide merge yet.

### W5: the system-wide helper (largest)

- **Re-import Net Merge's Windows engine:**
  - a Wintun adapter;
  - capture routes;
  - the gVisor stack;
  - per-flow balancing with `IP_UNICAST_IF` egress.
- **Wintun:**
  - bundle the prebuilt, signed `wintun.dll` for x64 and arm64, after reading the licence inside its ZIP;
  - record that licence in `THIRD-PARTY-NOTICES.md`;
  - pin the ZIP by SHA-256.
- **Service:**
  - `mergelane-daemon.exe install` registers a LocalSystem service, from one UAC prompt started by the app;
  - service recovery restarts it after a crash;
  - `uninstall` removes the service, its routes and the adapter.
- **Control API:**
  - the same versioned JSON protocol (`shared/daemon-api.ts`, `shared/fixtures/daemon-api/`) over a named pipe;
  - the pipe's ACL allows only the installing user and SYSTEM, which replaces `LOCAL_PEERCRED`;
  - tested from both sides, as on macOS.
- **Routes:**
  - Windows has no `RTF_PROTO2`, so record Mergelane's routes (and a recognisable metric or protocol) so that
    `cleanup` removes only Mergelane's;
  - `mergelane-daemon cleanup` works on Windows, and is tested by killing the service mid-merge.
- **VPN guard:**
  - detect active VPN adapters and their routes;
  - refuse to turn on, or turn itself off, and say why.
- **Sticky sites, limits, probes and events:** the same engine code, behind build tags where the platform differs.
- **Tests:**
  - Go unit tests on the Mac, and as Windows test programs in the kit;
  - a Windows acceptance step in the kit, like `scripts/acceptance/daemon.sh`, run by the owner as administrator
    after a warning;
  - the System merge checklist on the laptop.

### W6: real hardware and the Windows 1.0 checklist

- **The Windows hardware script** (`scripts/hardware/`), run by the owner:
  - Wi-Fi plus a phone over USB (and Ethernet if available);
  - unplug and reconnect;
  - sleep and wake;
  - a VPN on and off;
  - a crash with the service restarting.
- **Accessibility:** Narrator, and keyboard-only use.
- **Free signing:** apply to SignPath Foundation or the Microsoft Store if the owner approves. SignPath needs CI
  builds, which are paused.
- **Merge:** the owner decides when `windows` merges into `main`.

## Simulated networks on Windows

The macOS tests shape fake links with `feth` and `dummynet`. Windows has no built-in equivalent. Options to research
and decide in an ADR before W5's acceptance tests:

- Hyper-V virtual switches;
- loopback adapters with per-adapter limits;
- a user-space shaping proxy in the test servers.

Until then, Windows merging is tested with the real-hardware script and with the engine's unit tests.

## Open questions for the owner

- Whether the laptop's Smart App Control is Off, Evaluation or On.
- The laptop's chip (x64 or arm64). The other architecture is built, and tested where possible.
- Whether to keep Windows 10 22H2 as the oldest tested version: it no longer gets Microsoft security updates.
