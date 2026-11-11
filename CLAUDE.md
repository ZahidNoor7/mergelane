# Mergelane — project rules for Claude Code

Mergelane is a free, open-source (MIT) macOS app that combines:

1. An IDM-style download manager: segmented multi-connection downloads, queues, scheduling,
   browser capture, video (YouTube, HLS, DASH) and torrents.
2. Multi-network merging: it uses every internet connection the Mac has (Wi-Fi, Ethernet, iPhone/Android
   tethering) at once, both inside the downloader and system-wide for all apps.

Read this file at the start of every session. Keep `docs/PROGRESS.md` up to date at the end of every session.

## Hard constraints (do not change without the owner's explicit approval)

- **Platform:** macOS 27 and later, Apple Silicon only (arm64). No Intel/x64, no Windows, no Linux builds.
- **No Apple Developer account yet.** Every build is ad-hoc signed (`codesign --sign -`). Users must be
  able to install from the DMG with a one-time "Open Anyway" in System Settings › Privacy & Security.
  Therefore: **no Network Extension, no System Extension, no `SMAppService` daemon, no Mac App Store
  entitlements.** Design so Developer ID signing and notarization can be switched on later by config only.
- **No servers, no paid services, no telemetry, no accounts.** Everything runs on the user's Mac.
  Update checks may only query the public GitHub Releases API.
- **Coexist with VPNs.** Mergelane must never install its routes over another VPN's routes. If a
  user VPN is active, system-wide merging refuses to turn on (or turns itself off) and says why.
  In-app multi-link downloads keep working where possible.
- **Crash safety.** If any Mergelane process dies, the Mac's internet must keep working: no leftover
  routes, and a `mergelane-daemon cleanup` command must exist.
- **Legal.** No DRM circumvention. No private or sign-in-only media beyond what the user's own browser
  session legitimately provides. Never use "IDM" or other trademarks in names or marketing.
- **YouTube (owner, 2026-11-11, ADR-0026).** yt-dlp only. No cookies, and no PO tokens, captured or generated.
  Drop every format marked DRM or "maybe" DRM. Only links the user pasted or opened: no crawling. Our own
  googlevideo/SABR client and token replay are ruled out. Get a lawyer's view before the public 1.0 release.
- **Licensing.** App code is MIT. Keep the upstream MIT copyright notices (see Upstream sources).
  FFmpeg, yt-dlp and Deno ship only as separate executables, never committed. yt-dlp (GPL) and Deno (MIT) are
  fetched at build time with pinned SHA-256 checksums. FFmpeg is our own minimal LGPL build, compiled at build
  time from FFmpeg's signed source release, pinned by SHA-256 (ADR-0028). Their licences go in
  `THIRD-PARTY-NOTICES.md` and the app bundle, and every GitHub release attaches their source (ADR-0027).

## Upstream sources (all MIT)

| Upstream | What we take | Where it goes |
|---|---|---|
| github.com/anmolkapil/plexo | Electron/React app shell, download engine, torrents, scheduler, limits, browser extension, e2e suite, macOS packaging | `app/`, `extension/` |
| github.com/rohit267/net-merge | Go engine: utun + tun2socks/gVisor, balancer, scheduler, probes, adapter discovery, per-link limits | `daemon/` |
| github.com/Ahmadkhattak1/awesome-downloader | Ideas and logic only: HLS, YouTube SABR via `googlevideo`, FFmpeg mux, media detection in the extension. Windows-only code is rewritten, not copied | `app/src/main/media/`, `extension/` |

Record the exact upstream commit SHAs you imported in `docs/UPSTREAM.md`, with what you changed, so
upstream fixes can be cherry-picked later. Do not depend on upstream at runtime.

## Architecture

```
Mergelane.app (Electron, TypeScript, React)
├─ main process: download engine (from Plexo), media module, torrent engine,
│  browser bridge (native messaging), settings/history (JSON), updater (GitHub Releases)
├─ renderer: dashboard, downloads, networks, settings, diagnostics
└─ Contents/Resources/
   ├─ mergelane-daemon   (Go, arm64, ad-hoc signed)
   ├─ yt-dlp             (official macOS binary, pinned)
   ├─ deno               (official arm64 binary, pinned; yt-dlp's JavaScript runtime for YouTube)
   └─ ffmpeg             (our own arm64 LGPL build from pinned source; stream copy only)

mergelane-daemon (root, launchd LaunchDaemon)
├─ installed once by the app via an admin-password prompt
│  (binary → /Library/PrivilegedHelperTools, plist → /Library/LaunchDaemons)
├─ net-merge engine: utun + /1 capture routes, gVisor stack, per-flow balancing, IP_BOUND_IF egress
├─ VPN detection and a route-conflict guard
└─ local control API: JSON over a Unix socket with restrictive permissions; checks the
   caller's uid with LOCAL_PEERCRED; versioned protocol
```

