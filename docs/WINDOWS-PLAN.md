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
- **Where:** Windows code is written and tested on the owner's Windows laptop. Cross-platform code (TypeScript
  logic, Go packages behind build tags) is also tested on the Mac. Every macOS test must keep passing.
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

- **Development environment on the laptop:** Node.js 22, Go 1.27, Git, and the Playwright browsers. Document the
  steps in `docs/WINDOWS-DEV.md`.
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
  - Vitest and `node --test` run on Windows;
  - the Playwright smoke suite runs on Windows, with mac-only tests marked by platform, never deleted;
  - a Windows version of `scripts/hardware/hardware.mjs` for in-app merging over Wi-Fi plus a phone.

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
- **Tests:** the `@extension` Playwright suite on Windows, and Go tests for the host.

### W3: video and media tools

- `scripts/media-tools/` fetches the official Windows yt-dlp and Deno builds for x64 and arm64, pinned by SHA-256 in
  `tools.json`.
- **FFmpeg:**
  - our own minimal LGPL build for Windows x64 and arm64, from the same pinned, signed source;
  - choose the build method from FFmpeg's docs (MSYS2 on the laptop, or cross-compiling with mingw-w64), and
    record it in an ADR;
  - the same configure options and the same "stream copy only" rule as `build-ffmpeg.sh`.
- The licence texts and release sources are the same as on macOS (ADR-0027).
- **Tests:** the media and mux tests on Windows, and the yt-dlp fixture tests.

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
  - `scripts/release/local-release.mjs` gets a Windows mode, run on the laptop;
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
  - Go unit tests on Windows;
  - a Windows acceptance script, like `scripts/acceptance/daemon.sh`, run on the laptop with the owner's OK;
  - the app's System merge e2e tests.

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
