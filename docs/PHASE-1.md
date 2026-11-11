# Phase 1: proof of concept and project foundation

Status: **in progress.** Owner made the repo public and approved installing tooling on 2026-11-10.
Questions 2–4 in §4 proceed on the recommended option until the owner says otherwise.
Scope: milestones M1.1–M1.5 from `KICKOFF-PROMPT.md`. No Phase 2 features.

This plan is based on reading the three upstream repos at the commits pinned in `docs/UPSTREAM.md`.
Every claim about upstream code below was checked in that code; claims about macOS and GitHub were checked
against the sources named in the "Sources" section. Anything still unproven is marked **(spike)** and is
settled by spike S1 before the work that depends on it starts.

---

## Updates since the plan was approved

- Phase 1 is closed, pending the owner's approval. See `docs/PHASE-1-REPORT.md`.

- D1–D10 below became ADR-0001 to ADR-0010 in `docs/DECISIONS.md`.
- Spike S1 ran on `xcode-27` (macOS 27.0.1). Its findings are in ADR-0013, ADR-0015 and ADR-0017. The fake-link
  design in §6 is confirmed with one change: replies return over `lo0`, since pf `reply-to` does not work.
- M1.2 deviations:
  - Telegram is kept unchanged (ADR-0012).
  - The extension stays at `app/extension` (ADR-0014).
  - Small inline Windows/Linux branches stay, to keep upstream fixes easy to replay; build targets and
    Windows-only assets are removed.
