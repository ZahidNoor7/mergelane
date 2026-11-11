# Phase 3: Everyday (proposal)

Status: **proposed 2026-11-11, waiting for the owner's approval.** Phase 2 is finished: v0.1.0 is published.

Goal, from CLAUDE.md: Safari extension, clipboard monitor, link priorities and cost rules, sticky-per-site routing
option, diagnostics bundle, auto-update via GitHub Releases.

Added by the owner on 2026-11-11 (ADR-0034): the app's new look comes first, as M3.1.

Exit criteria, from CLAUDE.md: the hardware suite is green on the owner's Mac. That suite covers real Wi-Fi, iPhone USB
and Ethernet, unplugging, sleep and wake, and a VPN on and off.

## The design

The owner's final design is the artifact "Mergelane Redesign" (version `1794387759-a310`, declared final
2026-11-11). A fixed copy is in `design-system/mergelane/redesign/`:
- `prototype.html` is the whole design. Open it in a browser; it loads its libraries and fonts from public CDNs.
- `brand/` holds the new app icon (default and light), the menu-bar template icon and the marks.

The copy is the reference for every M3.1 pull request. The artifact's `notes.md` and `tokens-proposal.css` are
out of date (five themes, ink-only actions) and are **not** used.

The design is more than a new look. Comparing it with the app gives three groups:

1. **The same features, restyled.** Built in M3.1.
2. **New features the design shows.** Their screens ship with the milestone that builds the feature (M3.2 onwards),
   not before. A switch with nothing behind it is not shipped.
3. **Features the app has that the design leaves out.** Kept, restyled into the new layout unless the owner says
   otherwise (question 1).

## Milestones, in order

### M3.1 The new look (release 0.2.0)

Owner decisions (ADR-0034):
- all seven themes, each in light and dark: Porcelain (the default), Sandstone, Graphite, Sage, Dusk, Liquid Glass
  and High contrast;
- the app opens on Downloads;
- Auto appearance (follow the Mac) is added;
- it comes first in Phase 3.

Pull requests, each one merged before the next starts:

1. **Colours, themes and fonts.**
   - The theme engine: seed colours per theme and mode, and every other colour derived from them, as in the
     prototype. Set on `<html>` before first paint.
   - Light, Dark and Auto: `nativeTheme.themeSource` accepts `system` (Electron docs, checked 2026-11-11). Saved
     settings gain the theme id and `system`.
   - The window's background follows the chosen theme, so it never flashes the wrong colour.
   - Archivo and Fragment Mono replace Manrope and Roboto Mono, bundled offline. Saira is used only for the
     wordmark. Licences are checked and added to `THIRD-PARTY-NOTICES.md`.
   - Today's toggle stays until the Settings screen exists (pull request 5).
2. **Icon.** The new app icon (`build/icon.icns`, made from the SVG) and the menu-bar template icon, which waits
   in `resources/` for M3.3.
3. **Basic controls.** Buttons, switches, segmented controls, fields, checkboxes, menus, popovers, tooltips,
   dialogs, the sheet. These are the Base UI primitives in `components/ui/`; only their look changes.
4. **The main visuals.**
   - The lanes diagram (Confluence), which replaces CombineDiagram.
   - The chunk map, which replaces BlockGrid. It keeps keyboard reading.
   - The network split bar, the speed chart, sparklines and network rows.
5. **The layout.** This is the biggest change, so it is split:
   - **5a:** the sidebar and the narrow-window bar replace the title bar and status bar. The store's view
     becomes a screen plus a selected download.
   - **5b:** Downloads, with the details pane beside the list (or full width when narrow), the status tabs, search,
     and filters by date added and file type.
   - **5c:** New download as a sheet.
   - **5d:** the Networks screen. Today's networks popover, limits dialog and system merge section move into it.
   - **5e:** the Settings screen with the sections that have something behind them today: General, Appearance
     and Downloads. Updates and Browser extensions come with M3.2 and M3.4.
6. **Dashboard, and "Mergelane on this Mac".**
   - The dashboard is restyled.
   - CPU and memory come from `app.getAppMetrics()` (its `cumulativeCPUUsage` gives 100% as one core).
   - The helper reports its own usage in a new optional status field. That is an additive change to protocol v1,
     with fixtures and contract tests on both sides.
   - This pull request needs the admin test run again, because the helper changes.
