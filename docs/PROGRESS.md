# Progress

Updated at the end of every working session.

## Phase 1: proof of concept and foundation

Last updated: 2026-11-11

### Done

- **Step 0:** plan (`docs/PHASE-1.md`) and pinned upstream commits (`docs/UPSTREAM.md`). Repository public
  (ADR-0011).
- **Tooling, owner-approved:** Go 1.27.3, staticcheck 2026.2.2, and the REA plugin (`rea@rea`, local scope).
- **Spike S1:** two CI runs on `xcode-27`, macOS 27.0.1. Findings in ADR-0013, ADR-0015 and ADR-0017.
- **M1.1 foundation:** PR #1. CI green.
- **M1.2 app:** PR #2. CI green (run 42841370218):
  - lint, typecheck and format;
  - Playwright smoke on macOS;
  - ad-hoc-signed DMG install test;
  - REA fuse audit.
- **M1.3 daemon + M1.5 netsim:** PR #3. CI green (run 42847228218):
  - `daemon`: vet, staticcheck, `go test -race`;
  - `netsim`: harness self-test, plus proof that a leaked route fails the run;
  - `daemon-acceptance`, all 32 checks passed, as root on simulated 20 and 50 Mbit/s links:
    - **criterion 3:** 16 unpinned downloads split 8 + 8 over the links; capture routes marked `RTF_PROTO2`;
      off restores the routing table;
    - **criterion 4:** `kill -9` leaves no capture routes; cleanup removes the marked rest; routing table back
      to the start; internet works;
    - **criterion 5:** enable refused with `VPN_ACTIVE` naming the fake VPN, whose routes stay untouched; a VPN
      taking over while on turns merging off, and its routes survive;
    - **criterion 6, system part:** the dead link is marked down after 4 s, and 8/8 new flows finish within
      5 s over the live link;
    - **ADR-0005:** user `nobody` gets `NOT_AUTHORIZED`;
    - **ADR-0017:** launchd install, restart after `kill -9` (pid 5846 → 5892), uninstall, routing unchanged.
- **M1.4 pinning + System merge:** PR #4. Local results, macOS 27.0.1:
  - pinning: 11 tests, `deviceBinding.ts` 98.5% line coverage;
  - daemon client and contract: `client.ts` 99%, `installCommand.ts` 100%;
  - System merge UI e2e: 3 tests;
  - full smoke suite: 171 passed.

### Phase 3 (proposed 2026-11-11)