- An REA audit (added at the owner's request) led to hardened Electron fuses and a CI fuse audit (ADR-0016).
- Criterion 2's threshold is now relative: both links must beat a measured single-link baseline, because
  dummynet on the runner delivers less than the configured rate (ADR-0015).

## 1. Goal

Prove the risky parts on real CI before building the MVP:

1. An ad-hoc-signed, arm64-only Electron app (rebranded Plexo) that installs from a DMG on a clean macOS 27 runner.
2. A root LaunchDaemon (`mergelane-daemon`, ported from Net Merge) that merges links system-wide, refuses to
   fight a VPN, and leaves the Mac's networking intact when it crashes.
3. The downloader keeps each per-link socket on its own link while system merge is on (`IP_BOUND_IF`).
4. A simulated-network harness that lets CI prove the above with shaped fake links.

## 2. What upstream gives us, and the gaps that drive this plan

### Plexo (app shell, downloader, extension)

- Electron 44, electron-vite, React 19, TypeScript, Playwright (`@playwright/test`) and fast-check. No unit-test
  runner and no coverage tooling.
- Per-link connections: each download stream belongs to a network and connects through
  `src/main/network/deviceBinding.ts` (`connectRoute`, `connectFrom`).
  - **On macOS it binds by source address only.** `deviceBindingSupported()` returns `true` early for any
    non-Linux platform, so `libc` stays `null` and `connectRoute` falls back to
    `connect({ host, port, localAddress, family })`.
  - The Linux path is the template we follow: koffi loads libc, `socket()` creates an fd,
    `setsockopt(SO_BINDTODEVICE)` pins it before connect, and the fd is wrapped with
    `new Socket({ fd, manualStart: true }).connect(...)`.
  - The packaging filter in `electron-builder.yml` strips koffi's darwin prebuilds
    (`'!node_modules/koffi/build/koffi/!(linux_x64|linux_arm64|win32_x64|win32_arm64)/**'`), so koffi cannot load
    in a packaged macOS build today.
- The e2e suite fakes two networks as `127.0.0.1` plus the machine's LAN address, with the server on loopback.
  **No test reaches the device-binding fd path**, because loopback destinations skip binding.
- Test knobs (`PLEXO_*` env vars) are read only when `!app.isPackaged`.
- No macOS job runs in Plexo's CI. The packaging job builds a Linux dir and does not launch it.
- The browser bridge is local HTTP on `127.0.0.1:19288–19290` (`/ping`, `/add`, `/confirm`), not native messaging.
- Updates go through electron-updater's GitHub provider. Telegram support needs build-time API credentials
  (secrets) and a Telegram account. Torrent DHT is on by default. There is no telemetry.

### Net Merge (daemon engine)

- Go 1.27, tun2socks v2.7.0 + gVisor. On darwin it opens a `utun`, gives it `198.18.X.1`, and adds capture routes
  `0.0.0.0/1` + `128.0.0.0/1` (plus `::/1` + `8000::/1`, best effort). TCP and UDP from the gVisor stack are dialled
  out through `Balancer.DialPinned` / `ListenUDP` with `IP_BOUND_IF` / `IPV6_BOUND_IF` (`internal/nics/egress_darwin.go`).
- Because `IP_BOUND_IF` lookups only use scoped routes, it adds `default <gw> -ifscope enX` for each link and
  re-syncs them every 3 s. **These scoped routes survive `kill -9`**; only the capture routes die with the utun.
  Upstream's own smoke test needs `net-merge cleanup` afterwards.
- Links are interfaces matching `^(en|feth)\d+$` with a default route. `feth` is accepted because TetherKit uses it,
  which suggests `feth` pairs are a realistic way to fake links in CI.
- Scheduling is per flow, weighted least-busy, with health tiers from active probes.
- **Dead-link detection is too slow for acceptance criterion 6.**
  - Probes are TCP connects to `1.1.1.1:443` / `8.8.8.8:443`. Up links are probed every 15 s, with a 2 s timeout.
  - So a link that goes silent is marked down only after about 19 s.
  - Meanwhile a connect timeout does not sideline the link, so new flows keep trying it.
- IPC is file polling under `/var/run/net-merge`. Privilege comes from a sudoers rule plus a LaunchAgent that
  runs `sudo -n`. There is no VPN detection.
- Tests: `go test` only, with no `-race` and no staticcheck. The SOCKS tests need `lo0` aliases `127.0.0.2` / `.3`.

### Awesome Downloader (ideas for Phase 2+, nothing imported in Phase 1)

- Portable logic in `core/` (HLS, SABR via `googlevideo` 5.0.1, ffmpeg mux) and an MV3 extension.
- Two items need review before Phase 2:
  - The SABR path replays the browser's own PO token and cookies to YouTube.
  - One source comment refers to another product's trademark. Nothing from it is copied.

## 3. Decisions this plan makes (each becomes an ADR in `docs/DECISIONS.md`)

| # | Decision | Why |
|---|---|---|
| D1 | Import each upstream as one verbatim commit, then make every change in later commits. | Keeps the diff against upstream reviewable and lets us replay upstream fixes with `git diff A..B \| git apply --directory=…`. |
| D2 | No JS build orchestrator. `app/` keeps Plexo's npm project; `extension/` moves to the top level with its own build; `shared/` holds `daemon-api.ts` and JSON contract fixtures. | Stays within Plexo's patterns. Turborepo is not needed for two packages. |
| D3 | `macOS 27+` is enforced with `minimumSystemVersion: "27.0"`, arm64 targets only, and `identity: "-"` (ad-hoc). `notarize: false` for now. | electron-builder's `MacConfiguration` documents `identity: "-"` as ad-hoc signing. Developer ID signing and notarization later need only config and secrets. |
| D4 | CI runs on the `xcode-27` label: arm64, macOS 27. | GitHub has no `macos-27` label; the Xcode 27 image is the macOS 27 image. |
| D5 | Daemon socket at `/var/run/mergelane/daemon.sock`, directory `0755`, socket `0666`. Every request is authorised by `LOCAL_PEERCRED`: allowed are uid 0 and the uid recorded at install time. Every message carries `"v": 1`. | Permissions alone are not enough on a multi-user Mac. A peer-uid check is the documented macOS mechanism (`SOL_LOCAL` / `LOCAL_PEERCRED` in `<sys/un.h>`). |
| D6 | Mark every route the daemon adds with `-proto2` (`RTF_PROTO2`) and also record it in a state file. `cleanup` removes only routes carrying our marker. | Upstream's cleanup deletes any scoped default whose gateway matches, which can remove routes macOS created itself. |
| D7 | After a crash, launchd restarts the daemon (`KeepAlive`). It always starts **disabled**, runs cleanup first, and the app shows "System merge turned off after an unexpected stop". | Crash safety beats convenience. Auto re-enable can come back in Phase 2 behind a setting. |
| D8 | Faster health checks: up links probed every 1 s with a 1.5 s timeout; marked down after 2 failures; a link is also sidelined on connect timeouts and when its interface loses its address or route. Probe targets are configurable; tests point them at the harness. | Needed for "new flows avoid a dead link within 5 s". |
| D9 | Phase 1 keeps Plexo's HTTP browser bridge, rebranded. Native messaging is a Phase 2 decision. | CLAUDE.md names native messaging, but Phase 1 has no extension work. This avoids rewriting the bridge twice. |
| D10 | Phase 1 turns off electron-updater auto-install. A check-only GitHub Releases API call replaces it in Phase 3. | Squirrel.Mac validates the code signature of updates. Ad-hoc signatures differ per build, so auto-install is not expected to work without Developer ID. Not verified, so it is left off rather than tested now. |

## 4. Open questions for the owner (needed before or during Phase 1)

Answers so far:

- Q1: the owner made the repo public on 2026-11-10.
- Q5: the initial commit is pushed to `main`, per the CLAUDE.md workflow (one branch and PR per milestone).
- Q2–Q4, answered by the owner on 2026-11-11:
  - Q2: accepted. CI proves the launch after the documented quarantine removal (ADR-0013).
  - Q3: accepted. Probes stay configurable and default to upstream's public targets (ADR-0008).
  - Q4: remove Telegram. It was in fact still in the app (ADR-0012), and the removal follows the YouTube work.

1. **Repo visibility and CI cost.**
   - The repo is private. On private repos macOS runners cost $0.062/min.
   - GitHub Free includes $12/month of compute, about 190 macOS minutes.
   - Phase 1 CI needs several macOS jobs per push, so the free amount will run out within days, which conflicts
     with "no paid services".
   - Standard runners are free and unlimited for public repos.
   - Recommended: make the repo public before CI lands in M1.1.
2. **Quarantined launch in criterion 1.**
   - macOS blocks a quarantined ad-hoc-signed app until a person clicks "Open Anyway", so CI may not be able to
     launch it unattended.
   - CI will prove:
     - the signature verifies (`codesign --verify --deep --strict`);
     - Gatekeeper rejects it as unnotarised, not as damaged;
     - after the documented `xattr -dr com.apple.quarantine`, it launches and reaches ready.
   - Spike S1 tries to launch with quarantine still set. If that is impossible, is the interpretation above
     acceptable?
3. **Probe targets.** Upstream probes `1.1.1.1:443` and `8.8.8.8:443` with TCP connects that send no data. Keep
   these as defaults (configurable), or probe each link's gateway only, and accept weaker detection of
   "Wi-Fi up, internet down"?
4. **Telegram.** Plexo's Telegram source needs build-time API credentials we don't have, plus a Telegram account.
   Remove it in M1.2 (recommended: simpler, and no accounts), or keep it hidden until a user enters their own API ID?
5. **First push.** OK to make one initial commit on `main` (CLAUDE.md, KICKOFF-PROMPT.md, these docs) and push it,
   then work on one branch and PR per milestone?

## 5. Milestones and order of work

Work happens in this order. Each step has its own branch and PR into `main`.

### S1. Spike: prove the CI-only unknowns (branch `spike/s1-ci-feasibility`, throwaway)

A single workflow on `xcode-27` that answers, with logs:

1. `ifconfig fethN create` + `ifconfig fethA peer fethB` works on the macOS 27 runner. Frames pass between the peers
   and `tcpdump` sees them.
2. **The far side of a fake link.** A fake link only behaves like the internet if the "remote" server address is
   *not* local to the host (otherwise the capture routes never see it). Two candidates:
   - **A (in kernel):** pf `rdr` on the peer interface to a local server, plus `reply-to` so replies go back over
     the fake link.
   - **B (user space):** a small Go "fake ISP" per link. It reads and writes frames on the peer interface through
     `/dev/bpf` and runs a gVisor netstack (already a dependency) that owns the gateway IP and a test-server IP such
     as `198.51.100.10`.

   Pick whichever carries a ranged HTTP download in both directions through the link.
3. dummynet shaping (`dnctl pipe N config bw … delay … plr …`) applied with pf rules in an anchor under
   `com.apple/*`, so `/etc/pf.conf` is not edited. Check that a 20 Mbit/s pipe measures 20 Mbit/s ±10%.
4. `IP_BOUND_IF` from Node through koffi on darwin, in the same pattern as Plexo's Linux code:
   `koffi.load('/usr/lib/libSystem.B.dylib')`, `if_nametoindex`, `socket(AF_INET=2|AF_INET6=30, SOCK_STREAM=1)`,
   `fcntl(FD_CLOEXEC)` (darwin has no `SOCK_CLOEXEC`), and
   `setsockopt(IPPROTO_IP=0, IP_BOUND_IF=25, &idx, 4)` / `setsockopt(IPPROTO_IPV6=41, IPV6_BOUND_IF=125, …)`.
   Then `new Socket({ fd, manualStart: true })`. Constants come from the macOS 27 SDK headers. The koffi docs give no
   macOS library path, so the path is part of the spike.
5. Gatekeeper on the runner: what `spctl --assess -vv` says for a quarantined ad-hoc app, and whether `open` launches it.
6. `launchctl bootstrap system` of a test LaunchDaemon, and that `KeepAlive` restarts it after `kill -9`.

Output: findings recorded as ADRs. The harness design (§6) is then fixed. If B is needed, it becomes
`daemon/internal/testnet/fakeisp`.

### M1.1 Repository foundation (branch `m1.1-foundation`)

- Layout: `app/`, `daemon/`, `extension/`, `shared/`, `scripts/`, `docs/`, `.github/workflows/`.
- `LICENSE` (MIT, Mergelane contributors) plus the upstream notices kept verbatim:
  - Plexo: "Copyright (c) 2026 Anmol Kapil"
  - Net Merge: "Copyright (c) 2026 Rohit Mahto"
  - Awesome Downloader: "Copyright (c) 2026 Awesome Downloader contributors"
- Docs: `THIRD-PARTY-NOTICES.md` (merged from both upstream notice files plus our Go and npm dependencies),
  `README.md` (honest limits and install steps), `CHANGELOG.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`
  (D1–D10 plus S1 results).
- `.gitignore`, `.editorconfig`, Prettier and ESLint as in Plexo.
- CI skeleton (`ci.yml`, all on `xcode-27`): `lint` (eslint, prettier, `go vet`, staticcheck), `typecheck`,
  `test-ts`, `test-go` (`go test -race`), plus `e2e`, `package` and `netsim` placeholders that are filled by later
  milestones. A milestone's job is not merged until it is green.
- Coverage:
  - Go: `-coverprofile`.
  - TypeScript: new and changed code is covered by Plexo-style Node-side Playwright specs run under `c8`.
  - Thresholds are enforced per touched package from this milestone on.

### M1.2 Rebranded app that installs from a DMG (branch `m1.2-app`)

1. Commit Plexo `2e44a2f` verbatim into `app/` (extension into `extension/`).
2. Rebrand:
   - `appId` → `io.github.zahidnoor7.mergelane`, `productName` → `Mergelane`, `app.setName`,
     `setAppUserModelId`, URL scheme `mergelane://`, `window.plexo` → `window.mergelane`.
   - `PLEXO_*` → `MERGELANE_*`, the `.plexo` staging suffix → `.mergelane`, UA `Mergelane/<version>`.
   - Bridge ping `app: "mergelane"`, the extension name and Firefox id, and publish owner/repo.
   - The About panel keeps the upstream credits.
3. Remove Windows and Linux:
   - electron-builder sections `win`, `nsis`, `linux`, `appImage`, `deb`, `rpm`, and every `x64` arch.
   - Files: `build/installer.nsh`, `build/icon.ico`, `sparseFile.ts` and its spec.
   - Branches: Linux and Windows code in `deviceBinding.ts` (replaced in M1.4), `interfaces.ts`, `openLinks.ts`,
     `handlers.ts`, the index/title-bar checks, and the Linux `NetworkBindingDialog`.
   - e2e: `--no-sandbox`, `taskkill` and xvfb.
4. mac config:
   - Targets `dmg` + `zip`, arch `[arm64]`; `minimumSystemVersion: "27.0"`; `identity: "-"`; `notarize: false`.
   - Keep koffi's `darwin_arm64` prebuild (fix the filter).
   - Hook points so Developer ID signing and notarization later need only `CSC_*` / `APPLE_*` secrets.
5. Ready signal: add `GET /health` to the bridge, returning `{ app: "mergelane", ready: true }`. This is needed
   because `/ping` marks the extension as used, which changes close-to-tray behaviour. It is answered only after
   the main window's `ready-to-show`.
6. Packaging test `scripts/ci/package-test.sh` (CI job `package`):
   1. Build the DMG.
   2. `hdiutil attach` it and copy `Mergelane.app` to a fresh temp "Applications" folder.
   3. `xattr -w com.apple.quarantine …`.
   4. `codesign --verify --deep --strict --verbose=2`, and check every Mach-O in the bundle is signed.
   5. Record the `spctl --assess -vv` verdict.
   6. Launch as decided under Q2 and poll `/health` until ready, with a 60 s timeout.
   7. Quit, detach, clean up.
7. README install steps: drag to Applications, open, System Settings › Privacy & Security › Open Anyway, or
   `xattr -dr com.apple.quarantine /Applications/Mergelane.app`. The same text goes into the release notes template.
8. Port Plexo's CI: lint, typecheck and the `@smoke` e2e set on macOS (the first macOS run of Plexo's suite).
   Any upstream test that fails on macOS is fixed or reported in the PR, never skipped silently.

