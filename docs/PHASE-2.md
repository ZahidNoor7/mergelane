# Phase 2: MVP (proposal)

Status: **approved and started 2026-11-10.**
- **Done:** M2.1 (PR #5), M2.2 (PR #6), M2.3 (PR #7), M2.4 (PR #8; IPv6 capture in the simulator still open), and
  M2.2's YouTube part (branch `m2.2-youtube`).
- **Owner choices:**
  - native messaging;
  - YouTube reviewed before any code;
  - CI paused;
  - the stale branch kept.

Goal, from CLAUDE.md: one installable app with downloads, torrents, Chrome capture, YouTube, system merge on/off,
failover and a dashboard.

Exit criteria, from CLAUDE.md: the DMG installs and works on a clean Mac, and the full CI suite is green. CI is
paused today (ADR-0020), so Phase 2 cannot finish until the owner turns it back on.

## Milestones, in order

### M2.0 Close Phase 1's gaps

- Resume CI, when the owner says so. Prove Phase 1 criteria 1, 2 and the app part of 6.
- Make simulated links work again after `ifconfig down` and `up` (ADR-0015).
- Split the daemon's `run` into testable parts, so its coverage reaches 90%.
- Delete the stale `m1.4-pinning` branch (owner's OK).

### M2.1 Browser capture (Chrome)

- **Decision first (ADR):** keep Plexo's local HTTP bridge, or move to Chrome native messaging as CLAUDE.md's
  architecture says.
  - Native messaging installs a per-user host manifest, needs no admin rights, and gives a stronger caller
    identity.
- Move the extension to a top-level `extension/` with its own build (ADR-0014).
- Playwright tests for the extension: capture a download, hand it to the app, confirm.

### M2.2 Video: HLS, DASH and YouTube

- **A legal and terms-of-service review first.** Awesome Downloader's YouTube path replays a token YouTube's own
  player issues. CLAUDE.md forbids DRM circumvention and anything beyond what the user's own browser session
  provides. The owner approves the approach before any code.
- yt-dlp and FFmpeg:
  - fetched at build time with pinned SHA-256 checksums, never committed;
  - shipped as separate executables in the bundle, with their licences (GPL source offer for FFmpeg).
- HLS and DASH downloading with FFmpeg muxing, using Awesome Downloader's logic, rewritten for macOS.
- Tests:
  - recorded YouTube fixtures in CI;
  - a nightly live smoke test that opens an issue when it fails (needs CI on).

### M2.3 Dashboard and network screens

- A real dashboard: active downloads and per-link speed.
- System merge status, with per-link charts, failover state and the honest limits shown in the UI.
- Built with the mandatory design skills, and a design system set at the start.

### M2.4 System merge, robust enough for daily use

- Optional "turn merging back on after a crash" setting, off by default (ADR-0007).
- Links that come back after unplug, sleep and wake: routes re-synced, and failover visible in the UI.
- Helper updates: when the app is newer than the installed helper, offer to update it, and check protocol
  versions on both sides.
- IPv6 capture tested in the simulator.

### M2.5 Releases

- A GitHub release workflow, run by hand (CI is paused; `docs/RELEASING.md`):
  - an ad-hoc-signed DMG and zip;
  - release notes with the install steps;
  - the packaging test and the REA fuse audit before upload.

## Proposed acceptance criteria

1. The DMG from the release workflow installs and works on a clean runner (packaging test).
2. Chrome capture: a download clicked in Chrome is handed to Mergelane and completes, verified byte for byte.
3. HLS and DASH fixtures download and mux correctly. The YouTube recorded fixtures pass in CI.
4. System merge: on and off from the dashboard. Failover during a download and for system flows passes on the
   simulated network, including a link that comes back.
5. Every Phase 1 criterion still passes. The full CI suite is green.

## Owner answers (2026-11-11)

1. CI stays paused, with no manual runs for now (ADR-0020). Phase 2's exit still needs it.
2. Native messaging (ADR-0021).
3. YouTube: option A, yt-dlp only with hard limits (ADR-0026); Deno ships as a third program.
4. Telegram: remove it, after the YouTube work.
5. Probes: keep the public targets (ADR-0008).
6. FFmpeg: our own minimal LGPL build (ADR-0028). Every release attaches the bundled programs' source (ADR-0027).
7. Chrome Web Store: later, once Phase 2's installer works. Until then the extension is loaded by hand.

## Questions for the owner before starting (as asked)

1. When should CI come back on? Phase 2's exit needs it.
2. Browser capture: native messaging (CLAUDE.md's architecture) or Plexo's HTTP bridge?
3. YouTube: approve a review step before any YouTube code, and say which approach is acceptable.
4. Telegram: keep or remove (Phase 1 Q4)?
5. Link probes: keep `1.1.1.1` / `8.8.8.8`, or probe only gateways (Phase 1 Q3)?
