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
    *Resolved:* the owner deleted them (558 by then), and the torrent tests no longer leave them (branch
    `test-cleanup`).
- **M3.1, pull request 5c** (branch `m3.1-sheet`): New download as the design's sheet.
  - `ui/dialog.tsx` gains a `sheet` variant: hung 60px from the top, 600px wide, sliding down 16px as it fades
    in (320ms, the design's curve) and back up as it goes, using Base UI's `data-starting-style` and
    `data-ending-style`. Under Reduce Motion it appears at once.
  - `NewDownloadDialog` takes the design's layout: a Close button, labelled rows, a preview card with tags, a
    quality list with sizes, network chips with tiles and checkboxes, and the footer. All its logic is kept:
    the queue of links from the browser, resuming, a torrent's files, the Usenet server, the file name, Open
    file, free space, data limits, subnets and single-connection files.
  - **Not built:** the design's "When: Now / Add to queue / At a time". Mergelane has no start time for a
    single download; the queue and the schedule decide. That would be new engine work, for the owner to decide.
  - **Unit tests:** `NewDownloadDialog` is in `COVERED`, at 99.1% of lines.
- **M3.1, pull request 5d** (branch `m3.1-networks`): the Networks screen.
  - `screens/NetworksScreen.tsx`: the design's network list (tile, name, interface, connection type only,
    state, limit tags, last-minute sparkline, speed and upload, the pencil, a limits button, and a switch for
    new downloads, which is the saved `off` preference), system merge, recent dropouts, and the note on combined
    speed. The sidebar and compact bar gain a Networks place (`screen: 'networks'`).
  - `NetworksMenu` (the downloads toolbar's popover) is deleted: everything in it is on the screen.
  - The colour picker gains "Theme colour", which clears a picked colour; a picked one overrides the theme's.
  - **Kept for 5e:** the Speed & data limits dialog, opened from the screen. Its general page (total speed,
    slow mode, downloads at once, schedule) and Usenet page move to Settings in 5e, and its network pages
    can then move onto this screen.
  - **Not built:** the design's "Which network carries what" (routing downloads and uploads to one network).
    Mergelane has no such routing; it would be new engine work, for the owner to decide.
  - **e2e:** a `place()` fixture goes to a place by the sidebar; `newDownload()` goes to Downloads first.
    `systemMerge`, `nzb`, `scheduleQueue` and `ui` use it instead of the menu.
  - **Unit tests:** `NetworksScreen` (100%) and `NetworkEditPopover` (98.4%) are in `COVERED`.
  - One smoke run had one failure, `streamDownload.spec`'s "an HLS stream becomes one file" (an extra file in
    the folder). It passed twice alone and in the next full run. Seen once.
- **M3.1, pull request 5e** (branch `m3.1-settings`): the Settings screen.
  - `screens/SettingsScreen.tsx`: General, Appearance and Downloads, with the design's section list (a segmented
    control under 620px). The store gains `screen: 'settings'`, `settingsSection` and `openSettings()`; ⌘,
    opens it (`hooks/useSettingsShortcut.ts`).
  - **General:** speed units, the merged speed now, slow mode, and the total speed (opens Speed & data limits).
  - **Appearance:** Auto, Light or Dark; the seven themes with mini-window previews of the mode shown; the
    network colours in the theme.
  - **Downloads:** save folder, downloads at once, the schedule (opens Speed & data limits at it), the news
    server (opens its dialog), and per-network limits (opens Networks).
  - The sidebar ends with Settings (and the update button until M3.2); the compact bar has a Settings button.
    The units and theme toggles leave the frame; `ThemeToggle` is deleted.
  - **Still a dialog:** Speed & data limits holds the total speed, slow mode's speed, the schedule and each
    network's limits; Settings and Networks open it. Moving those fields onto the screens is left for later.
  - **Not built here:** Updates and Browser extensions (M3.2, M3.4); Liquid Glass's settings (pull request 7);
    the design's "On this Mac" (open at login, menu-bar speed, notifications), which have no setting today.
  - **e2e:** an `openSettings()` fixture; `ui.spec` sets Dark and the Sage theme in Settings.
  - **Unit tests:** `SettingsScreen` and `useSettingsShortcut` are in `COVERED` at 100%.
- **M3.1, pull request 6 is split in two:** 6a the Dashboard's layout (no helper change); 6b "Mergelane on this
  Mac" (CPU and memory), which changes the helper's protocol and needs the owner's admin test run.
- **M3.1, pull request 6a** (branch `m3.1-dashboard`): the Dashboard in the design's layout.
  - The hero band is gone (`HeroBand` and the `--hero-*` and `--footer-border` tokens deleted): the Confluence
    and the last minute sit at the top of the page.
  - **Today** (`components/DashboardToday.tsx`, `todayTotals` in `utils/dashboard.ts`): what downloads brought
    in today on the Mac's calendar, by network, with the fastest download (the best per-download peak; Mergelane
    doesn't record a merged peak across downloads) and the dropouts since the app opened.
  - Section headings take the design's sentence case on a rule.
  - **Kept, though the design moved them to Networks:** the network status list, failover, system merge with its
    merged-traffic chart, and "About combined speed" (the honest limits CLAUDE.md asks for in the UI).
    Trimming them is the owner's call.
  - **Unit tests:** `DashboardToday` in `COVERED` at 100%.
- **M3.1, pull request 6b** (branch `m3.1-usage`): "Mergelane on this Mac" (ADR-0035).
  - `shared/appUsage.ts` (pure: `ps` parsing, the helper and tools by process tree, the app's CPU from
    cumulative CPU seconds) and `main/appUsage.ts` (gathers it), behind a new `appUsage` IPC call.
  - `components/UsagePanel.tsx` on the Dashboard: CPU and memory totals, the last minute of CPU, and a table by
    part (Mergelane, Helper, Video tools).
  - **Changed plan:** the helper doesn't report its own usage; the app reads it with `ps` (ADR-0035). The helper
    and its protocol don't change, so this step needs no admin test run.
  - A real-app e2e check (`dashboard.spec`) caught the `ps` reading counting itself as a video tool; it and the
    crash reporter are left out by name.
  - **Unit tests:** `UsagePanel` and `shared/appUsage` are in `COVERED`.
