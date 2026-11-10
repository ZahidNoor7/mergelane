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

- Status: Proposed (2026-11-10)
- Context: Upstream marks a silent link down after about 19 s. Phase 1 requires that new flows avoid a dead link
  within 5 s.
- Decision:
  - Up links are probed every 1 s with a 1.5 s timeout and marked down after 2 consecutive failures.
  - A link is also sidelined on connect timeouts and when its interface loses its address or route.
  - Probe targets are configurable. They default to upstream's (`1.1.1.1:443`, `8.8.8.8:443`, TCP connect only,
    no data sent); tests point them at the simulated network.
- Consequences: Slightly more probe traffic: one TCP handshake per link per second.
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

## ADR-0012: Telegram source removed from the app

- Status: Proposed (2026-11-10). Owner question open (PHASE-1 §4 Q4).
- Context: Plexo's Telegram source needs build-time API credentials that are Plexo's secrets, plus a Telegram
  account. CLAUDE.md rules out accounts.
- Decision: Remove the Telegram source, its UI and its tests during the M1.2 rebrand.
- Consequences: Simpler app with no third-party account flow. It can return later with user-supplied API keys
  if the owner wants it.

## ADR-0013: Packaging test launches after the documented quarantine removal

- Status: Proposed (2026-11-10). Owner question open (PHASE-1 §4 Q2). Spike S1 result pending.
- Decision: The packaging test proves that:
  - the signature verifies;
  - Gatekeeper's verdict on the quarantined app is "not notarised", not "damaged";
  - the app reaches its ready state after `xattr -dr com.apple.quarantine`, the documented install step.
- Consequences: The one manual click ("Open Anyway") is not automated.

## ADR-0020: CI paused, runs by hand only

- Status: Owner (2026-11-10)
- Decision: At the owner's request, `.github/workflows/ci.yml` runs only on `workflow_dispatch`. Pushes and pull
  requests trigger nothing until the owner asks to resume (the original triggers are noted in the file).
- Consequences:
  - The kickoff requires the Phase 1 acceptance criteria to be shown passing in CI. While CI is paused, new
    changes are not proven there.
  - Runs that already passed remain the evidence, listed in `docs/PROGRESS.md`.
  - Start a run with `gh workflow run ci.yml --ref <branch>`.
