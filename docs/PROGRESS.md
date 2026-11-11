# Progress

Updated at the end of every working session.

## Phase 1: proof of concept and foundation

Last updated: 2026-11-10

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

**Owner choices for Phase 2:**
- CI stays paused (ADR-0020).
- YouTube: review first, no YouTube code until the owner picks an approach.
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
- **Daemon `run` coverage:** unit tests cover all of `cmd/mergelane-daemon` except `run`. The root acceptance
  run measured 38.7% of that package (only clean exits write counters). Raising it means splitting `run`'s
  wiring from its privileged steps.

### Blockers and open questions

- **Owner questions Q2–Q4** in `docs/PHASE-1.md` §4. Work proceeds on the recommended option (ADR-0008,
  ADR-0012, ADR-0013).
- **Link recovery** after `ifconfig down` and `up` doesn't work in the harness yet (ADR-0015). It is not a
  Phase 1 criterion.
- **The helper runs only after the app is approved** (ADR-0019). The admin-prompt install still needs
  real-hardware confirmation.
- **Stale branch:** `m1.4-pinning` on GitHub was replaced by `m1.4-system-merge`. Deleting it needs the
  owner's OK.
