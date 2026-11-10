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

## ADR-0008: Faster link health checks

- Status: Proposed (2026-11-10). Implemented in M1.3 (`daemon/internal/engine/probe.go`).
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
- Owner question open: whether to probe only the gateway instead (PHASE-1 §4 Q3).

## ADR-0009: Keep Plexo's HTTP browser bridge in Phase 1

- Status: Proposed (2026-11-10)
- Context:
  - CLAUDE.md's architecture names native messaging.
  - Plexo uses local HTTP on `127.0.0.1:19288–19290` with Origin and Host checks and per-offer tokens.
  - Phase 1 has no extension work.
- Decision: Phase 1 rebrands the HTTP bridge only. The move to native messaging is decided at the start of Phase 2.
- Consequences: No bridge rewrite during the proof of concept.

## ADR-0010: Auto-update off in Phase 1

- Status: Proposed (2026-11-10)
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

- Status: Proposed (2026-11-10, revised the same day). Owner question open (PHASE-1 §4 Q4).
- Context:
  - Plexo's Telegram source needs a Telegram account plus API credentials. Plexo injects its own at build
    time; Mergelane has none, so users must enter their own.
  - Removing the feature touches about 25 files, including UI, and widens the diff against upstream
    (ADR-0001).
- Decision: Keep it unchanged in Phase 1. It works only with the user's own Telegram API ID; Mergelane itself
  still has no accounts.
- Consequences: The owner decides before Phase 2 whether it stays.

## ADR-0013: Packaging test launches after the documented quarantine removal

- Status: Proposed (2026-11-10). Owner question open (PHASE-1 §4 Q2). Confirmed by spike S1.
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
