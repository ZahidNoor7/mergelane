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
- **M3.1, pull request 1** (branch `m3.1-themes`): colours, themes and fonts.
  - The seven themes' seeds are in `shared/themes.ts`, copied from the final design (a test checks that they match
    it). `theme/appearance.ts` writes them as CSS, and `main.css` derives every other colour from them.
  - Auto, Light and Dark: `nativeTheme.themeSource` `system` is the default on a new install.
  - The window background follows the theme.
  - Archivo and Fragment Mono are bundled with their OFL texts. They replace Manrope and Roboto Mono, which had no
    notices.
  - Contrast tests cover all 14 colour sets, and every one passes.
  - The owner darkened Dusk's light sidebar card (`#3A3456` to `#353050`): its faintest text was 4.26:1 and is now
    4.56:1. This is recorded in `design-system/mergelane/redesign/README.md`.
  - `design-system/mergelane/MASTER.md` and `pages/dashboard.md` are rewritten for the new design, with the owner's OK.
- **M3.1, pull request 2** (branch `m3.1-icon`): the new app icon.
  - `build/icon.icns` is made with `iconutil` from the design's icon in all ten sizes; `build/icon.png` and
    `resources/icon-dark.png` are 512 px versions.
  - The menu-bar template icons (`resources/trayTemplate.png` and `@2x`, 144 dpi as Electron's Tray docs ask) wait
    for M3.3.
  - The extension's icons are unchanged until M3.4.
- **M3.1, pull request 3** (branch `m3.1-controls`): the basic controls in the design's look.
  - Button, Switch, Toggle (segmented and chips), ToggleGroup, Badge (tag), Input, Textarea, Checkbox, InputGroup and
    Alert; the popover, menus and dialogs (sheet shadow, design hover, scrim).
  - Every variant and size name the screens use is kept.
  - The switch knob no longer slides under Reduce Motion.
  - Menu items now visibly highlight: `focus:bg-accent` had no colour in the theme.
- **M3.1, pull request 4a** (branch `m3.1-visuals`): the chunk map, split bar, speed chart and sparklines in the
  design's look.
  - The chunk map (`BlockGrid`) keeps its real per-chunk attribution, virtualisation and "go to active". It draws
    capsule dashes, reads out below the map (polite live region), and can be read with the arrow keys, Home, End and
    Escape.
  - The speed chart has solid fills with 2px separators, the total line in ink, and keyboard reading. Its sentences
    are new: "Now", "60 s ago", "Merged".
  - Fix: an extra network's colour now skips swatches within 0.1 (Oklab) of the theme's network colours. Porcelain's
    Ethernet and the Teal swatch looked alike. The swatches now live in `shared/themes.ts`, and the colour maths in
    `shared/colour.ts`.
- **M3.1, pull request 4b** (branch `m3.1-confluence`): the Confluence.
  - `components/Confluence.tsx` is ported from the design. Lanes are as thick as their speed on the design's 36 MB/s
    scale, stretched above it. Thickness eases (τ 0.16 s), and the markings drift only while carrying.
  - It replaces `CombineDiagram`, which is deleted, and `BigStat`/`InlineStat` on the download screen and the
    Dashboard, and draws the empty list's illustration.
  - The download screen's average, peak, cap, error and "× faster" chip move into its caption, in sentence case.
  - `dashboard.spec` follows the new words: "Merged speed", "Nothing downloading", "1 downloading, …".
- **M3.1, pull request 5a** (branch `m3.1-sidebar`): the window's frame.
  - `components/WindowChrome.tsx`: the design's sidebar from 760px of window width, and its compact bar below.
    It replaces `TitleBar`, `StatusBar` and `ScreenFooter`, which are deleted.
  - The macOS window buttons sit in the sidebar's top strip (`trafficLightPosition` 22, 22). The window is
    dragged by that strip and by each screen's header (`.window-drag`; controls inside stay clickable).
  - The window opens at 1040 × 720; its minimum width is 720.
  - The sidebar's places replace the list's Dashboard button and the Dashboard's back button. The content is a
    `main` landmark.
  - `main` is a container (`@container`): the Downloads header, the networks menu button and the Dashboard
    lay out by the content's width, not the window's (Tailwind container queries, `@min-[…]:`). Without this,
    the sidebar's 236px made the search field and the networks button overlap at the default size.
  - The units and theme toggles, and the update button, stay in the sidebar's footer until Settings (5e) and the
    design's update notice take their place.
  - Screenshots checked in light and dark, at 1040 × 720 and 720 × 620. Playwright pins Electron pages to the
    light scheme, so dark screenshots need `page.emulateMedia({ colorScheme: 'dark' })`.
  - New parts: `NetworkTile`, `SpeedText`, `SpeedUnitToggle` (moved out of the status bar) and the
    `useElementWidth` hook, which the Confluence now shares. All are in `COVERED`, at 100% of lines.
  - `dashboard.spec` and `ui.spec` follow the new navigation.
  - Local results: unit 95 passed; smoke 448 passed, 1 skipped; extension 16 passed. One smoke run of three had
    one failure, `browserBridge.spec`'s "a download is offered, confirmed, and opens New download filled in"; it
    passed 4 repeats alone and the next full run. Its output wasn't kept, so the cause is unknown. Seen once.
  - **Local runs need `env -u ELECTRON_RUN_AS_NODE`** when started from a VS Code terminal, which sets that
    variable and makes Electron start as plain Node ("bad option: --remote-debugging-port=0").
- **M3.1, pull request 5b is split in two**, as 4 was. 5b-1 is the list; 5b-2 is the details pane, in which
  the Inspector replaces the three download screens.
- **M3.1, pull request 5b-1** (branch `m3.1-downloads`): the download list in the design's layout.
  - **Toolbar:** the title "Downloads" with what's running ("2 downloading, 1 waiting"), the search field, the
    schedule button, the networks menu and New download. The schedule button and the networks menu move out in
    5e and 5d.
  - **Above the list:** the Confluence of every network, from a new `useMergeLanes` hook that the Dashboard
    also uses now.
  - **Status tabs** with counts replace the status menu (`DownloadFilterMenu`, deleted).
  - **Filters by date added and file type:** the logic is in `shared/downloadFilters.ts`, and the panel and the
    chips in `components/DownloadFilters.tsx`. Date ranges are whole days on the Mac's calendar, counted by when
    each download was added (`startedAt`). The filters last while the window is open; they are not saved.
  - **Rows:** a file-type icon, the kind tags (`KindTags`, which replaces `TorrentBadge`, `UsenetBadge` and
    `StreamBadge`), the split bar, the progress in words, the speed, and the next-step button. The whole row
    opens the download; its button is named by the file name (it was "Open <name>").
  - **Kept, restyled:** the checkboxes and the selection toolbar, the keys (⌘A, ⌘F, Escape, Delete), the
    right-click menu, the network dots, and "Clear finished list".
  - **Unit tests:** `DownloadsScreen`, `DownloadFilters`, `DownloadGlyphs`, `fileTypeIcons`, `useMergeLanes`
    and `shared/downloadFilters` are in `COVERED`, at 97–100% of lines.
- **M3.1, pull request 5b-2** (branch `m3.1-inspector`): a download's details pane.
  - **Store:** `view` becomes `screen` ('downloads' | 'dashboard') plus `selectedId` and `detailOpen`, with
    `setScreen`, `openDownload` and `closeDownload`. Forgetting a download closes its details.
  - **Layout** (`screens/DownloadsPlace.tsx`): from 860px of content width (`screens/layout.ts`), the list with a
    400px details pane beside it; narrower, the details in the list's place, focused, with a way back to the row.
  - **Inspector** (`components/inspector/`): one pane for running, waiting, paused, finished, failed and
    cancelled downloads. It replaces `DownloadingScreen`, `CompleteScreen`, `ErrorScreen` and `DetailHeader`
    (deleted), keeping all they showed. Its buttons sit under the file's name, not at the bottom as in the
    design, so Open and Show in Finder are in reach without scrolling.
  - **Network list** (`components/DownloadNetworks.tsx`): the design's "By network" rows replace the 6-column
    `NetworkRow` table (deleted), which needed about 590px. Kept: each network's switch, its pencil, proxy, limit,
    status, upload, and streams or peers one by one.
  - A labelled progress bar (the split bar) says the download's progress to a screen reader.
  - **Window:** opens at the design's 1280 × 800, fitted to the screen's work area (`shared/windowSize.ts`;
    `screen.getPrimaryDisplay().workAreaSize`, checked in Electron's docs). The owner chose this on 2026-11-11.
  - Removed as unused: `HeroStats`, `ColorBadge`, `NETWORK_ROW_GRID_COLUMNS`.
  - **Unit tests:** the Inspector, its parts, the network list, `DownloadsPlace` and `windowSize` are in `COVERED`,
    at 98–100% of lines.
  - **The disk filled up during one smoke run** (215 MB free; swap at 25.6 GB). Four tests failed with ENOSPC
    or timing, and all passed once space was back. The leaked e2e temp folders (`mergelane-seed-*` and others,
    121 of them, 140 MB) were not deleted: the permission check refused a sweep of the temp folder. The owner
    can delete them, or allow it.
- **Flaky test, seen twice now:** `extensionMedia.spec`'s "Send this video to Mergelane". The link field shows the
  link without its last character, and the probe says "isn't a video".
  - It happened only during full `local.sh` runs, right after the smoke suite: 2 of about 7.
  - It passed 8 runs of the extension suite alone, and a full run with temporary logging at the bridge and the link
    queue (since removed).
  - **Ruled out:** the bridge's framing (JSON, so a lost byte would fail to parse), the link queue (no string
    changes), the YouTube parser (11-character ids), the clipboard (no test writes it), and key presses (none in the
    extension tests).
  - Not yet understood. The next step is to keep that logging behind a debug switch to catch the next occurrence.

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