### M1.3 `mergelane-daemon` (branch `m1.3-daemon`)

1. Commit Net Merge `2b333a3` verbatim into `daemon/`, then drop:
   - Windows and Linux files.
   - The tray, icon, update, sudoers install, LaunchAgent autostart and `scripts/winfakeup`.
   - The systray, netlink and wireguard dependencies.
2. Module `github.com/ZahidNoor7/mergelane/daemon`, binary `mergelane-daemon`.
3. Commands:
   - `run`: launchd entry point; starts disabled.
   - `install` / `uninstall`: run as root.
   - `cleanup`: removes only routes marked `RTF_PROTO2` plus anything in the state file.
   - `status` and `version`.
4. Install from the app:
   1. An admin-password prompt (`osascript … with administrator privileges`) runs
      `mergelane-daemon install --uid <console uid>`.
   2. That copies the binary to `/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon`
      (root:wheel 0755).
   3. It writes `/Library/LaunchDaemons/io.github.zahidnoor7.mergelane.daemon.plist`
      (`RunAtLoad`, `KeepAlive`, `ThrottleInterval`).
   4. It runs `launchctl bootstrap system`.
   - `uninstall` reverses all of this and runs `cleanup`.
5. Control API v1 (`shared/daemon-api.ts` and `daemon/internal/api`):
   - Newline-delimited JSON request/response over the Unix socket.
   - Methods: `status`, `enable`, `disable`, `links`, `stats`, `setLimit`.
   - Errors have stable codes, for example `VPN_ACTIVE`, `NOT_AUTHORIZED`, `UNSUPPORTED_VERSION` and
     `NO_USABLE_LINKS`, each with a human-readable message.
   - Contract fixtures live in `shared/fixtures/daemon-api/*.json` and are validated by both a Go test and a TS test.