7. **Liquid Glass.** The glass material, last, because it is the riskiest.
   - Electron's window material (`vibrancy`) instead of a painted desktop.
   - It follows Reduce Transparency and Increase Contrast. Electron exposes
     `nativeTheme.prefersReducedTransparency`.
   - Its graphics cost is measured with the CPU and memory panel before it ships.

**Every pull request comes with:**
- Playwright tests updated in the same pull request. Many tests find controls by their visible text, and the
  networks popover, the limits dialog, the status bar and the theme toggle all move.
- The local checks green, and the owner's review before merging.
- 90% coverage of the changed code, measured with the tooling the owner picks (question 4).

Main risks:
- **Tests:** dozens of Playwright tests click through the networks popover, the limits dialog or the toolbar by
  text. They are in the `ui`, `dashboard`, `systemMerge`, `scheduleQueue`, `selection` and `nzb` specs.
- **Window size:** the sidebar needs 760 px. Below that, the narrow bar is used; the minimum window stays 720×620.
- **Saved network colours:** today's saved colour ids no longer match the themes (question 2).

### M3.2 Updates

The design's Settings › Updates: version, "Check for updates", release notes, automatic checks, Stable and Beta.

- **Checking** uses the public GitHub Releases API only, as CLAUDE.md allows.
- **Installing** needs a decision first (ADR). The design downloads the DMG, checks its SHA-256, swaps the app and
  restarts. With ad-hoc signing that is not proven safe (ADR-0010), and macOS may ask to confirm again. The safer
  first step: download and check the file, then open it for the user.
- **Decided (owner, 2026-11-11, ADR-0036):** download, verify, then open the DMG. Split into M3.2a (check, Settings ›
  Updates, the sidebar notice) and M3.2b (download, SHA-256 check, open the DMG, background download).

### M3.3 Menu bar, login item, notifications

From the design's Settings › General:
- the merged speed in the menu bar, with the new template icon;
- "Open at login";
- "Notify me when a download finishes".

The login item must fit CLAUDE.md's no-`SMAppService`-daemon rule. Electron's login-item API is checked against
its docs before choosing.

### M3.4 Browser extensions

- The design's Settings › Browser extensions: browsers found on this Mac, install, update and on/off state, and the
  capture rules.
- Arc, Brave and Edge get native-messaging manifests next to Chrome's.
- **Safari** (CLAUDE.md): without an Apple Developer account, Safari runs unsigned extensions only while "Allow
  unsigned extensions" is on, and that resets when Safari quits. This is checked against Apple's docs and shown
  honestly in the UI.
- Installing from inside the app is limited by each browser. The Chrome Web Store needs a developer account, which
  is the owner's decision.

### M3.5 Routing rules

- From the design: separate networks for downloads and for uploads, with a fallback switch; upload limits per
  network.
- From CLAUDE.md: link priorities and cost rules, for example keeping a phone's data plan for when it is needed;
  and a sticky-per-site option.

### M3.6 Clipboard monitor

From CLAUDE.md. Offers a copied link in New download.

### M3.7 Diagnostics and history

- From CLAUDE.md: a diagnostics bundle, made on request and never sent anywhere by Mergelane.
- From the design: "Today" totals per network, the fastest merged speed, and dropout history kept across restarts.

### M3.8 Real hardware

The exit criterion: a self-hosted runner, or the local runner, on the owner's Mac. It covers Wi-Fi, iPhone USB and
Ethernet together, unplugging, sleep and wake, and a VPN on and off.

## Owner answers (2026-11-11)

1. **Features the design leaves out are all kept, restyled into the new layout:**
   - the repeating schedule and Usenet go into Settings › Downloads;
   - data caps, the proxy and renaming go into the Networks screen;
   - torrent files and peers go into the details pane;
   - the selection toolbar, the right-click menu, and Open, Show in Finder, Retry, Fix link and Move to Trash stay
     as they work today.
2. **The network colour picker stays.** A colour the user picks overrides the theme's colour for that network, in
   every theme. The theme's colour is the default. The picker's swatches get values that pass contrast in all 14
   colour sets, and saved ids keep working.
3. **Network rows show the connection type only** (for example "Wi-Fi", "Tethered over USB"), not the Wi-Fi name.
   No Location permission is asked for.
4. **Vitest is added** for renderer code, with React Testing Library and V8 coverage, set up from their docs. Changed
   renderer files must reach 90% line coverage. Playwright stays for the end-to-end tests.