Rules:

- The daemon and the app are independent: either one can run, crash or update without the other.
  They talk only through the versioned socket API, defined in `shared/daemon-api.ts` and the Go
  equivalent and tested from both sides.
- **The downloader's per-link sockets must stay on their link while system merging is on.** On macOS,
  pin them with `IP_BOUND_IF` / `IPV6_BOUND_IF` (via koffi `setsockopt`, following Plexo's
  `deviceBinding.ts` pattern), not just `localAddress`. Plexo currently relies on `localAddress` on macOS,
  so this is a required change. Cover it with tests.
- Keep upstream structure and naming where it already works. Prefer the upstream patterns over new
  abstractions (the owner prefers staying within established patterns).
- TypeScript strict mode, ESLint and Prettier as in Plexo. Go: `go vet`, `staticcheck`, `-race` in tests.

## Testing (required; the owner relies on e2e tests, not manual checks)

A feature is done only when its tests exist and pass in CI. Never mark a task complete with failing,
skipped or missing tests. Never weaken or delete a test to make it pass without explaining why in the PR.

Test layers:

1. **Unit and property tests:** Go `go test -race ./...`; TypeScript (fast-check where Plexo uses it).
2. **Simulated networks (CI, GitHub `macos` arm64 runners, which have passwordless sudo):**
   create fake links (`feth` pairs and/or `lo0` aliases) and shape each with `dnctl` / `pfctl` dummynet
   (bandwidth, delay, loss). Run local test servers: HTTP with ranges, a server without ranges,
   per-range ETags, redirects, HLS/DASH fixtures, a local torrent swarm (Plexo has one), and broken or
   flaky servers. Scenarios include a fast link plus a slow link, a link dying mid-download,
   a link recovering, and a simulated VPN route conflict.
3. **App e2e:** Playwright for Electron (extend Plexo's suite) and for the Chrome extension.
4. **YouTube:** recorded fixtures in CI, plus a scheduled nightly live smoke test that opens an issue on failure.
5. **Packaging test:** build the DMG, mount it on a clean runner, copy the app, set the quarantine flag,
   verify `codesign --verify --deep --strict`, launch it, and check that it reaches the ready state.
6. **Real hardware (later phases):** a self-hosted runner on the owner's M1 Mac, labelled `hardware`,
   for real Wi-Fi + iPhone USB + Ethernet, unplug/sleep/wake and VPN on/off. These jobs must be opt-in
   and must never run on pull requests from forks.
7. **Safari:** a manual checklist in `docs/SAFARI-CHECKLIST.md`, run per release.

## Safety when running on the owner's Mac

- **Ask before** any command that changes system networking, installs launchd jobs, writes to
  `/Library`, uses `sudo`, or modifies the keychain. Prefer running these in CI.
- Before testing routes locally, make sure `mergelane-daemon cleanup` works and explain how to recover.
- Never commit secrets, cookies, signed media URLs or browser profiles.

## Workflow

- Work in phases (see below). One branch and one PR per milestone-sized change; small, reviewable commits.
- Every PR states: what changed, the tests added, how to verify it, and any risks.
- Update `docs/PROGRESS.md` (done / in progress / next / blockers) and `CHANGELOG.md`.
- When a requirement is unclear or a decision is hard to reverse, stop and ask the owner. Otherwise
  choose the option most consistent with this file and record it in `docs/DECISIONS.md` (ADR style).

## Roadmap

| Phase | Goal | Exit criteria |
|---|---|---|
| 1. PoC | Prove the risky parts | See `docs/PHASE-1.md` |
| 2. MVP | One installable app: downloads, torrents, Chrome capture, YouTube, system merge on/off, failover, dashboard | DMG installs and works on a clean Mac; full CI suite green. Proposed plan: `docs/PHASE-2.md` |
| 3. Everyday | Safari extension, clipboard monitor, link priorities and cost rules, sticky-per-site routing option, diagnostics bundle, auto-update via GitHub Releases | Hardware suite green on the owner's Mac |
| 4. Production | Security hardening (IPC fuzzing, threat model), performance targets, accessibility, docs, stable 1.0 | Release checklist complete |
| Later | Developer ID signing and notarization, `SMAppService`, Homebrew cask, per-app routing via Network Extension, App Store edition | Needs an Apple Developer account |

Known product limits (show these honestly in the UI and README): one single connection always uses
one link. Only apps that open several connections, plus Mergelane's own downloads, get combined speed.
Connections already open on a link that drops must reconnect. Links only add speed if each one is a
genuinely separate internet connection.
