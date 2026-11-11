# Architecture decisions

Short ADRs. Each records the context, the decision and its consequences. A decision marked **Owner** was made
or confirmed by the project owner; **Proposed** means it follows CLAUDE.md and the Phase 1 plan and stands
until the owner overrides it.

---

## ADR-0001: Import upstreams as verbatim commits

- Status: Proposed (2026-11-10)
- Context: Upstream fixes should stay easy to take later. CLAUDE.md asks for exact SHAs in `docs/UPSTREAM.md`.
- Decision:
  - Each upstream is imported in one commit containing its files unchanged at the pinned SHA, placed at the
    target path.
  - All Mergelane changes come in later commits.
  - Upstream fixes are replayed with `git diff old..new | git apply --3way --directory=<dir>`.
- Consequences: the first PR for each component has a large import commit, which reviewers can skip. Later
  diffs show only our changes.

## ADR-0002: No JS build orchestrator

- Status: Proposed (2026-11-10)
- Context: There are two JS packages (the app and the extension) and one Go module.
- Decision:
  - `app/` keeps Plexo's npm project as it is.
  - `extension/` lives at the top level with its own build script.
  - `shared/` holds the daemon API types and JSON contract fixtures.
  - No Turborepo and no npm workspaces for now.
- Consequences: CI runs each package's own scripts. This can be revisited if the number of packages grows.

## ADR-0003: Ad-hoc signing now, Developer ID later by config

- Status: Proposed (2026-11-10)
- Context: There is no Apple Developer account. electron-builder's `MacConfiguration` documents
  `identity: "-"` as ad-hoc signing, and `notarize` defaults on when credentials exist.
- Decision:
  - `mac.identity: "-"`, `mac.notarize: false`, `minimumSystemVersion: "27.0"`, arm64 only.
  - Developer ID signing will later be switched on by setting `CSC_*` / `APPLE_*` secrets and flipping those
    two fields.
- Consequences: Gatekeeper asks users to confirm once ("Open Anyway"). Auto-update is affected, see ADR-0010.

## ADR-0004: CI runs on the `xcode-27` runner label

- Status: Proposed (2026-11-10)
- Context: The app requires macOS 27. GitHub has no `macos-27` label; the Xcode 27 image runs macOS 27 and is
  arm64 only (GitHub changelog, 2026-10-15). Standard runners are free for public repos.
- Decision: Every macOS job uses `runs-on: xcode-27`. Actions are pinned by commit SHA.
- Consequences: If GitHub adds a `macos-27` label, switching is a one-line change.

## ADR-0005: Daemon control socket and authorisation

- Status: Proposed (2026-11-10)
- Decision:
  - Socket `/var/run/mergelane/daemon.sock`, directory `0755`, socket `0666`.
  - Every request is authorised by the peer uid from `LOCAL_PEERCRED` (`SOL_LOCAL`, `<sys/un.h>`). Allowed are
    uid 0 and the console user's uid recorded at install time.
  - Every message carries a protocol version.
- Consequences: Other local users can connect but are refused, with a stable `NOT_AUTHORIZED` error.

## ADR-0006: Mark the daemon's routes

- Status: Proposed (2026-11-10)
- Context: Upstream cleanup deletes any scoped default route whose gateway matches the primary, which may
  remove routes macOS itself created.
- Decision:
  - Every route the daemon adds carries `-proto2` (`RTF_PROTO2`) and is also recorded in a state file.
  - `cleanup` removes only routes with that marker, plus those in the state file.
- Consequences: Cleanup never touches routes it did not create.

## ADR-0007: Start disabled after a crash

- Status: Proposed (2026-11-10)
- Decision:
  - launchd restarts the daemon (`KeepAlive`).
  - On every start the daemon runs cleanup and stays disabled until asked to enable.
  - The app explains that system merge was turned off after an unexpected stop.
- Consequences: A crash costs the user a click. Auto re-enable may come back behind a setting in Phase 2.
- Update (2026-11-11): the optional setting now exists, off by default (ADR-0024). With it off, this ADR still applies.

## ADR-0008: Faster link health checks

- Status: Accepted by the owner (2026-11-11). Implemented in M1.3 (`daemon/internal/engine/probe.go`).
- Context: Upstream marks a silent link down after about 19 s. Phase 1 requires that new flows avoid a dead link
  within 5 s.
- Decision:
  - Up links are probed every 2 s. A probe dials every target in parallel and fails after 1.5 s.
  - One failed probe moves the link to the "down" tier. A down link is probed every 1 s and rejoins on its
    first success.
  - A connect that times out or finds the host unreachable through a link triggers an immediate re-probe of
    that link (`Scheduler.Suspect`). The link is not sidelined, because the destination may be at fault.
  - Probe targets are configurable (`engine.SetProbeTargets`). They default to upstream's (`1.1.1.1:443`,
    `8.8.8.8:443`, TCP connect only, no data sent); tests point them at the simulated network.
  - Worst-case detection: 2 s interval + 1.5 s timeout + 1 s scheduler tick = 4.5 s, asserted by a unit test.
- Consequences:
  - About one TCP handshake per link every 2 s.
  - A single lost probe briefly demotes a link for new flows only; existing flows are unaffected.
- Owner answer (2026-11-11, PHASE-1 §4 Q3): keep probing public targets. A gateway-only probe would miss "Wi-Fi up,
  internet down".

## ADR-0009: Keep Plexo's HTTP browser bridge in Phase 1

- Status: Proposed (2026-11-10)
- Context:
  - CLAUDE.md's architecture names native messaging.
  - Plexo uses local HTTP on `127.0.0.1:19288–19290` with Origin and Host checks and per-offer tokens.
  - Phase 1 has no extension work.
- Decision: Phase 1 rebrands the HTTP bridge only. The move to native messaging is decided at the start of Phase 2.
- Consequences: No bridge rewrite during the proof of concept.

## ADR-0010: Auto-update off in Phase 1

- Status: Superseded by ADR-0036 (2026-11-11). Proposed 2026-11-10.
- Context: Auto-install of updates on macOS validates code signatures, and ad-hoc signatures differ between
  builds. This is not verified yet, so it is not relied upon.
- Decision: Disable electron-updater's download and install in Phase 1. A check-only GitHub Releases API call
  arrives in Phase 3.
- Consequences: Users update by downloading the new DMG.

## ADR-0011: Repository is public

- Status: Owner (2026-11-10)
- Context: macOS minutes on private repos are billed, and that conflicts with "no paid services".
- Decision: The repository is public, so standard GitHub-hosted runners are free.

## ADR-0012: Telegram source kept, unchanged, for now

