You are starting a new project, Mergelane, in this repository. Read `CLAUDE.md` first and follow it
throughout. It holds the hard constraints, architecture, testing rules and roadmap.

Your task in this session is **Phase 1: the proof of concept and project foundation**. Do not start
Phase 2 features.

## Step 0: Plan before coding

1. Clone the three upstream repos (Plexo, Net Merge, Awesome Downloader) into a temporary folder
   **outside** this repo, and read the current code paths named in `CLAUDE.md`.
2. Write `docs/PHASE-1.md` with the plan, the milestones below, acceptance criteria, risks and the
   order of work. Write `docs/UPSTREAM.md` with the commit SHAs you will import.
3. Show me the plan and the list of commands that will need `sudo` or will change my Mac's networking.
   **Wait for my approval before continuing.**

## Milestones

**M1.1: Repository foundation**
- Monorepo layout: `app/` (from Plexo), `daemon/` (Go, from Net Merge), `extension/`, `shared/`,
  `scripts/`, `docs/`, `.github/workflows/`.
- Licence files: MIT for Mergelane, with all upstream copyright notices kept. Add `THIRD-PARTY-NOTICES.md`,
  `README.md` (with honest limits and the install steps below), `CHANGELOG.md`, `docs/PROGRESS.md`,
  `docs/DECISIONS.md`.
- CI on GitHub Actions `macos` arm64 runners: lint, typecheck, unit tests, Go tests, e2e, packaging.

**M1.2: Rebranded app that installs from a DMG**
- Import Plexo into `app/`, rename it to Mergelane (app id `io.github.<owner>.mergelane`), and remove the
  Windows and Linux targets and x64 builds.
- Build an arm64 DMG and zip, ad-hoc signed including every nested binary, with no Developer ID needed.
- The packaging CI test must pass: mount the DMG, copy the app, add quarantine, verify the signature,
  launch, reach the ready state.
- In the README and on the release page, document how to install: drag to Applications, try to open it,
  then System Settings › Privacy & Security › Open Anyway; or run
  `xattr -dr com.apple.quarantine /Applications/Mergelane.app`.

**M1.3: `mergelane-daemon`**
- Port Net Merge's engine into `daemon/`, macOS only. Replace the sudoers approach with a launchd
  LaunchDaemon that the app installs once via an admin-password prompt. Also provide uninstall
  and `cleanup` commands.
- Versioned JSON control API over a Unix socket, with peer-uid checks: `status`, `enable`, `disable`,
  `links`, `stats`, `setLimit`.
- **VPN guard:** detect an active third-party VPN or tunnel (other `utun`/`ipsec`/`ppp` interfaces that
  carry default or /1 routes, and `scutil --nc` state). Refuse to enable while one is active, and disable
  with a clear reason if one appears.
- All existing Net Merge tests are ported and pass, plus new tests for the VPN guard and the socket API.

**M1.4: Downloader pinning under system merge**
- Change the download engine on macOS to pin per-link sockets with `IP_BOUND_IF`/`IPV6_BOUND_IF`.
- Show in the app a minimal "System merge" toggle and live per-link stats from the daemon. No other
  UI redesign yet.

**M1.5: Simulated-network e2e harness**
- Scripts that create two or three fake links with different speeds, delays and loss (`feth` and/or
  `lo0` aliases plus dummynet), and tear them down reliably even after a failure.
- Each test runs in a clean network state. A test failure must not leave routes or pipes behind.

## Phase 1 acceptance criteria (all must be shown passing in CI)

1. The DMG installs and launches on a clean macOS arm64 runner with quarantine set.
2. With two simulated links (for example 20 and 50 Mbit/s), one large file downloaded by the app uses
   both links, and its throughput is above the faster link alone.
3. With system merge on, many parallel flows from an external client (for example several `curl`
   processes) are spread across both links. With it off, routing is unchanged.
4. Killing the daemon with `kill -9` leaves no Mergelane routes, and connectivity is intact.
5. With a simulated VPN route present, enabling merge is refused with a clear message, and the VPN's
   routes are untouched.
6. Dropping one link mid-download: the download completes over the other link, and new system flows
   avoid the dead link within 5 seconds.

When done, update `docs/PROGRESS.md`, open a PR with test evidence, and give me a short summary:
what works, what failed or was descoped, the risks found, and the proposed Phase 2 plan. Then stop
and wait for my approval.
