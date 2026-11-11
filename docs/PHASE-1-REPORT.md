# Phase 1 report

Date: 2026-11-10. Status: **Phase 1 work complete; three acceptance checks not yet proven in CI (owner's choice,
see below).** Waiting for the owner's approval before Phase 2.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | The DMG installs and launches on a clean macOS arm64 runner with quarantine set | Passed for PR #2's app. **Not re-proven** for PR #4's app, which bundles the helper | PR #2 CI run 42841370218, job `package` |
| 2 | One large file downloaded by the app uses both links, faster than the faster link alone | **Not proven** | Spec written (`app/e2e/netsimDownload.spec.ts`). First CI run failed at the app's URL probe because of a test-harness gap, fixed in `d922698` but not re-run |
| 3 | System merge spreads many external flows across both links; off leaves routing unchanged | **Passed** | PR #3 CI run 42847228218, job `daemon-acceptance`: 16 downloads split 8 + 8, routing table restored |
| 4 | `kill -9` of the daemon leaves no Mergelane routes; connectivity intact | **Passed** | Same run: capture routes gone at once, marked rest removed by cleanup, routing table back to start, internet works |
| 5 | With a VPN present, enabling is refused clearly and the VPN's routes are untouched | **Passed** | Same run: `VPN_ACTIVE` naming the VPN; also turns itself off when a VPN appears, VPN routes intact |
| 6 | A link dropping mid-download: the download completes; new system flows avoid the dead link within 5 s | **Half passed.** The system part passed; the app's download part is not proven | Same run: link marked down after 4 s, 8/8 new flows over the live link. App part: spec written, not run |

Why 1, 2 and the app part of 6 are open: the owner paused CI (ADR-0020) while those jobs were running, and chose on
2026-11-10 to record them as unproven rather than start one manual run. One run would settle them:
`gh workflow run ci.yml --ref m1.4-system-merge`.

## What works

- **Repository:**
  - Monorepo with the MIT licence and upstream notices.
  - The README states the honest limits and the install steps.
  - Decision log: ADR-0001 to ADR-0020.
- **App (from Plexo):**
  - Rebranded, macOS 27+ arm64 only.
  - Ad-hoc-signed DMG; hardened Electron fuses, audited by REA in CI.
  - Auto-update off.
  - The full local smoke suite passes: 171 tests.
- **Downloader pinning:** every per-link socket is pinned with `IP_BOUND_IF` / `IPV6_BOUND_IF`. The kernel's
  enforcement is checked by tests.
- **Daemon (from Net Merge):**
  - A root LaunchDaemon with a versioned socket API that checks each caller's uid.
  - A VPN guard, marked routes and crash-safe cleanup.
  - Dead links are detected within 5 s.
  - launchd install, restart and uninstall.
  - Unit coverage 95–100% on the new packages.
- **System merge in the app:** a switch, the reason or error, per-link traffic, and a one-time admin-prompt
  install.
- **Simulated network:**
  - Shaped fake links, a test server, and leak detection that fails a run if anything is left behind.
  - Proven on the macOS 27 runner.
- **Owner's Mac:** the latest build is installed in `/Applications`; the helper is not yet installed.

## What failed, or was descoped

- **Links coming back:** after `ifconfig down` and `up`, the simulated link doesn't carry traffic again
  (ADR-0015). Not a Phase 1 criterion; moved to Phase 2.
- **Quarantined launch:** CI can't click "Open Anyway". The packaging test proves launch after the README's
  `xattr -dr` step instead (ADR-0013).
- **Coverage of the daemon's `run` command:** unit tests cover everything except `run`. The root acceptance run
  measured 38.7% of that package. Raising it needs `run` split into testable parts.
- **Extension stays inside `app/`:** the kickoff's top-level `extension/` was deferred to Phase 2 (ADR-0014).
- **Telegram:** kept, not removed (ADR-0012).

## Risks found

- **`feth` is undocumented by Apple.** The whole simulated network depends on it.
- **The helper won't run inside a still-quarantined app** (exit 137). The in-app install works only after the
  user approves the app (ADR-0019). Not yet confirmed on real hardware.
- **System merge has never run on real hardware.** The owner's Mac would be the first.
- **The VPN guard is route-based.** A VPN that installs only a scoped default is invisible to it unless
  `scutil` lists the VPN (ADR-0018).
- **Probe traffic:** about one TCP handshake per link every 2 s to `1.1.1.1` / `8.8.8.8` (owner question Q3).
- **`ELECTRON_RUN_AS_NODE`:** a shell that has it set (VS Code's terminal can) breaks local e2e runs. Unset it
  before running the suite.

## Pull requests (stacked; merge in order)

1. **#1** M1.1 foundation
2. **#2** M1.2 app and DMG
3. **#3** M1.3 daemon and M1.5 simulated network
4. **#4** M1.4 pinning and the System merge toggle, plus this report and the Phase 2 proposal

The `m1.4-pinning` branch on GitHub is stale (replaced by `m1.4-system-merge`) and can be deleted with the owner's
OK.