- Plan: `docs/PHASE-3.md` (PR #16). The owner answered its four questions on 2026-11-11; it waits for approval.
- ADR-0034: the owner's redesign is M3.1, released as 0.2.0. All seven themes ship; the app opens on Downloads;
  Auto appearance comes back.
- The final design is copied into `design-system/mergelane/redesign/`.
- **Plan approved 2026-11-11 (PR #16).**
- **M3.1, pull request 0** (branch `m3.1-vitest`): Vitest for renderer unit tests.
  - Vitest 5.1, React Testing Library, jsdom and V8 coverage.
  - Every file listed in `vitest.config.ts`'s `COVERED` must keep 90% of its lines covered, or the run fails.
  - Runs in `app-checks`.

### Phase 2 (started 2026-11-10, owner-approved)

**M2.1 browser capture: done, PR #5** (branch `m2.1-browser-capture`). Native messaging, ADR-0021.
- **Host:** `mergelane-nmhost`, 98.7% coverage.
- **App:** the 0600 Unix socket bridge, with host manifests for Chrome, Chromium and Firefox.
- **Extension:** talks through `sendNativeMessage`, with a fixed ID.
- **Proven locally, end to end in Chromium** (`e2e/extension.spec.ts`):
  - the fixed extension ID;
  - extension → host → app;
  - a clicked download handed over and the browser's copy cancelled.
- **Smoke suite:** 180 passed.
- **Not done:**
  - Firefox is registered but not tested end to end.
  - Moving the extension to a top-level `extension/` was deferred again: no benefit yet, and it would duplicate
    the toolchain (ADR-0014).
  - Publishing the extension needs a Chrome Web Store developer account, which has a one-time fee: owner decision.

**M2.2 video: in progress** (branch `m2.2-media`).
- **Done:**
  - YouTube options review (`docs/YOUTUBE-REVIEW.md`), waiting for the owner's choice;
  - HLS module: 56 tests, 98–100% coverage;
  - DASH module: 49 tests, 100% coverage;
  - yt-dlp and FFmpeg fetch with pinned checksums (ADR-0022, `docs/MEDIA-TOOLS.md`): 29 tests, 98.6% coverage.
- **Also done:**
  - HLS and DASH links download for real: a quality picker, segments over the selected networks, pause and resume
    (also across a relaunch), then muxed by FFmpeg;
  - the extension lists the videos a page loads (ADR-0023; YouTube hosts excluded for now);
  - a manual release workflow (`docs/RELEASING.md`).
- **Local test result:** full smoke suite, 360 passed.
- **Incident, resolved:** an early version of a stream UI test saved 12 test videos into the owner's
  `~/Downloads`. They were deleted by name, the test now uses its own folder, and the folder was checked
  afterwards.
- **Also done:**
  - FFmpeg muxing: 35 tests, 100% line coverage;
  - the daemon's `run` made testable (M2.0): 92.5% coverage.
- **Owner questions:**
  - which YouTube approach (it also decides whether to ship Deno);
  - whether the FFmpeg build source is acceptable;
  - whether to attach GPL sources to releases.

**M2.3 dashboard: done, PR #7** (branch `m2.3-dashboard`).

**M2.4 system merge for daily use: done, pending CI** (branch `m2.4-merge-daily`).
- **Helper:**
  - an optional "Turn back on after a crash" setting, off by default (ADR-0024);
  - links that come back are re-probed from scratch, and their scoped routes re-synced (ADR-0025);
  - a log of the last 50 link changes (`events`);
  - CLI commands `events` and `auto-resume on|off`.
  - Go: vet, staticcheck and `go test -race` pass. New and changed code is 100% covered.
- **App:**
  - an out-of-date helper is detected (version, protocol, or a missing method) and an **Update** button
    reinstalls it;
  - merging that was on before an update is turned back on afterwards;
  - the auto-resume switch;
  - a "Recent network dropouts" list from the helper's event log.
  - Coverage: `snapshot.ts` 100%, `client.ts` 99%. Full smoke suite: 379 passed, 1 skipped (existing).
- **Not proven yet** (needs root in CI, which is paused, or the owner's Mac):
  - a real `kill -9`, launchd restart and auto-resume;
  - how macOS treats the re-synced routes on real interfaces;
  - unplugging, sleep and wake;
  - IPv6 capture in the simulator (still open from the M2.4 plan).

**M2.2 YouTube: done, pending CI** (branch `m2.2-youtube`).
- **YouTube, option A** (ADR-0026, ADR-0030):
  - yt-dlp only, with no cookies or tokens; DRM formats dropped;
  - each network asks for its own addresses through a pinned loopback proxy, then downloads its share;
  - the extension's "Send this video to Mergelane".
- **Deno 2.9.8** ships as yt-dlp's JavaScript runtime (ADR-0029).
- **Our own FFmpeg** (ADR-0028): built from FFmpeg's signed 9.0.2 source, LGPL, stream copy only, 4.1 MB.
- **yt-dlp's unpacked build** (ADR-0031): it starts in 0.25 s instead of about 24 s, after a one-time first start.
- **Sources:** every release attaches the yt-dlp and FFmpeg source, plus our FFmpeg build script (ADR-0027).
- **Tests:**
  - full smoke suite: 428 passed, 1 skipped (existing);
  - script tests: 128 passed;
  - the live YouTube test passed locally (one public test video, temp folder);
  - coverage: YouTube modules 99.4–100%, `fetch.mjs` 99.3%, `sources.mjs` 97.6%, `notes.mjs` 99.5%.
- **Not proven yet** (needs CI or real hardware):
  - two networks with different public IPs;
  - the real `electron-builder` signing of the yt-dlp folder;
  - the FFmpeg build on the CI runner.
- **Open before the first public release:** the notices of the third-party code built into Deno (ADR-0029).

**Finishing Phase 2 on the owner's Mac** (PR #11, merged; ADR-0032, ADR-0033):
- `scripts/ci/local.sh`: all 6 non-root jobs pass.
  - repo-checks: 226 tests;
  - app checks;
  - smoke: 428 passed, 1 skipped;
  - package: build, fuse audit, local package test;
  - daemon: 567 passed, 7 skipped that need root;
  - extension: 16 passed.
- `scripts/ci/local-root.sh`: run by the owner in Terminal. It adds the IPv6 and link-recovery acceptance cases.
  - **First run, 2026-11-11 11:26: no network suite ran.** `go` passed and the netsim unit tests passed (11 + 93).
    The netsim self-test, daemon and app suites all stopped at "the test server did not start".
  - **Cause:** the checkout's path has a space ("Personal Projects"). `scripts/netsim/server.mjs` and
    `scripts/ci/local-root-lib.mjs` compared `import.meta.url` (percent-encoded) with the raw path, so neither ran:
    - the test server exited at once, silently;
    - every check the library makes printed nothing and passed: VPN, address clashes, leftovers, routes, the
      helper's restore, and the summary.
    - CI paths have no space, so CI never showed it.
  - **The Mac was fine afterwards** (checked read-only):
    - the helper's plist and binary have the same SHA-256 as before, and merging is on again;
    - no feth links, netsim addresses or routes, state folders or test processes are left.
    - Not checkable without root: the pf anchor's rules and the dummynet pipes. The next run checks them.
  - **Fixed:**
    - both scripts use the repo's `pathToFileURL(realpathSync(argv[1]))` guard, with regression tests that run them
      from a folder with a space and through a symlink;
    - `with-netsim.sh` compares netsim's pf anchor by its rules, not its name: macOS 27.0.1 kept listing it after
      `netsim.sh down`;
    - the local leak step fails when the leftover route was never added. CI's step already did.
- **The Deno notices** (ADR-0029) are generated and shipped.
- **`local-release.mjs`:** a full dry run built the DMG, zip and sources; nothing was uploaded.
- **Done 2026-11-11:**
  - Root suite, second run: all 11 PASS (PR #11).
  - Merged into `main`, as merge commits:
    - #1–#6 and #8–#11, the tested chain: `main` then equalled the tested commit 91e3815;
    - #12, which keeps the extension test's browser out of `~/Downloads`;
    - #7, the dashboard, after merging `main` into it: one import conflict, and `local.sh` all 6 jobs PASS (smoke 448);
    - #13, the 0.1.0 changelog, rewritten for users;
    - #14, which corrects two README claims also copied into the release notes. "The only network request is the
      update check" was wrong: there is no update check, and the helper probes 1.1.1.1 and 8.8.8.8 on every link.
      "Remove it from Mergelane's settings" was wrong: it is `sudo … uninstall`.
  - **Draft release `v0.1.0`** from 3cd5b3e, built by `local-release.mjs --upload`:
    - fuse audit, packaging test (local mode) and the zip's version check all PASS;
    - six files: DMG, zip, `SHA256SUMS`, and FFmpeg's and yt-dlp's sources with FFmpeg's build script;
    - GitHub's digests match the local build.
- **Next:**
  1. The owner installs `app/dist/Mergelane-0.1.0-arm64.dmg` by hand and tries it.
  2. The owner publishes the draft on GitHub (docs/RELEASING.md, steps 5 and 6).
- **Follow-ups:**
  - `extensionMedia.spec.ts`'s "Send this video to Mergelane" failed once in a full `local.sh` run: the app's link field
    lost its last character, and the probe said "isn't a video". Since then it passed 32 runs alone and two full
    suites. The cause is not found.
  - The app has no "Remove helper" button: Phase 3 candidate.
  - `scripts/acceptance/daemon.sh` sets `GOCOVERDIR` only for `run`, so `install`/`uninstall` show 0% coverage.

**Test isolation fix** (branch `fix-e2e-browser-downloads`): the extension e2e test that clicks a download in
Chromium put the browser's temporary file in the owner's real `~/Downloads` on every run (it came and went, so
nothing was left). Chromium now gets its own home and an existing download folder; three runs and a full
`@extension` run (16 passed) left `~/Downloads` untouched.

**Owner choices for Phase 2:**
- CI stays paused, with no manual runs for now (ADR-0020, reconfirmed 2026-11-11). Everything runs on the
  owner's Mac instead (ADR-0032).
- YouTube: option A with hard limits (ADR-0026); Deno shipped.
- FFmpeg: our own LGPL build (ADR-0028); sources attached to every release (ADR-0027).
- Probes and the quarantine test accepted (ADR-0008, ADR-0013); Telegram removed (ADR-0012, branch
  `m2.6-remove-telegram`: 3,570 lines and four packages gone; smoke 428 passed, 1 skipped).
- Chrome Web Store: later, once Phase 2's installer works.
- Keep the `m1.4-pinning` branch.

### Phase 1 closed, pending the owner's approval

The report is `docs/PHASE-1-REPORT.md` and the proposed next phase is `docs/PHASE-2.md`. On 2026-11-10 the owner
chose to record criteria 1 (for PR #4's build), 2 and the app part of 6 as unproven for now, instead of
starting one manual CI run. The latest build is installed on the owner's Mac (`/Applications/Mergelane.app`); the
helper is not installed yet.

### Not yet proven in CI

CI is **paused** at the owner's request (ADR-0020); runs start only by hand.

- **Criterion 1 (DMG installs and launches):** proven for the app without the bundled helper (PR #2). PR #4's
  version, which bundles the helper, has not been re-run since the pull-request signing fix was merged into
  its branch.
- **Criterion 2 (one file over both links beats the faster link) and the app half of criterion 6:**
  - The first CI run failed at the app's URL probe, which uses the default route, and the simulated server
    wasn't reachable that way.
  - Fixed with `netsim.sh via 1` (`d922698`). Not re-run yet.
  - Run with `gh workflow run ci.yml --ref m1.4-system-merge`.

### Next

- Owner: review `docs/PHASE-1-REPORT.md` and `docs/PHASE-2.md`, merge PRs #1–#4 in order, and answer the
  Phase 2 questions.
- When CI is back on: prove criteria 1, 2 and the app part of 6 with
  `gh workflow run ci.yml --ref m1.4-system-merge`.
- **Daemon `run` coverage:** done in Phase 2, M2.0. `run` was split into testable parts; package coverage went
  from 63.6% to 92.5%, and `run` itself is at 100%.

### Blockers and open questions

- **Owner questions Q2–Q4** in `docs/PHASE-1.md` §4: answered on 2026-11-11 (ADR-0008, ADR-0012, ADR-0013).
- **Link recovery** after `ifconfig down` and `up` doesn't work in the harness yet (ADR-0015). It is not a
  Phase 1 criterion.
- **The helper runs only after the app is approved** (ADR-0019). The admin-prompt install still needs
  real-hardware confirmation.
- **Stale branch:** `m1.4-pinning` on GitHub was replaced by `m1.4-system-merge`. Deleting it needs the
  owner's OK.