6. VPN guard (`daemon/internal/vpnguard`), checked before `enable` and every 1 s while enabled:
   - A conflict exists if:
     - any interface we did not create (`utun*`, `ipsec*`, `ppp*`) carries a default, `0/1` or `128/1` route
       (read from the routing table with `x/net/route`); or
     - `scutil --nc list` shows a connected service.
   - If a conflict exists, `enable` returns `VPN_ACTIVE` naming the interface or service.
   - If one appears while merge is on, the daemon disables itself, removes only its own routes, and reports the reason.
7. Health and failover tuning as in D8.
8. Tests:
   - All upstream darwin-relevant Go tests are ported and pass with `-race`.
   - New unit tests: API framing, the peer-uid check (two processes, different uids in CI via `sudo -u nobody`),
     version negotiation, the VPN guard against recorded routing-table and `scutil` fixtures, the
     `RTF_PROTO2` cleanup filter, and the D8 timing using fake clocks.
   - Go statement coverage on touched packages ≥ 90%.

### M1.5 Simulated-network harness (branch `m1.5-netsim`; can overlap M1.3)

Design fixed by S1; outline in §6.

- `scripts/netsim/up.sh` / `down.sh` / `shape.sh` / `drop.sh`.
  - `down.sh` is idempotent and removes everything the harness created, found by name prefix, anchor name and pipe
    number range, even when `up.sh` died halfway.
