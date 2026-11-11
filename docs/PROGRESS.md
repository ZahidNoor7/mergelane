# Progress

Updated at the end of every working session.

## Phase 1: proof of concept and foundation

Last updated: 2026-11-10

### Done

- Step 0 plan (`docs/PHASE-1.md`) and pinned upstream commits (`docs/UPSTREAM.md`).
- Owner made the repository public (ADR-0011).
- Tooling on the owner's Mac (owner-approved): Go 1.27.3 (Homebrew) and staticcheck 2026.2.2.

### In progress

- **S1 spike** (branch `spike/s1-ci-feasibility`): fake links with `feth` + pf + dummynet, `IP_BOUND_IF` from Node
  through koffi, fake VPN with `kill -9`, Gatekeeper on a quarantined ad-hoc app, launchd `KeepAlive`.
  - Locally verified so far (no root needed): koffi 2.16.3 loads `/usr/lib/libSystem.B.dylib`; `IP_BOUND_IF`
    sets and reads back; a socket pinned to `en0` cannot reach `127.0.0.1` (`EADDRNOTAVAIL`), as expected.
- **M1.1 foundation** (branch `m1.1-foundation`): licence and notices, README, changelog, decision log, CI with
  repository checks.

### Next

- M1.2 Plexo import and rebrand, DMG packaging test.
- M1.3 daemon port, control API, VPN guard.
- M1.5 simulated-network harness, using the design S1 confirms.
- M1.4 downloader pinning and the System merge toggle.

### Blockers and open questions

- Owner questions Q2–Q4 in `docs/PHASE-1.md` §4. Work proceeds on the recommended option; see ADR-0008, ADR-0012
  and ADR-0013.