- **M3.1, pull request 7** (branch `m3.1-glass`): Liquid Glass. **The last M3.1 pull request; 0.2.0 is next.**
  - **Window:** the theme puts the window in macOS's material: vibrancy `under-window` with a clear background,
    faded in and out over 200 ms (`main/windowBackground.ts`; `BrowserWindow.setVibrancy(type | null,
    { animationDuration })` in Electron 44.4.4's own type definitions). Off for other themes, Reduce
    transparency in Settings, and the Mac's Reduce Transparency (`nativeTheme.prefersReducedTransparency`).
  - **Page:** `main.css` scopes the design's layers to `[data-palette="liquid"]`: a clear page, the window, the
    sidebar and the content pane (rounded, inset 8px), and the cards, each a translucent fill with rim light.
    There is no CSS backdrop filter, because the system already blurs the desktop. Tinted thickens every layer;
    `data-solid`, `prefers-reduced-transparency` and `prefers-contrast: more` make them solid.
  - **Settings › Appearance › Liquid Glass:** Look (Clear, Tinted) and Reduce transparency (on and fixed when
    the Mac has it on). Saved as `glassLook` and `solidGlass`.
  - **Cost, with the CPU panel:** in the e2e app, Mergelane's own CPU settled under 1% with and without glass,
    idle and downloading; first samples after a switch spike in both. The blur itself is drawn by macOS's
    WindowServer, which the panel doesn't count. The owner should glance at WindowServer in Activity Monitor
    with the theme on.
  - **Not verified by tests:** how the material looks, because page screenshots don't include it. Whether
    `nativeTheme`'s `updated` event fires when Reduce Transparency changes isn't documented, so a change made
    while the app runs may need the theme reselected.
  - **e2e:** `glass.spec` reads the real window's background (cleared for the material, the theme's when
    solid), the saved settings, and a restart.
- **The two flaky Link-field tests: explained and fixed (branch `fix-link-field`).**
  - `browserBridge.spec` ("a download is offered…") twice had `erge` appended to the link (`…/test.binerge`);
    `extensionMedia.spec` ("Send this video to Mergelane") twice lost the link's last character.
  - **Cause:** a link arriving calls `bringForward` (`app/src/main/openLinks.ts`), which showed the window and took
    the Mac's keyboard focus (`app.focus({ steal: true })`) even in a test run, whose windows are meant to stay
    hidden. Keys typed at the Mac during the run landed in the test's Link field: "merge" typed in this chat, and
    probably a Delete in the other case.
  - **Fix:** `bringForward` does nothing while `testKnobs.hideWindow` is set. Real use is unchanged. No test relied
    on the window coming forward.
  - **Test:** `browserBridge.spec` now checks that the window stays hidden and unfocused after a link arrives.
- **Flaky test seen once:** `writeWait.spec` ("a disk-held range is not fetched again…") failed once during a full
  smoke and extension run (`expect(ranges).toHaveLength(4)`), then passed 4 times alone. It relies on timing (a
  2-second hedge), so heavy load can upset it. Watch for it again.