- `scripts/netsim/with-netsim.sh <cmd>` runs `up`, then the command, then `down` from a `trap … EXIT`. Afterwards it
  asserts that the routing table, pf anchor and dummynet pipes match the pre-test snapshot, and fails the job if not.
- Local test servers (Node, reusing Plexo's `e2e/origin.ts` where it fits):
  - HTTP with ranges, without ranges, with per-range ETags, and with redirects.
  - A flaky server.
  - Plexo's torrent swarm.
  - HLS/DASH fixtures are added later; they are not needed for the Phase 1 criteria.
- Every test starts from a fresh `up` and ends with a verified `down`.

### M1.4 Downloader pinning and the System merge toggle (branch `m1.4-pinning`)

1. `deviceBinding.ts` darwin path (S1 item 4):
   - `connectRoute` and `connectFrom` create the fd through koffi, set `IP_BOUND_IF` / `IPV6_BOUND_IF` with the
     interface index, then connect with `localAddress` as well.
   - `deviceBindingSupported()` runs a real probe on darwin.
   - If binding fails, the error surfaces like any other connect error. There is no silent fall back to
     `localAddress` while merge is on.
2. Tests:
   - A Node-side spec that opens a pinned socket and reads the option back with `getsockopt` (no root needed).
   - A netsim e2e spec: with system merge on, the server sees each stream's bytes arrive on that stream's link,
     and the daemon's stats show no flows from the app.
3. App UI, kept minimal (no redesign):
   - A "System merge" toggle with its state, the reason text (for example a VPN conflict or the daemon not being
     installed), and an Install button.
   - A per-link table (name, interface, up/down, current rate, flows), polled from `stats` every 1 s.
   - The client is `app/src/main/daemon/client.ts`, using the `shared/daemon-api.ts` types.

### Phase 1 acceptance suite (CI job `acceptance`, on `xcode-27`, inside `with-netsim.sh`)

| Criterion | Test |
|---|---|
| 1. DMG installs and launches with quarantine | `package-test.sh` (see M1.2 step 6 and Q2) |
| 2. One big file uses both links; throughput above the faster link | Links A = 20 Mbit/s, B = 50 Mbit/s. The app (Playwright for Electron) downloads 200 MB from the fake ISP. Assert both links carried ≥ 15% of the bytes, the SHA-256 matches, and the average is > 55 Mbit/s. |
| 3. System merge spreads external flows; off changes nothing | Merge on: 16 parallel `curl` downloads; the server's per-link counters show both links used, each ≥ 25%. Merge off: route table equal to the pre-test snapshot, and all `curl` traffic leaves through the primary link. |
| 4. `kill -9` leaves no routes; connectivity intact | Snapshot, enable, `kill -9`. Capture routes are gone at once. Our marked scoped routes are gone after launchd restarts the daemon (≤ 10 s), and the same holds with launchd's restart blocked plus a manual `cleanup`. Then `curl` works. |
| 5. VPN present: enable refused, VPN routes untouched | A test helper opens a `utun` and adds `0/1` + `128/1`, like a real VPN. `enable` returns `VPN_ACTIVE` with the interface named; the VPN routes are byte-identical before and after. A variant has the VPN appear while merge is on: the daemon turns itself off with that reason and still leaves the VPN routes alone. |
| 6. Link drop mid-download | Two drop modes: interface down, and silent loss (dummynet `plr 1`). The download completes over A with the right SHA-256. `curl` flows started 5 s after the drop all use A. |

Then: update `docs/PROGRESS.md` and `CHANGELOG.md`, open the Phase 1 PR with links to the green runs, and stop.

## 6. Simulated-network design (to be confirmed by S1)

```text
 host (one macOS 27 VM, no namespaces, no nested virtualisation)
 ┌────────────────────────────────────────────────────────────────────────┐
 │  app / curl ──► (merge on: utun /1 routes ──► mergelane-daemon) ─┐     │
 │                                                                  │     │
 │   feth10 10.77.1.2/24 ◄── pf anchor "com.apple/mergelane-netsim":│     │
 │   feth20 10.77.2.2/24     dummynet in/out per link (dnctl pipes) │     │
 │      │ peer                    scoped routes: default/198.51.100 │     │
 │   feth11 ───► fake ISP A (gw 10.77.1.1) ─┐ via 10.77.N.1 -ifscope│     │
 │   feth21 ───► fake ISP B (gw 10.77.2.1) ─┴─► test server 198.51.100.10 │
 │                                        (counts bytes per link)         │
 │   en0 (real uplink) stays the primary default route                    │
 └────────────────────────────────────────────────────────────────────────┘
```

- `198.51.100.0/24` and `10.77.0.0/16` are reserved or private ranges that are never routed on the internet.
- The test server address is not local to the host, so it is reached only through a fake link, or through the utun
  when merge is on.
- Dropping a link: `ifconfig feth10 down`, or `dnctl pipe N config plr 1` for silent loss.
- Recovery: the reverse.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `feth` is undocumented by Apple and could change. | The harness design. | Spike S1 runs first. Fallback is the hardware runner in Phase 3; criteria that cannot be shown in CI are reported, not faked. |
| The far end of a fake link (S1 item 2) may not work in kernel. | Criteria 2, 3 and 6. | User-space fake ISP (gVisor plus BPF), using code we already depend on. |
| Gatekeeper cannot be clicked through in CI. | Criterion 1 interpretation. | Q2. |
| CI cost while the repo is private. | Blocks CI. | Q1. |
| A 3-core M1 runner may not shape 70 Mbit/s cleanly with gVisor in the path. | Criteria 2 and 3 thresholds. | Measure in S1; keep link speeds low (20/50) and judge on ratios, not absolute rates. |
| Squirrel.Mac and ad-hoc signatures. | Auto-update. | D10: off in Phase 1. |
| koffi on darwin inside Electron with a hardened runtime: `allow-jit` and `allow-unsigned-executable-memory` are in Plexo's entitlements, but library validation is not. | Pinning fails in the packaged app. | electron-builder's ad-hoc template disables library validation. The packaging test calls a pinned connect inside the packaged app. |
| Scoped default routes survive `kill -9` (upstream behaviour). | Criterion 4. | D6 + D7: marked routes, launchd restart, clean start, and the `cleanup` command. |
| IPv6 in CI: fake links are IPv4 only. | IPv6 coverage. | IPv6 pinning gets unit-tested through `getsockopt`; IPv6 merge stays best effort as upstream, and real-hardware tests come in Phase 3. |
| YouTube SABR replays a browser token. | Legal (Phase 2). | Owner and legal review before Phase 2; nothing imported now. |

## 8. Commands that need `sudo` or change networking

**Nothing in this list runs on the owner's Mac unless the owner approves it at that moment.** All of it runs in CI
on throwaway GitHub runners, which have passwordless `sudo` per GitHub's docs.

In CI (runner only):

- `ifconfig fethN create | destroy`, `ifconfig fethA peer fethB`, `ifconfig fethN inet … up | down`, and
  `ifconfig lo0 alias 127.0.0.2/32` (for the upstream SOCKS tests).
- `route -n add | delete … -ifscope fethN`, plus the daemon's own `/1` capture routes and `-proto2` scoped defaults.
- `pfctl -E` / `pfctl -X <token>`, `pfctl -a com.apple/mergelane-netsim -f … | -F all`,
  `dnctl pipe N config …`, and `dnctl pipe delete N`.
- Writing `/Library/PrivilegedHelperTools/…` and `/Library/LaunchDaemons/…`, and
  `launchctl bootstrap | bootout system …`.
- Running `mergelane-daemon run` as root, and `kill -9` of it.
- `sudo -u nobody …` (the peer-uid test).

On the owner's Mac, no `sudo` and no networking changes, but needing approval because they install software:

- `brew install go` (Go 1.27.3 is the current Homebrew stable) and `go install honnef.co/go/tools/cmd/staticcheck@<pinned>`.
- `npm ci` in `app/` (downloads Electron and npm packages into the repo).
- Building the DMG locally with `hdiutil create` / `attach` / `detach` and `codesign --sign -`. No keychain is used
  for ad-hoc signing, and the app is copied to a temp folder, not `/Applications`.

If local network testing is ever wanted (not planned in Phase 1), recovery would be:

```sh
sudo mergelane-daemon cleanup
sudo launchctl bootout system/io.github.zahidnoor7.mergelane.daemon
sudo pfctl -a com.apple/mergelane-netsim -F all
sudo dnctl -q flush
sudo ifconfig feth10 destroy
```

A reboot also clears routes, `feth` interfaces, pf rules and dummynet pipes, because none of these persist. Only the
LaunchDaemon plist persists, and it is removed with `mergelane-daemon uninstall`.

## 9. Sources

- GitHub-hosted runners reference (labels, arm64, passwordless sudo, no nested virtualisation):
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Xcode 27 image GA, macOS 27, `xcode-27` label:
  <https://github.blog/changelog/2026-10-15-xcode-27-runner-image-generally-available/>
- Actions pricing and included usage: <https://docs.github.com/en/billing/reference/actions-runner-pricing> and
  <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- electron-builder `MacConfiguration` source (`identity: "-"` ad-hoc, `hardenedRuntime`, `notarize`,
  `minimumSystemVersion`): `packages/app-builder-lib/src/options/macOptions.ts` on electron-builder `master`.
  The electron.build doc pages returned 404 or empty when fetched.
- Electron automated testing with Playwright: <https://www.electronjs.org/docs/latest/tutorial/automated-testing>
- koffi (darwin arm64 prebuilt, `koffi.load`, pointer arguments): <https://koffi.dev/>, <https://koffi.dev/load>,
  <https://koffi.dev/pointers>
- macOS 27 SDK headers on this Mac:
  - `netinet/in.h`: `IP_BOUND_IF 25`, `IPPROTO_IP 0`, `IPPROTO_IPV6 41`
  - `netinet6/in6.h`: `IPV6_BOUND_IF 125`
  - `sys/socket.h`: `AF_INET 2`, `AF_INET6 30`, `SOCK_STREAM 1`, and no `SOCK_CLOEXEC`
  - `sys/un.h`: `SOL_LOCAL 0`, `LOCAL_PEERCRED 0x001`
  - `net/route.h`: `RTF_PROTO2 0x4000`
- Man pages on this Mac: `route(8)` (`-ifscope`, `-proto2`), `dnctl(8)`, `pfctl(8)` (anchors).
- Not documented by Apple and verified only by S1: `feth` interfaces, and evaluation of pf anchors under `com.apple/*`.