- Status: Superseded (2026-11-11). The owner chose to remove the Telegram source (PHASE-1 §4 Q4). Removed on branch
  `m2.6-remove-telegram`:
  - the source, its dialog and its build-time credentials are gone, with the `telegram`, `qrcode` and `big-integer`
    packages, which only it used;
  - Telegram entries an older build saved are dropped when loaded, and their partial data is cleared, never the
    user's finished files (`e2e/recovery.spec.ts`).
- Context:
  - Plexo's Telegram source needs a Telegram account plus API credentials. Plexo injects its own at build
    time; Mergelane has none, so users must enter their own.
  - Removing the feature touches about 25 files, including UI, and widens the diff against upstream
    (ADR-0001).
- Decision: Keep it unchanged in Phase 1. It works only with the user's own Telegram API ID; Mergelane itself
  still has no accounts.
- Consequences: The owner decides before Phase 2 whether it stays.

## ADR-0013: Packaging test launches after the documented quarantine removal

- Status: Accepted by the owner (2026-11-11, PHASE-1 §4 Q2). Confirmed by spike S1.
- Decision: The packaging test proves that:
  - the signature verifies;
  - Gatekeeper's verdict on the quarantined app is "not notarised", not "damaged";
  - the app reaches its ready state after `xattr -dr com.apple.quarantine`, the documented install step.
- Evidence (spike S1, `xcode-27` runner, macOS 27.0.1):
  - For a quarantined ad-hoc app, `spctl --assess` says `rejected`.
  - `syspolicy_check distribution` reports "Adhoc Signed App" (warning) and "Notary Ticket Missing" (fatal),
    not damage.
  - `open` on the quarantined app waits on the Gatekeeper dialog until killed.
  - After `xattr -dr com.apple.quarantine`, `open` launches it.
- Consequences: The one manual click ("Open Anyway") is not automated. `scripts/ci/package-test.sh`
  implements this test.

## ADR-0014: The browser extension stays under `app/extension` in Phase 1

- Status: Proposed (2026-11-10)
- Context:
  - The kickoff lists a top-level `extension/`.
  - Plexo's extension imports the app's shared types (`src/shared/browserBridge.ts`, `types.ts`) and fonts,
    and builds and typechecks with the app's Vite, TypeScript and ESLint.
  - Moving it would need its own package and a second install of the same toolchain, or npm workspaces,
    which changes Plexo's lockfile and packaging.
- Decision: Keep it at `app/extension` in Phase 1, following CLAUDE.md's "keep upstream structure where it
  already works".
- Consequences: Revisit in Phase 2 with the native-messaging decision (ADR-0009), which reworks the extension
  anyway.

## ADR-0015: Simulated links use `feth` pairs, pf `rdr` and dummynet (spike S1)

- Status: Proposed (2026-11-10). Evidence: spike S1 runs 1 and 2 on `xcode-27`.
- Decision: Each fake link N has these parts:
  - `fethN0` (client side, `10.77.N.2/24`), peered with `fethN1` (far side, `10.77.10N.1/30`).
  - A static ARP entry for the gateway `10.77.N.1` on `fethN0`, pointing at `fethN1`.
  - A scoped route `198.51.100.0/24 via 10.77.N.1 -ifscope fethN0`.
  - pf `rdr on fethN1` sends the "internet" server `198.51.100.10:80` to a local server on `10.77.99.1:808N`.
    Replies return over `lo0`.
  - Shaping uses dummynet pipes in the anchor `com.apple/<name>`, applied on `fethN0` out and `lo0` out.
  - pf is enabled with a reference token (`pfctl -E` / `-X`).
- Evidence:
  - Sockets pinned with `IP_BOUND_IF` reach the server through each link, and the server sees each link's own
    source address.
  - Two links together carry more than either alone (38.9 Mbit/s against 16.1 and 23.8).
  - Silent loss (`plr 1`) stops one link while the other continues.
  - An unpinned socket cannot reach the server, because the routes are scoped.
- Limits found:
  - Measured rates sit below the configured ones (16/20 and 24/50 Mbit/s with 100-slot queues), so acceptance
    tests compare against a measured single-link baseline, not the configured rate.
  - After `ifconfig down` and `up`, a link did not carry traffic again even with its route and ARP entry
    re-added. Link recovery is not a Phase 1 criterion, so M1.5 investigates it.
    - Update (2026-11-11): XNU's source shows that `ifconfig down` deletes every IPv4 route that uses the link's
      address, static ones included (the ARP entry, the scoped default and a `via` route), and `up` restores only
      the interface route. `netsim.sh restore` now re-adds all of them. A new `gone` mode destroys and recreates
      the link, so it returns with a new index. Proven only once the root suite runs.
  - pf `reply-to` does not work here: `arp -s` refuses a local address.

## ADR-0016: Harden Electron fuses, and audit them with REA in CI

