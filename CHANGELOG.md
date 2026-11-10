# Changelog

All notable changes to Mergelane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project rules (`CLAUDE.md`), Phase 1 plan (`docs/PHASE-1.md`) and pinned upstream commits (`docs/UPSTREAM.md`).
- Repository foundation: MIT licence with upstream notices, `THIRD-PARTY-NOTICES.md`, README with honest limits and
  install steps, progress and decision logs, and a CI workflow with repository checks.
- The Mergelane app, from Plexo 1.0.0-rc.15 (commit `2e44a2f`):
  - rebranded, and built only as an arm64 DMG and zip for macOS 27 or later, ad-hoc signed;
  - Electron fuses hardened;
  - a `GET /health` readiness endpoint on the local bridge.
- CI jobs for the app: lint, typecheck and format; Playwright smoke tests on macOS; a packaging test that
  installs the DMG like a user and waits for the ready state; an REA audit of the Electron fuses.

- `mergelane-daemon`, from Net Merge 0.3.7, macOS only:
  - a root LaunchDaemon with a versioned control API over a Unix socket, checking each caller's uid;
  - a VPN guard that refuses to merge alongside another VPN and turns merging off when one appears;
  - marked routes, so cleanup touches only Mergelane's own;
  - dead links detected within 5 s.
- Downloads pin each network's connections with `IP_BOUND_IF`, so they stay on their link while system merging
  is on.
- A System merge switch with live per-link traffic in the networks menu; the app installs the helper once with
  an administrator password.
- A simulated-network test harness, plus acceptance tests for Phase 1's criteria.

- Browser capture through Chrome's native messaging (`mergelane-nmhost`): the extension hands downloads to the app over
  a private channel. Mergelane registers the host with Chrome, Chromium and Firefox when it starts.

- Video downloads from HLS (`.m3u8`) and DASH (`.mpd`) links, with a quality picker. They are fetched over every
  selected network, then joined into MP4 or MKV by FFmpeg. Live and protected (DRM) streams are refused.
- The extension lists the videos a page loads and hands one to Mergelane.
- yt-dlp and FFmpeg ship inside the app, fetched at build time with pinned checksums.
- A release workflow, run by hand.

- System merge, for daily use:
  - an optional "Turn back on after a crash" setting, off by default;
  - networks that come back after unplugging, sleep or a reconnected phone are checked again from scratch, and
    their routes are re-synced;
  - the helper keeps a history of the last 50 network changes, shown in the app;
  - new helper commands: `events` and `auto-resume on|off`.

### Changed

- The browser extension no longer uses a local HTTP port; the old bridge on `127.0.0.1:19288–19290` is gone.

- Automatic updates are off until updates can be checked through the GitHub Releases API (ADR-0010).
