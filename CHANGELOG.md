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

- YouTube downloads, through yt-dlp only: paste a YouTube link, or use the extension's "Send this video to
  Mergelane" on a YouTube page. No cookies or sign-in; protected (DRM) videos, playlists, channels and live
  streams are refused. Each network fetches its own share.
- Deno ships inside the app as yt-dlp's JavaScript runtime.
- Every release attaches the source code of yt-dlp and FFmpeg, and the script that builds FFmpeg.

- System merge, for daily use:
  - an optional "Turn back on after a crash" setting, off by default;
  - networks that come back after unplugging, sleep or a reconnected phone are checked again from scratch, and
    their routes are re-synced;
  - the helper keeps a history of the last 50 network changes, shown in the app;
  - new helper commands: `events` and `auto-resume on|off`.

- Running every check on the owner's Mac instead of GitHub (ADR-0032):
  - `scripts/ci/local.sh` runs the checks that need no administrator rights, read from `ci.yml`;
  - `scripts/ci/local-root.sh` runs the network tests with the owner's password, pausing and restoring the
    installed helper;
  - `scripts/release/local-release.mjs` builds a release locally and uploads it only as a draft.
- New network tests: IPv6 traffic through the simulated links, and a link that drops and comes back.
- The notices of the third-party code built into Deno ship inside the app.

### Changed

- `mergelane-daemon --probe-targets` sorts IPv4 and IPv6 targets by family; before, an IPv6 target failed every
  IPv4 probe.
- FFmpeg is now Mergelane's own minimal build from FFmpeg's official source: LGPL instead of GPL, and 4.1 MB
  instead of 66 MB. It only joins and rewraps media; it never re-encodes.
- yt-dlp ships as its unpacked macOS build, which starts in a quarter of a second instead of about 24 seconds.
- The browser extension no longer uses a local HTTP port; the old bridge on `127.0.0.1:19288–19290` is gone.

- Automatic updates are off until updates can be checked through the GitHub Releases API (ADR-0010).

### Removed

- The Telegram download source from Plexo. It needed the user's own Telegram API keys and a sign-in. Telegram
  downloads saved by an older build are dropped; finished files are kept.