- Status: Proposed (2026-11-10)
- Context: An REA (`rea-agents` 6.8.0, added at the owner's request) audit of the first packaged build found
  every Electron fuse at its default. That includes `RunAsNode` enabled, which lets anyone run the signed app
  as a plain Node.js interpreter.
- Decision:
  - `electronFuses` in `app/electron-builder.yml` turns off `runAsNode`, the `NODE_OPTIONS` variable and the
    `--inspect` arguments.
  - It turns on cookie encryption, embedded ASAR integrity validation and only-load-from-ASAR.
  - `grantFileProtocolExtraPrivileges` stays at its default, because the UI loads from `file://`.
  - The CI `package` job runs `scripts/ci/audit-fuses.mjs`, which reads the fuse bytes with REA and fails on
    any difference.
- Consequences:
  - `process.fork` from the main process would not work; the app uses none.
  - The audit downloads a pinned REA package in CI. It is a test tool only, never shipped.

## ADR-0017: launchd restarts the daemon within about a second (spike S1)

- Status: Proposed (2026-11-10)
- Evidence: A system LaunchDaemon with `KeepAlive` and `ThrottleInterval 1` restarted 1 s after `kill -9` on
  the runner.
- Context: A process-owned `utun` and its `0/1` and `128/1` routes disappear when the owning process is killed
  with `kill -9`, and connectivity stays intact.
- Decision: The daemon's plist uses `KeepAlive` with a short `ThrottleInterval`. Its startup cleanup
  (ADR-0006, ADR-0007) removes any marked routes left behind.
- Related finding: `scutil --nc list` does not show a VPN made from a plain process's `utun`, so the VPN guard
  must read the routing table and cannot rely on `scutil` alone. The runner also has `utun0`–`utun3` without
  routes, so a `utun` with no default, `0/1` or `128/1` route must not count as a VPN.

## ADR-0018: What the VPN guard counts as a conflict, and how our routes are told apart

- Status: Proposed (2026-11-10). Implemented in M1.3 (`daemon/internal/vpnguard`, `routemark`, `rib`).
- What counts as a conflict:
  - An *unscoped* default, `0/1`, `128/1`, `::/1` or `8000::/1` route on a `utun`, `ipsec`, `ppp`, `tun` or `tap`
    interface that is not the daemon's own.
  - A `scutil --nc list` service that is Connected, Connecting or Disconnecting.
- What does not:
  - Scoped defaults on `utun`. macOS keeps `fe80` scoped defaults on several utuns with no VPN at all (seen on
    the owner's Mac and the runner), and scoped routes capture no traffic.
  - A split VPN that installs only a scoped default is therefore not detected by routes, only by `scutil`
    when it is a Network Extension VPN.
- Route marks:
  - `RTF_PROTO2` is also `RTF_ANNOUNCE`, which XNU uses for published proxy-ARP/NDP entries.
  - So "ours" means the flag plus the shape of a route we add: a /0 or /1, not a host or link-layer entry.
- Off:
  - XNU's `RTM_DELETE` matches by destination and mask only.
  - So `Off` deletes only the capture routes the routing table shows on our own utun. Otherwise it could delete
    another VPN's `0/1`.
  - Proven in CI: criterion 5's "VPN appears while merging is on" case keeps the VPN's routes.
- x/net v0.56.0 reads `rtm_use` as the error field on darwin. `rib.Read` ignores it, with a regression test.

## ADR-0019: The bundled helper runs only after the app is approved

- Status: Proposed (2026-11-10)
- Context: On macOS 27.0.1, running `Contents/Resources/mergelane-daemon` from an app bundle that still carries
  the quarantine flag is killed (exit 137) and shows the "Not Opened" dialog.
- Decision:
  - The app offers the one-time install only from the running app, which the user has already approved with
    Open Anyway (the README's install step). The installer copies the helper to
    `/Library/PrivilegedHelperTools`.
  - `package-test.sh` checks the helper after the approval step.
- Consequences: The admin-prompt install is still to be confirmed on real hardware (Phase 3 hardware runner).

## ADR-0020: CI paused, runs by hand only

- Status: Owner (2026-11-10). Reconfirmed 2026-11-11: CI stays paused, and no manual runs either for now.
- Decision: At the owner's request, `.github/workflows/ci.yml` runs only on `workflow_dispatch`. Pushes and pull
  requests trigger nothing until the owner asks to resume (the original triggers are noted in the file).
- Consequences:
  - The kickoff requires the Phase 1 acceptance criteria to be shown passing in CI. While CI is paused, new
    changes are not proven there.
  - Runs that already passed remain the evidence, listed in `docs/PROGRESS.md`.
  - Start a run with `gh workflow run ci.yml --ref <branch>`.

## ADR-0021: Browser capture uses native messaging (supersedes ADR-0009)

- Status: Owner (2026-11-10)
- Context:
  - Plexo's bridge is an HTTP server on `127.0.0.1:19288–19290` that any local program can reach.
  - CLAUDE.md's architecture names native messaging.
- Decision:
  - The extension talks through native messaging to a small Go host, `mergelane-nmhost`, shipped in the app bundle.
  - The host relays each message to the app over a 0600 Unix socket in the app's Application Support folder.
  - The protocol is in `docs/BROWSER-BRIDGE.md`.
  - The HTTP bridge is removed, including the packaging test's `/health`, which moves to the socket.
  - The app writes the per-user host manifests for Chrome, Chromium and Firefox when it starts. No admin rights.
- Consequences:
  - No network port is open; websites can't reach the bridge; other user accounts can't reach the socket.
  - Limit: a program running as the same user could still launch the host or connect to the socket itself.
    No design can stop software that already runs as the user. The app checks the caller's extension ID as
    defence in depth.
  - The extension's Chrome ID is fixed by a `key` in its manifest.

## ADR-0022: Where yt-dlp and FFmpeg come from

- Status: yt-dlp part accepted by the owner (2026-11-11). The FFmpeg part is superseded by ADR-0028: we build our
  own.
- Decision:
  - yt-dlp: the official `yt-dlp_macos` release (universal, includes arm64), pinned to the hash in the release's
    `SHA2-256SUMS`.
  - FFmpeg: the static arm64 build by Martin Riedl, pinned to its published zip hash and to the hash of the program
    inside it. It publishes its configure line, and its build script is public.
- Evidence and alternatives:
  - ffmpeg.org's only macOS link (evermeet.cx) is Intel-only.
  - osxexperts.net publishes no configure flags.
  - The ffmpeg-static npm package re-ships an old osxexperts build.
- Consequences:
  - Both ship as separate GPL-3.0-or-later executables, with their licence texts in the bundle.
  - Trust in the FFmpeg build rests on one maintainer's server; building FFmpeg in CI ourselves is the alternative.
  - Fetched by `scripts/media-tools/fetch.mjs`, which verifies every hash before anything becomes executable.

## ADR-0023: The extension offers streams the page already loads (option D); YouTube pending

- Status: Proposed (2026-11-10). The YouTube approach is now decided by ADR-0026.
- Decision:
  - The extension observes the HLS and DASH manifests a tab loads (headers only) and lists them in its popup.
  - The user hands one to Mergelane, which treats it like any other link. There is no site-specific logic.
  - YouTube hosts (`youtube.com`, `youtube-nocookie.com`, `youtu.be`, `googlevideo.com`) are not listed until the
    owner chooses an approach.
- Limits: manifests fetched by a site's service worker, built in JavaScript, served from `blob:` URLs or answered
  from Chrome's memory cache are not seen.

## ADR-0024: Optional auto-resume after a crash (follows ADR-0007)

- Status: Proposed (2026-11-11). Implemented in M2.4 (`daemon/internal/state/prefs.go`, `control.Resume`,
  `cmd/mergelane-daemon/run.go`).
- Decision:
  - A new `setAutoResume {enabled}` setting, off by default. The daemon saves it in `prefs.json` in its state
    directory, together with:
    - `wantOn`: the user's last explicit choice (on or off);
    - `cleanExit`: written false at start, true on SIGTERM or SIGINT.
  - A start counts as a crash only when the previous run did not exit cleanly and either left marked routes or
    had `wantOn` set. With no `prefs.json`, the routing table decides alone, as before.
  - After a crash with the setting on, the daemon waits up to 10 s for a link to pass its probe, then runs every
    check that `enable` runs (VPN guard, usable links) and turns merging back on. If any check fails, merging
    stays off and the status reason says why.
  - A clean restart always starts off: a reboot, a logout, or a helper update.
- Consequences:
  - With the user's consent, a crash no longer costs a click.
  - Marked routes left after a clean exit are still cleaned up, but are no longer reported as a crash.
  - After a helper update the daemon starts off, so the app turns merging back on itself if it was on before
    the update.
  - Tested in unit tests only. A real `kill -9`, launchd restart and route re-install needs the root acceptance
    run in CI, which is paused (ADR-0020).

## ADR-0025: Links that come back, and the link-event log

- Status: Proposed (2026-11-11). Implemented in M2.4 (`daemon/internal/engine`, `daemon/internal/tun`,
  `daemon/internal/nics`).
- Context: after unplugging, sleep and wake, or a USB tether reconnecting, a link can disappear and return,
  sometimes with a new interface index. Probe results from before the return could mark it down again, and the
  scoped-route sync could forget or duplicate its own routes.
- Decision:
  - A link that vanishes and returns, or returns with a new interface index, starts again from scratch: state
    unknown, cooldown cleared, counters reset, probed at the next tick. Probe results from before the return are
    discarded when they arrive.
  - The interface index is kept with the link's addresses and swapped atomically, so every pinned dial reads the
    current index.
  - The scoped-route sync tells its own routes from macOS's by the route marker (`RTF_PROTO2`, ADR-0018):
    - macOS's own scoped default: left alone;
    - ours with the right gateway: adopted, even if the sync had lost track of it;
    - ours with an old gateway: replaced;
    - a link whose only default route is scoped: left to macOS.
  - The daemon keeps the last 50 link changes in memory and serves them through a new `events` method (protocol
    v1, additive), oldest first. States: `up`, `unknown`, `down`, `gone`. Reasons: `found`, `lost`, `returned`,
    `address`, `probe-ok`, `probe-failed`.
- Consequences:
  - Failover history can be shown in the app, from the daemon's own record.
  - The history is lost when the daemon restarts.
  - How the macOS kernel treats these routes on real interfaces (down and up, a network change, a tether with
    a new index) could not be checked against an official source. It must be confirmed on the hardware runner.

## ADR-0026: YouTube through yt-dlp only, with hard limits (option A)

- Status: Accepted by the owner (2026-11-11). Review: `docs/YOUTUBE-REVIEW.md`. Implementation: M2.2 YouTube.
- Context: every way of downloading from YouTube is outside YouTube's Terms of Service; the review compared six
  options. CLAUDE.md forbids DRM circumvention and sign-in-only media.
- Decision:
  - YouTube links are resolved by the bundled yt-dlp only (option A). Other sites keep option D: the extension
    offers the HLS and DASH streams a page loads (ADR-0023).
  - No cookies, and no PO tokens, captured or generated. Option B (cookies) is not offered; options C (our own
    googlevideo/SABR client) and F (token replay) are ruled out.
  - Every format marked DRM or "maybe" DRM is dropped.
  - Only links the user pasted or opened. No crawling of playlists or channels.
  - yt-dlp needs a JavaScript runtime for YouTube; Deno ships as a third pinned program (ADR-0029). The app itself
    can't act as Node (ADR-0016).
  - The limits are written into CLAUDE.md.
- Consequences:
  - Some videos will fail: anything that needs a sign-in, a token or DRM. The app says so in plain words.
  - YouTube changes often; the pinned yt-dlp must be updated when it breaks (about monthly upstream).
  - Before the public 1.0 release, get a lawyer's view (the review notes a German ruling).

## ADR-0027: Every release attaches the source of the programs it bundles

- Status: Accepted by the owner (2026-11-11).
- Context: GPL version 3 (yt-dlp's macOS program) and LGPL version 2.1 (our FFmpeg, ADR-0028) require us to make
  the Corresponding Source available. Pointing at someone else's server is allowed, but we stay responsible if it
  disappears (`docs/MEDIA-TOOLS.md`).
- Decision: the release workflow attaches, to every GitHub release:
  - FFmpeg's source release tarball, exactly the one the build verified, plus our build script (in the tagged
    repository);
  - yt-dlp's source tarball for the bundled version, pinned by its published SHA-256.
  - Deno is MIT: its licence text ships in the app, and no source is attached.
- Consequences: each release carries about 20 MB of source archives. GitHub Releases is free for public repositories.

## ADR-0028: Mergelane builds its own minimal FFmpeg (supersedes ADR-0022's FFmpeg part)

- Status: Accepted by the owner (2026-11-11).
- Context:
  - ADR-0022 picked Martin Riedl's static GPL build. Its build script downloads x264 from the `master` branch on
    every build and doesn't record the commit (`script/build-x264.sh`, checked 2026-11-11), so we can't attach the
    exact source of the program we would ship (ADR-0027).
  - Mergelane only joins and rewraps media with stream copy (`app/src/main/media/mux`), so it needs no encoders.
- Decision:
  - `scripts/media-tools/build-ffmpeg.sh` builds FFmpeg from FFmpeg's official source release at build time:
    - the tarball is pinned by SHA-256, and FFmpeg's GPG signature was checked when it was pinned (key
      `FCF986EA15E6E293A5644F10B4322F04D67658D8`, as published on ffmpeg.org);
    - `--disable-everything`, then only what stream copy needs:
      - demuxers mov, mpegts, matroska, aac, mp3, ac3 and eac3, and muxers mp4 and matroska;
      - parsers, a few decoders that read stream parameters, and the needed bitstream filters;
      - the `file` protocol for the media, and `pipe`, for the mux module's `-progress pipe:1` (inputs stay limited to
        `file` by `-protocol_whitelist file`). Leaving `pipe` out broke every join through the app, which the first
        52-combination check, run without `-progress`, did not catch; `e2e/mux.spec.ts` now checks the protocol list;
    - no network, no devices and no outside libraries beyond macOS's zlib and system frameworks;
    - not `--enable-gpl` or `--enable-version3`, so the program is **LGPL version 2.1 or later**. The script
      refuses a build that reports anything else.
  - The tests make their sample media with a full FFmpeg (Homebrew's, test-only, never shipped) and join it with
    ours.
- Evidence (2026-11-11, FFmpeg 9.0.2, this Mac):
  - the build takes about 35 s and gives a 4.1 MB program (the static build was 66 MB);
  - it links only macOS's own libraries;
  - it joined all 52 of our video and audio combinations, identical to Homebrew's full FFmpeg 8.1.2:
    - H.264, HEVC, VP9 and AV1 video, each with AAC (MP4 and ADTS), Opus, MP3, AC-3 and E-AC-3 audio, into both MP4
      and MKV;
    - MPEG-TS with H.264 or HEVC, rewrapped into both.
- Consequences:
  - The exact Corresponding Source is one tarball plus one script. Two separate builds gave the same SHA-256.
  - Each app build compiles FFmpeg (the first fetch takes about 80 s in all). The result is cached in
    `app/resources/bin`, keyed by the tarball, the script and the program's hash.
  - Anything beyond stream copy, such as re-encoding, would need this build to grow.

## ADR-0029: Deno ships as a third pinned program

- Status: Accepted by the owner as part of option A (2026-11-11). Implemented in M2.2 YouTube.
- Decision:
  - Deno 2.9.8 (`deno-aarch64-apple-darwin.zip`) is fetched by `fetch.mjs`, with both of the publisher's SHA-256s
    pinned (zip and program). It ships as `Contents/Resources/deno` with its MIT licence, and `package-test.sh` checks
    that it runs JavaScript after the hardened-runtime re-sign.
  - Only yt-dlp runs it, through `--no-js-runtimes --js-runtimes deno:<path>`, with `DENO_DIR` in a private folder
    deleted after each run and `DENO_NO_UPDATE_CHECK=1`.
  - yt-dlp's built-in, hash-checked challenge scripts (`yt-dlp-ejs`) are used. `--no-remote-components` is always
    passed, so no unpinned code is fetched at run time.
- Consequences:
  - About 81 MB more in the app. No source to attach, since Deno is MIT (ADR-0027).
  - Resolved (2026-11-11): Deno publishes no notices file, so `scripts/media-tools/deno-notices.mjs` builds
    `licenses/deno/THIRD-PARTY-NOTICES.txt` from pinned inputs. It reproduces byte for byte and ships in the app.
    - **Rust:** every crate in Deno's `Cargo.lock`, each checked against its hash. 25 crates carry only their
      licence's standard text, without the authors' copyright lines.
    - **V8:** rusty_v8 and its submodules (V8, ICU, Abseil, LLVM's libc++ and others).
    - **JavaScript and TypeScript:** TypeScript, and Node.js's own licence part.

## ADR-0030: How YouTube downloads run on several networks (implements ADR-0026)

- Status: Accepted (2026-11-11). Implemented in M2.2 YouTube (`app/src/main/media/youtube`).
- Context: YouTube's media addresses carry the asking IP address as a signed parameter (`ip` is in `sparams`), so
  an address fetched over one network is meant for that network only.
- Decision:
  - Each network asks yt-dlp for its own addresses, through a loopback CONNECT proxy:
    - the proxy's connections are pinned to that network with `IP_BOUND_IF`;
    - it listens on 127.0.0.1 only, only for one yt-dlp run, and only for random credentials.
  - Each network then downloads with its own addresses, in byte ranges of at most 10 MiB (yt-dlp's chunk size).
  - Addresses are never saved, only the watch page and the format IDs. A network asks again on every run, a minute
    before its addresses expire, and after an HTTP 403. After two refusals in a row it sits out.
  - A network whose request fails sits out; if every network fails, the download fails in plain words.
- Consequences:
  - Each download costs one yt-dlp run per network, plus one for the New download dialog. That is more requests to
    YouTube, so bot checks or rate limits may come sooner than for a single-network downloader.
  - That two real networks with different public IPs each get working addresses must still be confirmed on real
    hardware.

## ADR-0031: Ship yt-dlp's unpacked macOS build (updates ADR-0022's yt-dlp part)

- Status: Accepted (2026-11-11).
- Context: the single-file `yt-dlp_macos` unpacks its Python runtime on every start. On the owner's Mac that took
  about 24 s per run. YouTube downloads run yt-dlp at least twice (ADR-0030).
- Decision: ship the official `yt-dlp_macos.zip` from the same release instead, a folder with the program and its
  `_internal` files, pinned by its SHA-256 in the release's `SHA2-256SUMS`. It starts in about 0.25 s after the
  first run.
- Consequences:
  - The fetch script installs a folder rather than one file.
  - The published zip stores three symlinks inside `_internal/Python.framework` as plain copies (yt-dlp's
    `build.yml` zips without `-y`), and codesign then refuses the folder ("bundle format is ambiguous"). The fetch
    turns each copy back into its link, only when it is byte-identical to the target (listed as `links` in
    `tools.json`). With that, a mock app signed as electron-builder signs verified, all 107 Mach-O files included.
  - Measured on the owner's Mac: the first start after a fresh install takes about 21–25 s (macOS's one-time check
    of new programs; 0.6 s of CPU), then 0.25 s. Re-signed with the hardened runtime: 0.32 s, then 0.25 s. The first
    start after a user installs the quarantined DMG is not measured yet.
  - Packaging re-signs every Mach-O file inside it.
  - The licence analysis is unchanged: the program as a whole is GPL-3.0-or-later, and its source is the same
    `yt-dlp.tar.gz`.

## ADR-0032: CI checks and releases run on the owner's Mac (follows ADR-0020)

- Status: Owner (2026-11-11). GitHub CI stays paused, and the owner chose to run everything on their own Mac.
- Decision:
  - `scripts/ci/local.sh` runs `ci.yml`'s jobs that need no root, reading the commands from `ci.yml` itself, so the
    two can't drift. A new non-root step runs automatically. A root step, an unknown action or a `${{ }}`
    expression stops the plan until a rule covers it.
  - `scripts/ci/local-root.sh` runs the root jobs (netsim, daemon acceptance, app acceptance) with the owner's
    password, typed once in their own Terminal:
    - It refuses to start while a VPN is up, a test is already running or Mergelane is open.
    - It backs up the installed helper (plist, binary, settings) to `/var/db/mergelane-local-ci`, checks the copies'
      hashes, and pauses the helper.
    - pf changes are limited to the harness's own anchor, released with a reference token.
    - It restores everything on success, failure, Ctrl-C or a closed Terminal, with a root watchdog for a runner
      that is killed outright. Then it verifies the routing table, the leftovers, the helper and the internet.
    - It offers a dry run and a `--restore` mode.
  - `scripts/release/local-release.mjs` mirrors `release.yml`. It uploads only with `--upload`, always as a draft,
    and refuses an existing tag.
  - "Works on a clean Mac" becomes the owner installing the DMG by hand.
- Consequences:
  - There is no CI record for new changes; the local logs in `local-ci-logs/` are the evidence.
  - While the root suite runs, the owner's real internet is cut for short stretches (about 3 minutes in 20).

## ADR-0033: The packaging test's local mode (amends ADR-0013 for local runs)

- Status: Accepted (2026-11-11).
- Decision: `package-test.sh --local` (or `MERGELANE_PACKAGE_TEST_LOCAL=1`):
  - **No quarantine flag and no Gatekeeper assessment.** An earlier local quarantine test brought up Apple's
    malware warning for the owner. A DMG that already carries the flag is refused.
  - **The packaged app's launch is isolated:**
    - it runs with `HOME` and `CFFIXED_USER_HOME` set to a test folder, plus `--user-data-dir` and
      `--use-mock-keychain`;
    - it is quit by PID, never through AppleScript;
    - before-and-after snapshots of the owner's Mergelane data, the browsers' native-messaging manifests,
      preferences and keychain item fail the test on any change;
    - it is skipped unless the saved `mergelane:` handler is already Mergelane's.
- Evidence: three local launches reached ready with all 106 snapshot entries unchanged, while the owner's own
  Mergelane kept running. `CFFIXED_USER_HOME` is read by Apple's open-source CoreFoundation but is not documented by
  Apple.
- Consequences: the Gatekeeper verdict ("not notarised", not "damaged") is proven only by the CI path.

## ADR-0034: The owner's redesign is Phase 3's first milestone (M3.1)

- Status: Accepted by the owner (2026-11-11). The plan around it, `docs/PHASE-3.md`, is proposed.
- Context: the renderer still looks like Plexo's. The owner designed a new look in a claude.ai artifact and declared it
  final on 2026-11-11. The roadmap has no place for it.
- Decision:
  - The redesign is M3.1, the first milestone of Phase 3, released as 0.2.0, before Phase 3's features. Their new
    screens are then built once, in the new style.
  - The reference is the fixed copy in `design-system/mergelane/redesign/` (artifact version `1794387759-a310`).
  - All seven themes ship, each in light and dark: Porcelain (the default), Sandstone, Graphite, Sage, Dusk, Liquid
    Glass and High contrast.
  - The app opens on Downloads.
  - Auto appearance (follow the Mac) comes back. Electron's `nativeTheme.themeSource` accepts `system`
    (electronjs.org, latest docs, read 2026-11-11; recheck on Electron 44 when building).
  - Screens for features the app doesn't have yet (updates, extension management, routing per direction, upload
    limits, daily totals, menu bar, login item, notifications) ship with the milestone that builds each feature. A
    control with nothing behind it is not shipped.
  - Features the app has that the design leaves out are kept and restyled into the new layout.
  - The per-network colour picker stays. A picked colour overrides the theme's colour, which is the default.
  - Network rows show the connection type, not the Wi-Fi name, so no Location permission is asked for.
  - Renderer code gets unit tests with Vitest, React Testing Library and V8 coverage: 90% of changed lines.
- Consequences:
  - `design-system/mergelane/MASTER.md` and `pages/dashboard.md` were rewritten for the new design in M3.1's first
    pull request, with the owner's OK (2026-11-11).
  - The owner's later changes to the design (so far, Dusk's light sidebar card, for contrast) are listed in
    `design-system/mergelane/redesign/README.md`.
  - Many Playwright specs change with the layout.
  - Seven themes in two modes make 14 colour sets to check on every screen.

## ADR-0035: Mergelane's own CPU and memory are read by the app, not reported by the helper

- Status: Accepted (2026-11-11), in M3.1 pull request 6b. It replaces `docs/PHASE-3.md`'s plan that the helper
  report its usage in a new optional status field.
- Context: the Dashboard's "Mergelane on this Mac" shows the CPU and memory of the app, the helper, and the
  download tools (yt-dlp, FFmpeg, Deno), as Activity Monitor counts them (100% is one core). Go can read its own
  CPU time, but its current resident memory on macOS needs Mach calls through cgo; `getrusage` gives only the peak.
- Decision:
  - The app's processes come from Electron's `app.getAppMetrics()`. CPU is the change in
    `cpu.cumulativeCPUUsage` (CPU seconds since the process started) over the time between readings;
    memory is `memory.workingSetSize`, in kilobytes (electronjs.org ProcessMetric, CPUUsage and MemoryInfo
    docs, read 2026-11-11).
  - The helper and the tools come from one unprivileged `/bin/ps -A -o pid=,ppid=,%cpu=,rss=,comm=` call. `ps`
    reports a root process's CPU and memory to any user. The helper is found by its executable name. The tools
    are the main process's descendants that aren't Electron's own (by pid), nor `ps` itself, nor the crash reporter.
  - Read once a second, only while the Dashboard shows.
- Consequences:
  - The helper and its protocol don't change. There are no new fixtures or contract tests, and no admin test run
    for this pull request.
  - Every part is measured the same way, so the totals add up as Activity Monitor would show them.
  - `ps` %CPU is a short decaying average, so a short burst shows a little later than in the app's own figure.

## ADR-0036: Updates are checked on GitHub, downloaded, verified, and opened for the user (replaces ADR-0010)

- Status: Owner (2026-11-11), for M3.2. The owner chose "download, verify, open the DMG" over an in-app swap and
  over check-only.
- Context:
  - The design's Settings › Updates downloads the DMG, checks its SHA-256, swaps the app and restarts.
  - Mergelane is ad-hoc signed (ADR-0003). Whether macOS accepts an app that replaced itself is unproven
    (ADR-0010), and a failed swap could leave a broken app.
  - CLAUDE.md allows update checks only against the public GitHub Releases API.
- Decision:
  - **Check.** The main process asks `GET /repos/ZahidNoor7/mergelane/releases` (Electron's `net.fetch`, which uses
    Chromium's network stack and the Mac's proxy settings). The request sends no token, the `Accept:
    application/vnd.github+json` header, `X-GitHub-Api-Version: 2026-03-10`, and a `User-Agent` of
    `Mergelane/<version>`.
    - Sources: docs.github.com, "REST API endpoints for releases", "API versions" and "Rate limits", read on
      2026-11-11.
    - Drafts are never listed without push access. The Stable channel skips prereleases; Beta takes them too. The
      newest version by semantic versioning wins, if it is newer than the running app and wasn't skipped.
  - **When.** On request, and once a day while the app runs, if automatic checks are on (the default). Requests
    without a token get 60 an hour per IP address, so a daily check never comes close. A 403 or 429 is shown as
    "try again later".
  - **Install (M3.2b).**
    1. Download the release's `Mergelane-<version>-arm64.dmg`, with progress.
    2. Check its SHA-256 against the release's own `SHA256SUMS`. GitHub's asset `digest` may be null, so it is
       not relied on.
    3. Open the DMG with `shell.openPath` and quit, so the user drags the new version over the old one.
    - Mergelane never replaces its own bundle, and it never needs an administrator password.
  - `electron-updater` is removed. electron-builder's `publish` block stays, because the release script reads the
    repository from it.
- Consequences:
  - An update takes one drag, and macOS may ask for "Open Anyway" once per new version.
  - A future Developer ID build can switch to an in-app install without changing how updates are checked.
  - The SHA-256 comes from the same release as the disk image. It catches a broken or tampered download on the
    way, but not a release replaced by someone who controls the GitHub account. A Developer ID signature would
    close that gap.
  - The disk image is kept in `<userData>/updates` and emptied at every launch. A test run writes the path it
    would open to a file (`MERGELANE_E2E_UPDATE_OPEN_LOG`) instead of opening anything or quitting.
  - The check sends GitHub the Mac's IP address and the `User-Agent`, and nothing else.

## ADR-0037: The menu bar, Open at login and download notifications (M3.3)

- Status: Owner (2026-11-11). For Open at login, the owner chose "try it, and show macOS's real status" over leaving
  it out until a Developer ID exists, and over a manual-only row.
- Context:
  - The design's Settings › General › "On this Mac" has three switches: Open at login, the merged speed in the menu
    bar, and a notification when a download finishes.
  - Electron's `app.setLoginItemSettings` uses Apple's `SMAppService` on macOS: by default `mainAppService`, the app
    itself, not a daemon. Electron's docs (v44.4.4, `docs/api/app.md`) warn: "your app should be code signed and
    notarized for login item settings to work reliably… `openAtLogin` may silently fail to take effect."
    Mergelane is ad-hoc signed.
  - Electron's Notification docs: macOS notifications use the UNNotification API, which "requires an application
    to be code-signed"; an unsigned app gets a `failed` event.
- Decision:
  - **Open at login:**
    - It is off by default. Apple asks that an app not open at login without the user's consent, so the design's
      default (on) is not followed here.
    - Turning it on calls `app.setLoginItemSettings({ openAtLogin })` with the default `mainAppService`.
    - Settings then shows the `status` that `app.getLoginItemSettings()` reports: `enabled`, `requires-approval`
      or `not-registered`. When macOS didn't take it, the row says how to add Mergelane in System Settings ›
      General › Login Items.
    - Only a packaged app registers itself. A development or test build never does.
    - Opened at login (`wasOpenedAtLogin`), the app starts without its window, in the menu bar and the Dock.
  - **Menu bar:**
    - On macOS, an Electron `Tray` with the template icon (`resources/trayTemplate.png`, `@2x`). macOS colours it
      for a light or dark menu bar.
    - While bytes move, its title is the merged speed (`setTitle`, `monospacedDigit`), in the units the window
      uses.
    - On by default; turning it off removes the item. The menu: Open Mergelane, then Quit Mergelane.
  - **Notifications:**
    - When a download finishes and Mergelane isn't the app in front, it posts "Download finished" with the file's
      name. Clicking it shows that download.
    - On by default. A `failed` event is logged; macOS's own notification settings govern the rest.
  - In a test run, none of the three reaches macOS: what would be shown or registered is kept in memory for the
    tests to read.
- Consequences:
  - Whether ad-hoc signing is enough for `SMAppService` and UNNotification is only known on a real install. The
    Settings row reports what macOS says rather than assuming.
  - Developer ID signing and notarization (Later) should make all three reliable without code changes.

## ADR-0038: Browser extensions: loaded by hand, documented browsers only (M3.4)

- Status: Owner (2026-11-11). The owner chose a guided manual install over a Chrome Web Store listing (a US$5
  developer account, a paid service CLAUDE.md rules out without approval), and Safari as its own later milestone.
- Context:
  - The design's Settings › Browser extensions installs, updates, turns on and uninstalls the extension in each
    browser. On macOS, Chrome-family browsers only install an extension by themselves from their store; otherwise
    the user loads it through Developer mode's "Load unpacked". Release Firefox keeps an unsigned add-on only until
    it quits.
  - Native messaging folders are documented by Google (Chrome, Chromium), Microsoft (Edge, Stable channel:
    `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts`) and Mozilla (Firefox). Brave and Vivaldi
    document none: community reports conflict (Brave reportedly reads Chrome's folder). Arc's maker says Arc stops
    working on 22 December 2026.
- Decision:
  - **Packaging:** the extension is built (`npm run build:extension`) before packaging and ships inside the app,
    in `Contents/Resources/browser-extension/{chrome,firefox}`. The packaging test checks it is there.
  - **Copying:** Mergelane copies the extension to `<userData>/Browser Extension/<kind>` whenever its version
    changes. That folder is the one the user loads, so the path stays the same across app updates.
  - **Settings › Browser extensions:**
    - it finds Chrome, Edge, Chromium and Firefox in `/Applications` and `~/Applications`;
    - each found browser gets an Install… guide: show the folder in the Finder, the browser's extensions page (to
      copy), Developer mode, and Load unpacked (or Firefox's temporary add-on).
    - Brave and Vivaldi show as "not supported yet", with the reason; Safari shows as coming later.
    - It says whether any browser's extension has reached Mergelane (`browserExtensionUsed`).
  - **Registration:** Edge is added to the helper registration, next to Chrome, Chromium and Firefox.
  - The design's Update, Uninstall and on/off switches are left out: Mergelane can't do them to a browser, and the
    guide says what to do instead.
- Consequences:
  - Each browser needs one manual load, and Firefox needs one per restart until the add-on is signed by Mozilla
    (free, but needs a Mozilla account: the owner's decision).
  - Next (M3.4b): which browser connected (the helper reports its parent browser), and the capture rules set once
    in the app for every browser.

## ADR-0039: One set of capture rules in the app, and which browser connected (M3.4b; bridge protocol v3)

- Status: Owner (2026-11-11). The owner chose the design's default rules, plus files of unknown type.
- Context:
  - The design's Settings › Browser extensions › "What the extension does" sets the rules for every browser:
    send downloads or not, a minimum size, the file types, and the video list.
  - Before this, each browser's extension kept its own settings (send on or off, an optional minimum size,
    excluded sites), and the app couldn't tell which browser had connected.
- Decision:
  - **Rules (`shared/captureRules.ts`, saved as `captureRules`):**
    - defaults are the design's: over 1 MB; video, archives, disk images and apps;
    - files of a type Mergelane doesn't know are always taken (`.bin`, no extension);
    - torrents, news files, magnet links and YouTube links aren't sorted by type;
    - images aren't offered as a type, so they stay with the browser.
  - **The app enforces them** in the bridge's `add`. Every download is checked against the rules whatever the
    extension's version, and a download that doesn't qualify answers `kept`, so the browser keeps it.
  - **The extension's part:** the reply to `ping` and `wake` carries `rules: { capture, videoButton }`. The
    extension stores them, greys its icon when sending is off, and lists a page's videos only when allowed. Its
    own pause switch and excluded sites stay per browser.
  - **Which browser:**
    - mergelane-nmhost reads its parent process's executable (`/bin/ps -o comm= -p <ppid>`, no privileges) and
      sends it as `browser` on each request line. Protocol v3; the field is left out when it can't be read.
    - The extension sends its version as `extension` on `ping` and `wake`.
    - The app maps the path to a browser by its app bundle name and saves `browserContacts` (when and which
      version), at most once an hour per browser unless something changed.
    - Settings shows "Reached Mergelane 5 min ago, extension 1.0.0", or "Restart Edge to use 1.0.0" when the
      loaded copy is older than the one Mergelane ships.
  - The design's row "Show a Download button on video pages" says what the extension really does: "List the
    videos on a page" (its menu, and the count on its icon).
- Consequences:
  - **Fewer files sent by default:** documents, images, audio and files under 1 MB now stay with the browser. All
    of it can be changed in Settings.
  - **Upgrading:** an extension built for protocol v2 shows "Update Mergelane" against a v3 app until its browser
    restarts with the copy Mergelane keeps up to date.

## ADR-0040: Routing Mergelane's downloads to one network (M3.5a)

- Status: Accepted (2026-11-11), from the final design's RoutingPanel. M3.5 is split: downloads now (M3.5a); uploads
  and upload limits next (M3.5b), since torrent uploads follow each peer's network and nothing limits them yet.
- Context:
  - The design's Networks › "Which network carries what" sends every download over one chosen network, or over
    all of them, and asks what to do when the chosen one drops.
  - Before this, a download used the networks it was started on (and switched by hand). Nothing moved downloads
    between networks, and nothing stood in for a network that dropped.
- Decision:
  - **The setting:** `routing: { down: 'all' | <network id>, fallback }`, saved in app settings.
  - **The engine (`DownloadManager.reconcile`):**
    - while `down` names a connected network, every download wants only that one, the running ones included;
    - the others get a new network status, `routed`;
    - each download's own choice (`enabled`) is untouched, and comes back when routing returns to all networks.
  - **When the chosen network isn't connected:** with `fallback` on, each download uses its own networks; with it
    off, every network is `routed` and downloads wait.
  - **All transfers follow it:** HTTP, HLS/DASH and YouTube, Usenet and torrents, because each uses only the
    networks whose status is `on`.
- Consequences:
  - Routing applies at once to running downloads (`limitsChanged` re-reconciles them).
  - A download's details show "Not used: downloads go over another network" on the set-aside networks.

## ADR-0042: Diagnostics bundle, and Today's dropouts and fastest speed kept across restarts (M3.7)

- Status: Accepted (2026-11-11). What may go into the bundle beyond CLAUDE.md's list is the owner's call; the
  choices below are the most private reading of that list, and can be loosened later.
- Context:
  - CLAUDE.md asks for a diagnostics bundle in Phase 3, made on request and never sent anywhere.
  - The final design's Dashboard "Today" shows the fastest merged speed and the network dropouts of the last 24
    hours, and Networks lists recent dropouts. Both lived only in the window's memory, so a restart emptied them.
    The app showed "Fastest download" (one download's peak) instead of the merged speed.
  - Finished downloads (history.json) and unfinished ones (their saved block progress, per network) already
    survive a restart, so Today's totals per network did too. Only the events and the merged peak were lost.
- Decision:
  - **Network activity moves to the main process** (`main/networkActivity.ts`, logic in
    `shared/networkActivity.ts`):
    - It is logged from `NetworkMonitor`'s lists, so it is kept even while the window is closed.
    - It is saved to `userData/network-activity.json`: at most 50 events and none older than a week.
    - At launch, a network whose last event is a drop and that is connected again is logged as "came back while
      Mergelane was closed". How long it was out isn't known, so no duration is shown.
    - A network that was there at the last quit and is missing now logs nothing: it may have been unplugged on
      purpose.
  - **The fastest merged speed** is the most `DownloadManager.totalSpeed()` held over 5 one-second samples (as a
    download's own peak needs 5 seconds), kept per local calendar day. It is saved at most every 2 seconds.
    Today shows the higher of it and the best single download's peak.
  - **The window receives the activity** over `networkActivity` / `networkActivityChanged`. The Dashboard counts
    the dropouts of the last 24 hours, as the design does.
  - **The diagnostics bundle:**
    - **Where:** Settings › General › Troubleshooting › Diagnostics (the design has no place for it), and the app
      menu's "Save Diagnostics…", which opens that row and saves from there.
    - **Saving:** Electron's `dialog.showSaveDialog`, defaulting to `Downloads/Mergelane-Diagnostics-<date>.zip`.
      The files are written to a temporary folder, zipped with `/usr/bin/ditto -c -k --norsrc --keepParent`, and
      copied to the chosen path. The temporary folder is always removed. Nothing is uploaded.
    - **Contents:**
      - `README.txt`: what is in it, and what was removed.
      - `diagnostics.json`: the app, Electron, Chrome and Node versions; Rosetta or not; macOS version, kernel,
        architecture, processor and memory; the helper's snapshot (read only, through the existing client);
        each network's id, kind and macOS name, with addresses only as family and scope; the network activity;
        the settings that change how downloads run; Usenet without host or user; unfinished downloads and the
        last 50 finished ones.
      - `helper-log.txt`: the last 200 lines of `/Library/Logs/Mergelane/daemon.log`, if it can be read.
    - **Redaction:**
      - Fields are picked from an allowlist, so a field added later stays out until someone decides it may go in.
      - Links keep only their scheme and host; magnet links become `magnet:…`.
      - File names keep only their extension. Destination folders are described ("a folder in the home folder"),
        not named.
      - Left out entirely: proxy hosts, user names and passwords; Usenet host and user; custom network names
        (only whether a network was renamed); MAC addresses; IP addresses; cookies and browser sign-ins.
      - Free text (errors, the helper's reasons, log lines) loses links, emails, paths in the home folder or on
        other disks, the account name and public IP addresses.
      - Every string then passes a second net, `redactIdentity`.
- Consequences:
  - Old events stay visible after a restart for up to a week, so the empty text now says "No network has dropped
    in the last week".
  - The bundle shows sites (hosts) of downloads and the processor model. The owner may want even less (hosts
    hashed, say) or more (full settings).
  - The bundle is macOS-only (`ditto`), like the app.