- **0.2.0 release, pull request** (branch `release-0.2.0`): version 0.2.0 and its `CHANGELOG.md` section, rewritten
  for users from the M3.1 entries. `notes.mjs --check` passes.
  - **Next, after the merge** (`docs/RELEASING.md`, "Releasing from this Mac"):
    1. `node scripts/release/local-release.mjs --version 0.2.0` on `main`;
    2. the same with `--upload`, which makes the **draft**;
    3. the owner installs the DMG, then publishes the draft.
  - Merged (#33). The first build without upload stopped at the packaging test's last check:
    - the launched test copy had created `~/Library/Preferences/io.github.zahidnoor7.mergelane.plist`;
    - it held only three keys that Electron writes on every launch, which macOS saves under the real home whatever
      `CFFIXED_USER_HOME` says. With 0.1.0 the file already held them, so nothing changed then.
    - The file is still there; deleting it was blocked by the permission check. It is harmless.
- **Packaging test fixes** (branch `fix-package-prefs`), in `scripts/ci/package-test.sh`:
  - the app's preferences are compared by content (`defaults export`), without Electron's three launch keys;
  - the ad-hoc signature check reads `codesign`'s whole report before matching. Piped into `grep -q` under
    `pipefail`, it failed a good signature (twice in a row while fixing the first issue).
  - The local packaging test then passed on the built 0.2.0 DMG, and the release scripts' tests passed (88).
- **0.2.0 draft release created** (after #34, from `main` at `706a6e3`):
  - the build without upload passed everything: fuse audit, packaging test (102 entries unchanged), zip check and
    sources;
  - two `--upload` runs then stopped before uploading anything, both at FFmpeg's source download from ffmpeg.org
    (a 60-second stall, then `ECONNRESET`). The third run created the draft.
  - The draft has six files. GitHub's digests match `app/dist/SHA256SUMS`: DMG `44ba38b3…`, zip `8e55b0d8…`.
  - **Next:** the owner installs the DMG from the draft, then publishes it (`docs/RELEASING.md`, steps 5 and 6).
  - **Follow-up, done (branch `sources-retry`):** downloads now try again on failure.
    - Each pinned download (the tools, FFmpeg's source for the build, and the sources for the release) is tried
      again after 5 seconds, then 10, when a connection is reset, refused or stalls, or the server answers 5xx
      or 429: three tries in all.
    - A 404, a refused URL or a checksum mismatch is not tried again.
    - `downloadWithRetries` and `isTransient` are in `fetch.mjs`. Tests use a local server that cuts the first
      connection or answers 503 first. Line coverage: `fetch.mjs` 99.3%, `sources.mjs` 97.6%.
- **M3.2 Updates.** The owner chose "download, verify, open the DMG" (ADR-0036, which replaces ADR-0010). Split in two:
  - **M3.2a** (branch `m3.2-updates-check`): the check, Settings › Updates and the sidebar notice.
    - `shared/releases.ts`: semantic-version order, the release for each channel (Stable leaves prereleases out;
      drafts never show), and "What's new" read from the release notes.
    - `main/updater.ts` asks `GET /repos/ZahidNoor7/mergelane/releases` with `net.fetch`. It checks on request,
      from the app menu's "Check for Updates…", and once a day. A 403 or 429 means "try again in an hour".
    - Saved: `updateAutoCheck`, `updateChannel`, `updateSkipped`, `updateLastChecked`.
    - `electron-updater` is removed. The `publish` block stays for the release script.
    - **UI:** Settings › Updates (version card, status, What's new, "Get it from GitHub", "Skip this version",
      automatic checks, channel) and the sidebar notice with a dot on Settings, as the design draws them.
      "Get it from GitHub" stands in for "Download and install" until M3.2b.
    - **Tests:**
      - Vitest: 205 passed, 100% of lines in every new or changed file.
      - `e2e/updates.spec.ts` (3 tests) runs against a local server answering as GitHub does. It checks the request
        headers, the channels, skip, the saved choices, the errors and the automatic first check. A test run never
        asks GitHub.
      - Smoke and extension: 469 passed, 1 skipped.
    - The README's privacy note now says that the app checks GitHub once a day, and that this can be turned off.
  - Merged (#37).
  - **M3.2b** (branch `m3.2-updates-download`): download, check, open.
    - `main/updateDownload.ts` reads the release's `SHA256SUMS` and streams the DMG with `net.fetch` into
      `<userData>/updates/<name>.part`, hashing as it goes. It checks the size and the SHA-256, then renames the
      file. A failure or a cancel removes the part.
    - `main/updater.ts` adds 'downloading', 'verifying' and 'ready', Cancel, "Quit and install"
      (`shell.openPath`, then `app.quit()`) and the background download.
      - A check never runs over a download.
      - A new channel or a skip stops the download.
      - Old images are cleared at launch.
      - Saved: `updateBackgroundDownload`.
    - `shared/releases.ts` gains `parseChecksums`, and `downloadableUrl`: https, or plain http on loopback, for
      tests.
    - **UI:** the design's downloading (bar, Cancel), checking and ready states, "Try again" after a failed
      download, the background switch, and "is ready to install. Install…" in the sidebar. A release without a
      DMG or `SHA256SUMS` still offers "Get it from GitHub".
    - **Tests:**
      - Vitest: 213 passed, 100% of lines in each changed renderer or shared file.
      - `e2e/updateDownload.spec.ts` (4 tests): download, check and install; a checksum mismatch, then Try again;
        Cancel mid-download; the background download, and clearing an old image at launch.
      - Smoke and extension: 473 passed, 1 skipped.
      - A test run writes the path it would open instead of opening a disk image or quitting.
- **M3.3 Menu bar, Open at login, notifications** (branch `m3.3-menubar`, ADR-0037). The owner chose to try Open
  at login and show macOS's real status.
  - **Menu bar** (`main/menuBar.ts`):
    - a `Tray` with `resources/trayTemplate.png` and `@2x` as a template image;
    - its title is the merged speed (`DownloadManager.totalSpeed()`, `setTitle` with `monospacedDigit`) while bytes
      move, in the window's units;
    - its menu has Open Mergelane and Quit;
    - saved as `menuBarSpeed: false` when off.
    - `formatBytes` and `formatSpeed` moved to `shared/speedText.ts`, so the window and the menu bar say the
      same; the renderer re-exports them.
  - **Open at login** (`main/loginItem.ts`):
    - `app.setLoginItemSettings({ openAtLogin })`, with the default `mainAppService`;
    - Settings shows `getLoginItemSettings().status`: enabled, requires approval, or not registered (with where to
      add it by hand);
    - only a packaged app registers; development and test builds show it unavailable;
    - opened at login (`wasOpenedAtLogin`), the window waits for the Dock or the menu bar.
    - The design's default (on) isn't followed: Apple asks for the user's consent first.
  - **Notifications:** Plexo's existing "Download complete" (click to show the file) is now gated by
    `notifyWhenDone`. A `failed` event is logged. Failure notices are unchanged.
  - **Tests:**
    - In a test run, all three record to `globalThis.__mergelaneTest` (`testKnobs.testRecord`) instead of reaching
      macOS, so the tests never touch the Mac's menu bar, Notification Centre or Login Items.
    - `e2e/onThisMac.spec.ts` (4 tests): the speed title in bytes and bits, off and kept over a restart; the
      notification, then none once turned off; Open at login unavailable; and "needs approval".
    - Vitest: 223 passed, 100% of lines in `OnThisMacSettings`, `speedText`, `SettingsScreen`.
    - Smoke and extension: 477 passed, 1 skipped.
  - **Not provable in tests:** whether ad-hoc signing is enough for `SMAppService` and macOS notifications. The
    first real install answers that, and the Settings row reports it.
    - Merged (#39).
- **M3.4a Browser extensions** (branch `m3.4-extensions`, ADR-0038). The owner chose a guided manual install (no
  Chrome Web Store account) and Safari later.
  - **Sources:**
    - native messaging folders from Google's, Microsoft's (Microsoft Learn, through the `microsoft-docs` server)
      and Mozilla's docs;
    - Brave and Vivaldi have no official docs, so they're listed as not supported yet;
    - Arc stops working on 22 December 2026 (arc.net), so it's left out.
  - The extension is built before packaging (`local-release.mjs`, `ci.yml`, `release.yml`) and ships in
    `Contents/Resources/browser-extension/`. `package-test.sh` checks it is there and watches Edge's
    `NativeMessagingHosts` too.
  - `main/browsers.ts`:
    - finds browsers in `/Applications` and `~/Applications`;
    - copies the extension to `<userData>/Browser Extension/<kind>` when the app's version changes;
    - shows it in the Finder.
  - `nativeHost.ts` registers Edge too.
  - **UI:** Settings › Browser extensions, as the design draws it:
    - browsers on this Mac, and the others, with Scan again;
    - an Install… guide dialog: Show in Finder, the extensions page with Copy, Developer mode, Load unpacked;
    - whether the extension has reached Mergelane.
    - The narrow segmented control uses the design's short labels.
  - **Tests:**
    - Vitest: `browsers.ts`, `ExtensionSettings`, `settingsParts`.
    - `e2e/browserExtensions.spec.ts` (2 tests): it builds its own extension copy and uses a test Applications
      folder. The Finder is never opened; the app notes what it would show.
    - `nativeHost.spec` now expects Edge.
  - Merged (#40).
- **M3.4b Capture rules and connected browsers** (branch `m3.4-rules`, ADR-0039; bridge protocol v3). The owner
  chose the design's defaults plus unknown types.
  - **Helper (Go):** `ParentApp` reads the parent process's executable with `/bin/ps` and sends it as `browser` on
    each request line. `ProtocolVersion` is 3.
    - `go test -race`: `internal/nmhost` 98.8%, `cmd/mergelane-nmhost` 91.7%; `go vet` and `staticcheck` clean.
  - **App:**
    - `shared/captureRules.ts`: the rules, defaults, sanitising and `keptBy`;
    - the bridge applies the rules in `add`, answers `ping` and `wake` with `rules`, and records `browserContacts`
      (saved at most hourly per browser);
    - `scanBrowsers` reports each browser's contact and the extension version Mergelane ships.
  - **Extension:** it sends its version, stores `appRules` from the reply, greys its icon when sending is off in
    Mergelane, and skips the video list when that's off.
  - **UI:** each browser row says "Reached Mergelane … , extension x", or "Restart … to use y" when out of date.
    "What the extension does" has sending, minimum size, file types and the video list.
  - **Docs:** BROWSER-BRIDGE.md documents v3. `package-test.sh`'s health check sends v3.
  - **Tests:**
    - Vitest: `captureRules`, `browserOfExecutable`, and the new rows and rules group.
    - `browserBridge.spec`: the rules on `add` (size, type, off, magnet), the rules in `ping`, and contacts.
      Its offered file is now 2 MB, over the new default minimum.
    - `extension.spec`: in real Chromium, the extension stores the app's rules and greys its icon when sending is
      off.
  - Merged (#41).
- **M3.5a Routing downloads** (branch `m3.5-routing`, ADR-0040). M3.5 is split: uploads and upload limits are
  M3.5b (torrent uploads follow peers' networks, and nothing limits uploads yet).
  - **Engine:** `routing: { down, fallback }`; `reconcile` gives the networks the route leaves out a new status,
    `routed`; each download's `enabled` is kept. A pinned network that's gone means fallback (each download's own
    networks) or waiting.
  - **UI:** `RoutingPanel` on the Networks screen, as the design draws it: "Downloads use" (All networks, or each
    network with its tile), the note when the chosen one is gone, and "Use the other networks if the chosen one
    drops".
  - **Tests:**
    - Vitest: `RoutingPanel`, `networkStatus`, `NetworksScreen` at 100% of lines.
    - `e2e/routing.spec.ts` (2 tests, two real test networks): pinning moves a running download and unpinning
      spreads it again; with the pinned network dropped, fallback stands in, and without it the download waits
      and resumes on its return.
  - **Noticed:** the screenshot run read the owner's installed helper (0.1.0) and showed it as out of date
    against this 0.2.0 build. It was read only; nothing was clicked.
- **M3.5b Routing uploads and upload limits** (branch `m3.5b-uploads`, ADR-0041).
  - **Engine:** `routing.up` (`shared/routing.ts`: `routeFor`, `sanitizeRouting`, shared by both directions).
    Pinned, a torrent uploads only to peers on that network; the others stay choked and are still downloaded from.
    A pinned network downloads don't use carries uploads only (its peers and twins dialled, never asked for
    pieces). webtorrent is told per peer in `torrent/wireGate.ts` (instance wraps of internals, no new patch).
    `Limits.takeUpload`: total and per-network upload buckets, each block held until they allow it.
  - **UI:** `RoutingPanel` gains "Uploads use" with its note when the chosen network is gone, and the design's
    wording for both directions. Speed & data limits gains "Total upload speed" and each network's "Upload speed".
    A routed network now says "Not used for downloads".
  - **Fixed on the way:** Reset data usage's confirm closed as it was clicked (Base UI's Close ignores
    `preventDefault`), so a failed reset never said why. It now uses `preventBaseUIHandler` and stays open.
  - **Tests:**
    - Vitest: `shared/routing` (5), `RoutingPanel` (6, 3 new), `LimitsDialog` (13, new; it had none). Lines:
      `LimitsDialog` 97.4%, `RoutingPanel`, `routing.ts`, `networkStatus` 100%. Full run 261 passed.
    - `e2e/torrent.spec.ts` "routing uploads" (2): downloads over a and uploads over b (b only uploads, a never
      does); pinning uploads to a while running stops them on b and downloading over b goes on. Stable over 3
      repeats.
    - `e2e/limits.spec.ts` (3): a total and a per-network upload limit hold uploads to 32 KB/s; a no-limit control
      shows the check has teeth (it ran at about five times the bound).
  - **Limits, documented in ADR-0041:** a peer that dials in over another network isn't uploaded to while uploads
    are pinned (webtorrent sends no listen port to twin it on); tracker announces aren't routed; data limits still
    count received bytes only; slow mode stays download-only.
  - **Pre-existing failure, not from this branch:** `scheduleQueue.spec` "schedule dialog saves, cancels edits…"
    fails at its toolbar indicator on unchanged `main` too (run on 2026-11-11 around 23:00 local).
    **Explained and fixed** (branch `fix-schedule-test`): not the time of day. Since M3.1 the spec opens the dialog
    from the Networks place, and the indicator is only in the Downloads header, so it was never there. The spec now
    goes to Downloads for it and also checks the sidebar's schedule line; it passes at 23:46 local and just past
    midnight (other time zones). The spec's 11 tests are now `@smoke` (about 3 s each).
- **M3.7 Diagnostics and history** (branch `m3.7-diagnostics`, ADR-0042).
  - **History:** network events and the day's fastest merged speed are logged by the main process and kept in
    `userData/network-activity.json` (a week, at most 50 events). A drop still open at quit and connected at
    launch reads "came back while Mergelane was closed". Today shows "Fastest merged speed" and the last 24 hours'
    dropouts, as the design does.
  - **Diagnostics:** Settings › General › Troubleshooting and the app menu's "Save Diagnostics…" save a zip
    (`ditto`) of `README.txt`, `diagnostics.json` and the helper log's last 200 lines. Fields come from an
    allowlist, then every string is redacted (see ADR-0042).
  - **Tests:**
    - Vitest: `shared/networkActivity.ts`, `shared/diagnostics.ts` (a planted-secrets test),
      `DiagnosticsSettings`, `useNetworks` at 100% of lines; `DashboardToday` and `NetworksScreen` updated.
    - `e2e/diagnostics.spec.ts` (2 tests): a bundle saved from Settings and from the app menu through a stubbed
      save dialog, unzipped and searched for every planted secret, the home folder and the user name; cancel
      and an unwritable folder. Dropouts and the fastest speed survive a relaunch.
  - **Open for the owner:** whether the bundle may hold more (site hosts are in it; file names, folders and
    custom network names are not).
- **Flaky under load:** with the Mac at a load average of about 36 (another project's Node processes) and 17 GB
    of swap, Vitest's 5-second limit failed one slow test per run: `NewDownloadDialog` once, `NetworksScreen`
    once. Each passed alone, and the full run passed with `--maxWorkers=3`.
- **M3.6 Clipboard monitor** (branch `m3.6-clipboard`, ADR-0043). "Offer links I copy", off by default (owner's
  decision, 2026-11-11, because of macOS's pasteboard alert).
  - **Main:** `clipboardOffers.ts` reads the clipboard only on `'browser-window-focus'` and only with the setting
    on. It sends the window a link (`shared/links.ts copiedLink`), never other text. It keeps only the last
    offered link's SHA-256, in memory.
  - **UI:** `CopiedLinkOffer` at the sidebar's foot (under the compact bar when narrow): "Download…" opens New
    download with the link, and "Dismiss" puts it away. The switch is in Settings › Downloads › Adding downloads.
    `acceptedLink` moved to `shared/links.ts`, and `utils/format.ts` re-exports it.
  - **Tests:**
    - Vitest: `links`, `CopiedLinkOffer`, `useCopiedLinks` at 100% of lines, plus the new Settings row. The store
      lines added are covered too.
    - `e2e/clipboardOffer.spec.ts` (3 tests):
      - off: `clipboard.readText` is never called on focus;
      - on: a link is offered once, then again only after another copy, and Download… opens New download
        prefilled with nothing started;
      - through the real clipboard, which is saved in every format and put back.
  - **Not checked:** the macOS pasteboard alert itself, which needs a manual check on the owner's Mac.
- **M3.5c Uploads in data limits and slow mode** (branch `m3.5c-upload-limits`, ADR-0041's 2026-11-11 update; owner's
  decisions).
  - **Engine:** `Limits.countUpload` counts each torrent block once sent (the wire's `upload` event) toward its
    network's data limit; `take` and it share one counter. Slow mode now also stands in for the total upload limit,
    with the same speed in a separate bucket. `TorrentTransfer.uploadOnly()` leaves out a network at its data
    limit, so an upload-only (routed) network stops too: before, it went on uploading past its limit.
  - **UI text:** the data limit hint ("Stops downloads and uploads… Counts what Mergelane downloads and uploads on
    it"), the reset-usage confirmation, slow mode's hints in Speed & data limits and Settings › General, and the
    sidebar switch's tooltip. With slow mode on, the dialog's list no longer shows the total upload limit it
    replaces.
  - **Tests:**
    - Vitest: `LimitsDialog` (14, 1 new), `SettingsScreen` and `WindowChrome` (new assertions). Lines:
      `LimitsDialog` 97.4%, `SettingsScreen` and `WindowChrome` 100%. Full run 311 passed.
    - `e2e/limits.spec.ts` (3 new): b's data limit reached by uploads alone (downloads over a, uploads over b), and
      nothing more goes out over b; slow mode holds uploads to 32 KB/s, with a control (the total speed limit at
      the same speed) that runs past it. Each new test failed on unchanged `main` code, and the data limit test
      failed without the `uploadOnly` check. Stable over 3 repeats. `limits` and `torrent` specs: 33 passed.

- **0.3.0 release, pull request** (branch `release-0.3.0`): version 0.3.0, and its CHANGELOG section rewritten for
  users from the M3.2–M3.7 entries (one contradiction removed: an Added line still said uploads don't count toward
  data limits). `notes.mjs --check` passes.
  - **Next, after the merge:** `local-release.mjs --version 0.3.0` on `main`, then the same with `--upload`, which
    makes the draft.
  - **To test the in-app update:** 0.2.0 must be installed, and 0.3.0 must be published. A draft is invisible to
    the update check, which uses GitHub's API without a token. 0.2.0 itself is still a draft.

- **M3.9 New download's When** (branch `m3.9-when`, ADR-0044, decided unattended for the owner's review). Built the
  design's "When: Now / Add to queue / At a time", which M3.1 pull request 5c left out.
  - **Engine** (`downloadManager.ts`): `StartDownloadRequest.when` (`{ kind: 'queue' }` or `{ kind: 'at', at }`),
    checked by `shared/startAt.ts parseWhen`. Add to queue makes the download `queued` with `held`: `pump` passes
    over it until a run ends (`launch`'s `pump(true)`) or Start now. At a time saves `startAt`; a timer looks at the
    clock at least once a second while one waits and moves a due one to the front of the queue. Both are saved in
    the manifest and come back waiting after a relaunch; a time missed while Mergelane was closed starts at launch
    with `missedStartAt`. `resumeDownload` on a planned download is Start now; pausing one clears its plan.
  - **UI:** the sheet's When row (segmented control, time field, the hint under Add to queue, a warning when the
    schedule holds the time), the button ("Add to queue", "Start at 1:00 AM"). Rows: "Starts at …",
    "Started late". Details: when a queued one's turn comes, or why it started late. A new `start` action ("Start
    now") on rows, menus, the toolbar and the details header.
  - **Tests:**
    - Vitest: `shared/startAt` (14, fake clock) and `utils/downloadActions` (8) are new and in `COVERED`; new tests
      in `NewDownloadDialog` (4), `DownloadsScreen` (1) and the Inspector (3). Lines: `startAt` and
      `downloadActions` 100%, `NewDownloadDialog` 99.1%, `DownloadsScreen` 98.9%, `InspectorProgress` 98.4%. Full
      run 341 passed.
    - `e2e/downloadWhen.spec.ts` (3, `@smoke`): Add to queue doesn't start with room to spare until Start now, and
      gets its turn when a running download ends; At a time from the sheet sets the next 2-hours-ahead time, and
      one 4 s ahead waits, then starts on its own; a far time can't be used. After a relaunch the queued and
      later ones still wait, and one whose time passed while closed starts with "Started late" and the details
      note. With `scheduleQueue`, `ui` and `concurrency`: 48 passed.
  - **Not built:** the Dashboard's waiting list still says "Waiting for a turn" for a download with a start time; a
    date field (the engine already takes up to 7 days ahead).
- **Test clean-up** (branch `test-cleanup`): three test fixes, no change users see apart from one 4 px jump.
  - **Torrent tests no longer leave folders in the temp folder.** `torrentSwarm.ts` made a folder for every seeder
    (`mergelane-seed-*`), every leecher (`mergelane-leech-*`) and every `.torrent` file (`mergelane-torrent-*`), and
    never removed them; 558 had piled up. A swarm now removes its folders at `stop()`, which every spec calls in a
    `finally` or `afterEach`, so a failing test cleans up too. A test that times out before `stop()` is cleaned up
    when its worker exits. `torrentProbe.spec.ts` seeded into webtorrent's shared `/tmp/webtorrent` (6 files a run)
    and left one `.torrent` folder; it now uses folders of its own and removes them after each test. The app itself
    leaves nothing: its magnet lookup deletes its store (`destroyStore: true`).
    - Proof: `torrentProbe`, `torrent`, `limits`, `openLinks`, `removal`, `selection`, `scheduleQueue` and `ui` run
      one at a time: 0 such folders before and after each, and no `/tmp/webtorrent`. A throwaway spec that failed on
      purpose, and one that timed out without calling `stop()`, left nothing either. Before the fix, one
      `torrentProbe` run left 1 folder and 6 files.
  - **23 more spec files run in CI's smoke job** (`@smoke`). Of the 25 files without a tag, each was run three
    times in a row, alone; 23 passed every time in under 60 s and are now tagged.
    - Two of them failed every time, and are fixed:
      - `selection.spec.ts`: selecting a download moved the list up 4 px. The selection toolbar (56 px) is shorter
        than the header it replaces (60 px: title, summary, padding and rule). An app bug since the M3.1 list
        redesign; nothing ran the test. Both are now 60 px (`min-h-15`), and the test passes.
      - `clipboardOffer.spec.ts`: the test that uses the real clipboard put its HTML back as `text/html`, which
        adds a `<meta charset='utf-8'>` each time. So it failed whenever the clipboard held HTML, and grew the
        owner's clipboard by 22 bytes per run. It now writes the raw pasteboard HTML back (checked: the clipboard
        is byte-for-byte the same after three runs). The owner's clipboard was put back as it was.
    - Left untagged: `chaos.spec.ts` (already tagged `@chaos`; random sequences, so a red run may not be the PR's
      fault; no CI job runs `@chaos` yet, so a nightly job is worth adding) and `sparseFile.spec.ts` (Windows only:
      it always skips on macOS; an upstream leftover).
    - The smoke suite grows from 480 to 686 tests (`--list`). The slowest added files: `torrent` 41–45 s,
      `hedge` 43 s, `limits` 38 s, `streams` 14–16 s, `torrentProbe` 9 s (4 workers, on the owner's Mac).
  - **Helper acceptance coverage:** `scripts/acceptance/daemon.sh` passed `GOCOVERDIR` only to `run`. It is now
    exported for the commands run as the user, and passed through `sudo` (which clears the environment) to
    `install`, `uninstall`, `cleanup` and the other user's `status`. Checked with `bash -n`, ShellCheck 0.11 and
    `local-root.test.sh` (32 passed); **not run end to end** (it needs root). A coverage-built daemon run locally
    showed that an unwritable `GOCOVERDIR` only prints an error and keeps the exit code, so coverage can't fail a
    check. The launchd-run copy that `install` starts still writes none (launchd starts it, and it is killed with
    `kill -9`).

- **Remove helper** (branch `remove-helper`, ADR-0046; resolves the Phase 2 follow-up "no Remove helper button").
  - **UI:** Networks › Other apps › System merge ends with "Remove helper…" while the helper is installed, and a
    confirmation that says merging turns off, the Mac asks for the password, and downloads keep working. The
    result (removed, password prompt canceled, or failed with the reason) stays in the section.
  - **Main:** `main/daemon/removal.ts` turns merging off first (`disable`), then runs the bundled helper's
    `uninstall` through `osascript -e 'do shell script "…" with administrator privileges'` (one prompt). A
    dismissed prompt turns merging back on if it was on. No daemon (Go) change: `uninstall` already boots the
    LaunchDaemon out, cleans up routes and deletes both files.
  - **Test seam:** `MERGELANE_E2E_ADMIN_PROMPT=allow|cancel|fail:<reason>` records the osascript argv and runs
    nothing (ignored by packaged builds). `MERGELANE_E2E_DAEMON_INSTALLED` is now read live.
  - **Tests:**
    - Vitest: `SystemMergeSection.test.tsx` (17), with `SystemMergeSection.tsx` and `useSystemMerge.ts` added to
      `COVERED` at 100% of lines. Full run (with `main` merged): 358 passed.
    - `e2e/daemonApi.spec.ts` (7 new, Node side): the uninstall command's exact text and quoting (decoded back by
      AppleScript and split by /bin/sh, nothing run), osascript failure parsing, and the removal order against
      the fake daemon (off before the prompt; back on after a cancel; failure; a stuck or silent helper).
    - `e2e/systemMerge.spec.ts` (5 new, @smoke): the exact recorded argv, merge off first, Install offered after;
      Cancel in the dialog; a dismissed prompt; a failure with its reason; a development build without the seam;
      no Remove button without the helper. With `daemonApi`: 42 passed. `dashboard` and `diagnostics`: 10 passed.
  - **Not checked:** the real password prompt, bootout and file removal. They need a manual check on the owner's
    Mac with a packaged build; no test ran them.

- **M3.10 link priorities** (branch `m3.10-priorities`, ADR-0045; the roles are the owner's choice of 2026-11-11,
  the details decided unattended for the owner's review). Each network's role for downloads: Use, Standby, Don't
  use.
  - **Engine:** `NetworkPreference.role` (`'standby'`, `'never'`; left out is Use). `shared/networkRoles.ts`:
    `roleOf`, `sanitizeRole` (main's settings sanitizer), `byRole` (a file that can't be split gets a Use network
    first) and `networkStatuses`, which `DownloadManager.reconcile` now uses for every network status. New statuses
    `standby` (held back while one of the download's Use networks is on or still trying) and `unused` (Don't use).
    Routing wins over roles; torrent uploads routed to a Standby or Don't use network still go out over it
    (`uploadOnly`). `off` keeps its old meaning (left out of new downloads); picking a role on Networks clears it.
  - **UI:** the Networks line's switch is now a pop-up button with the three roles, each with what it does; line
    status texts for Standby and Don't use; the header counts standby networks. New download: Don't use unticked
    and unpickable, Standby tagged; a note when every network is Don't use. Details texts for the new statuses.
  - **Tests:**
    - Vitest: `shared/networkRoles` (21, new) and `NetworkRoleMenu` are in `COVERED`; `NetworksScreen` (the
      switch test rewritten for the pop-up, 2 new) and `NewDownloadDialog` (3 new). Lines: `networkRoles`,
      `NetworkRoleMenu`, `networkStatus` and `NetworksScreen` 100%, `NewDownloadDialog` 99.2%. Full run 367 passed.
    - `e2e/networkRoles.spec.ts` (2, `@smoke`): a Standby b carries nothing while a is connected, takes over when a
      drops, and stops once a is back; Don't use never carries, Standby carries when no network is Use, and both
      roles, picked through the Networks pop-up, survive a relaunch. `e2e/torrent.spec.ts` (1 new, `@smoke`): a
      Standby b downloads nothing while a is connected, yet carries the uploads routed to it. With `routing`,
      `liveNetworks`, `torrent` and `ui`: all passed.
  - **Not proven:** real hardware (an iPhone's tethering dropping); system merge has no roles.
- **Follow-ups: the mux test flake and the Dashboard's start times** (branch `followups-mux-dashboard`).
  - **`e2e/mux.spec.ts` "joins H.264 and AAC…" flake:** not timing and not the app. Playwright splits a fully
    parallel file that has afterAll hooks into one group per worker (40 tests, 4 workers: groups of 10) and runs
    afterAll at the end of each group. The file's afterAll deleted its scratch folder but kept the promise of the
    test media made inside it, so a worker that went on to a second group of the file handed the first real-FFmpeg
    test of that group (always this one, the 31st) paths that no longer existed: "the video track is missing".
    The failed test restarts the worker, so the rest of the group passed. It shows under load because a busy run
    is when one worker picks up two groups. The afterAll now forgets the media with the folder.
    - Before: `--repeat-each=10 --workers=4`, no extra load: 3 of 10 copies failed, all with that message.
    - After: five runs of `--repeat-each=10 --workers=4` (2,000 test runs, this test 50 times), 0 failed: two
      with no extra load, three with 12 `yes` processes running (load average 68–90).
  - **Dashboard:** a download with a start time said "Waiting for a turn" in the Dashboard's Downloading list. It
    now says "Starts at 1:00 AM" (or "tomorrow at …"), and a download that started late says "Started late", in the
    download list's words: `activeDetail` in `utils/dashboard.ts` uses `describeStartAt` and the new `STARTED_LATE`
    from `shared/startAt.ts` (the list uses it too). The section's clock ticks every 30 s, as the list's does.
  - **Tests:** Vitest `utils/dashboard.test.ts` (5; `activeDetail` fully covered; the rest of `dashboard.ts` stays
    covered by `e2e/dashboardModel.spec.ts`, so it isn't in `COVERED`). Full Vitest run: 363 passed.
    `e2e/downloadWhen.spec.ts` now checks the Dashboard row too (it fails on the old Dashboard). `downloadWhen`,
    `dashboard`, `dashboardModel` and `mux`: 64 passed.
- **0.2.0 and 0.3.0 published** (2026-11-12, owner's go-ahead). 0.3.0 is GitHub's Latest.
- **0.3.1** (2026-11-12, owner's go-ahead to prepare and publish): PRs #49–#56 since 0.3.0. Built and uploaded with
  `scripts/release/local-release.mjs`.
- **New download: the quality list and the wait for a link** (branch `fix-quality-list`, owner's screenshot).
  - **Quality list side by side:** `ui/toggle-group.tsx` never passed `orientation` to Base UI and styled
    `data-vertical`, which Base UI doesn't set (it sets `data-orientation`, per its 1.8.0 types). Vertical groups
    rendered as a row and pushed the dialog body sideways. The wrapper now passes `orientation` (arrow keys follow
    it) and styles `data-[orientation=…]`. The quality list uses a 2px gap instead of `spacing={0}`, whose joined
    segment styles the design doesn't have.
  - **Checking a link:** the preview's place shows a placeholder card (a `role="status"` region that is
    `aria-busy`): its tile's icon spins and its name line glows (`mergelane-glow`), both `motion-safe`, above the
    message.
  - **Tests:** `e2e/streamDownload.spec.ts` checks that the qualities stack, that nothing in the dialog scrolls
    sideways, and that the down arrow moves between them (it fails without the fix). Vitest
    `NewDownloadDialog.test.tsx` checks the placeholder. Vitest: 389 passed. `NewDownloadDialog.tsx` has 99.15% of
    its lines covered and `toggle-group.tsx` 100%. Smoke and extension: 720 passed, 1 skipped. In an earlier run,
    `ui.spec.ts` "New download says why it has no network" failed once under load; it passed 3 of 3 runs alone.
- **Sticky-per-site for system merge** (branch `sticky-sites`, owner's go-ahead, ADR-0048). The helper reads an
  HTTPS flow's server name from its ClientHello and keeps each registrable domain on one link. Flows without a name
  follow their address. Failover moves the site, and 10 minutes idle frees it. The setting is `setStickySites` /
  `stickySites` (protocol 1, additive), on by default, saved in `prefs.json`, with the CLI `sticky-sites on|off`.
  The app shows a switch in Networks › System merge.
  - **Tests:**
    - Go: the parser against real `crypto/tls` ClientHellos (every prefix, edge cases), and a fuzz test: 1.5M runs
      after the fix, plus the corpus input that found the double-dot bug;
    - Go: the site table (eTLD+1, learning addresses, expiry, the cap), `AcquireSticky`, the per-site dial with
      failover on lo0, the TUN proxy's per-site dialing, the controller, the prefs default, the CLI, and the API
      fixtures on both sides. Coverage of the new functions is 88–100%. `forward.go` needs a real utun (root), and
      was already at 0%.
    - TypeScript: Vitest `SystemMergeSection` (100% lines) and `diagnostics`; e2e `daemonApi` and `systemMerge`
      against the fake helper (44 passed).
  - **Needs the hardware suite** (M3.8): a real browser on real links, checking that one site stays on one
    network.
- **The extension saved where the user can find it** (branch `extension-folder`, owner's request, ADR-0047).
  - Install… saves it in Downloads, or the folder chosen with Change… (`extensionLocation`). Every saved copy
    (`extensionCopies`) and the old `<userData>/Browser Extension` folders are refreshed at launch and on each scan.
    A folder of the same name that Mergelane didn't make is left alone. The guide has Show in Finder, Copy, Open
    <browser>, and Copy path on the Load unpacked step, with a ⌘⇧G tip.
  - One-click install isn't possible in branded Chrome: `--load-extension` is gone since Chrome 137, outside
    installs on macOS must come from the Chrome Web Store, and `chrome://` isn't linkable (sources in ADR-0047).
  - **Tests:** e2e `browserExtensions.spec.ts` (3) checks:
    - nothing is saved on opening Settings;
    - Install saves into the test's own Downloads, stamped with the app's version;
    - Show in Finder and Open Chrome are recorded;
    - Change… then saves Firefox's copy there;
    - both copies are remembered;
    - an older copy, and the old Library folder, are refreshed at launch;
    - a stranger's folder is left alone.
  - Vitest: `ExtensionSettings.test.tsx` and `shared/browsers.test.ts`. 397 passed. `ExtensionSettings.tsx` has
    97.6% of its lines covered and `shared/browsers.ts` 100%. `main/browsers.ts` is main-process code, outside
    Vitest here, and covered by those e2e tests.
  - Smoke and extension: 721 passed, 1 skipped. `~/Downloads` unchanged.
  - **Owner to check by hand:** that ⌘⇧G and pasting the path works in Chrome's Load unpacked window, and that Open
    Chrome opens Chrome.
- **The extension's icon** (branch `extension-icon`, owner's request). The extension still had Plexo's icon. Its
  16, 32, 48 and 128 px icons and the grey "off" 16 and 32 px icons now come from the design's `icon-default`
  (details in `design-system/mergelane/redesign/README.md`).
  - Every other place was already on the new icon: the packaged app's `icon.icns` (its sizes compared pixel for pixel
    with the design's exports), `build/icon.png`, the window's `resources/icon-dark.png`, Settings › Updates and the
    menu bar's template icon.
  - **Tests:** Vitest `shared/brandIcons.test.ts` (5) checks these against the design's files, plus every icon the
    extension's manifest and `background.ts` name: it exists, at its size, with transparency, and the off icons are
    grey. It fails on the old icons. Full Vitest: 394 passed. Smoke and extension: 720 passed, 1 skipped. The built
    Chrome and Firefox extensions carry the new files, and screenshots of the popup and options page show them.
- **The extension restyled to match the app** (branch `extension-restyle`, owner-approved, ADR-0049). The popup and
  options page use Porcelain's colours (light and dark from the browser), the app's switch, capsule buttons, field
  and tag, and Settings' groups: sentence-case titles over rounded cards of hairline rows. Focus rings on every
  control, stronger lines with Increase Contrast, no motion with Reduce Motion. Only `popup.html`, `options.html`
  and `ui.css` changed; every id, text, role and label is kept.
  - **Tests:** no extension code changed, so there is nothing new for Vitest to cover. Extension e2e
    (`--grep @extension`): 17 passed. Lint, format and typecheck clean. Screenshots of both pages, light and dark,
    compared with Settings in the app. `~/Downloads` unchanged.
  - **Not checked:** Firefox. The CSS used is supported from Firefox 121, the extension's minimum, per MDN.

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
    lost its last character. Explained later: test windows took the Mac's focus (see "The two flaky Link-field tests").
  - ~~The app has no "Remove helper" button: Phase 3 candidate.~~ Resolved: Remove helper (ADR-0046, branch
    `remove-helper`).
  - `scripts/acceptance/daemon.sh` sets `GOCOVERDIR` only for `run`, so `install`/`uninstall` show 0% coverage.
    *Fixed in branch `test-cleanup`* (every daemon run now writes coverage); unproven until CI or `local-root.sh` runs it.

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
