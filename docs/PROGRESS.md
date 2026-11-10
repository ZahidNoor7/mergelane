# Progress

Updated at the end of every working session.

## Phase 1: proof of concept and foundation

Last updated: 2026-11-10

### Done

- Step 0 plan (`docs/PHASE-1.md`) and pinned upstream commits (`docs/UPSTREAM.md`).
- Owner made the repository public (ADR-0011). Tooling installed with approval: Go 1.27.3 and staticcheck
  2026.2.2. The REA plugin (`rea@rea`) was installed at local scope at the owner's request.
- **S1 spike** (branch `spike/s1-ci-feasibility`, two CI runs; it is never merged): fake links, `IP_BOUND_IF` via
  koffi, fake VPN with `kill -9`, Gatekeeper and launchd all answered. Findings are in ADR-0013, ADR-0015 and
  ADR-0017.
- **M1.1 foundation**: PR #1.
- **M1.2 app** (branch `m1.2-app`):
  - Plexo imported verbatim, then rebranded and packaged for macOS 27 arm64 with an ad-hoc signature.
  - Hardened Electron fuses, `GET /health`, and auto-update off.
  - Local results on macOS 27.0.1:
    - lint, typecheck and format pass;
    - Playwright smoke: 38 passed;
    - `package-test.sh` passes (32 Mach-O files signed, Gatekeeper "rejected" as unnotarised, ready via `/health`);
    - the REA fuse audit passes.

### In progress

- CI for M1.2: `app-checks`, `app-e2e-smoke` and `package` jobs on `xcode-27`.

### Next

- M1.3: daemon port, control API, VPN guard (guard design informed by ADR-0017's findings).
- M1.5: simulated-network harness from the S1 scripts, including link recovery after `ifconfig down` and `up`.
- M1.4: downloader pinning with `IP_BOUND_IF` (verified via koffi locally and on the runner) and the System
  merge toggle.

### Blockers and open questions

- Owner questions Q2–Q4 in `docs/PHASE-1.md` §4. Work proceeds on the recommended option; see ADR-0008,
  ADR-0012 and ADR-0013.
- Link recovery after `ifconfig down` and `up` does not work yet in the harness (ADR-0015). It is not a Phase 1
  criterion.
