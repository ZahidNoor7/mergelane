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

### Changed

- Automatic updates are off until updates can be checked through the GitHub Releases API (ADR-0010).
