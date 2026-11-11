# Mergelane design system

> **How to use this file:** when building a screen, read this file, then `pages/<screen>.md` if it exists. A page
> file overrides this one only where it says so.

- **Source of truth:** the owner's final design, `design-system/mergelane/redesign/prototype.html` (ADR-0034,
  declared final 2026-11-11). This file states its rules in words. When the two disagree, the prototype wins, except
  for the owner's later changes listed in `redesign/README.md`.
- **In code:** colours in `app/src/shared/themes.ts` (seeds) and `app/src/renderer/src/assets/main.css` (everything
  derived), fonts in `app/src/renderer/src/assets/fonts/`.
- **Status:** M3.1 builds it in seven pull requests (`docs/PHASE-3.md`). Screens not yet rebuilt still use the old
  layout with the new colours and fonts.
- **Replaces:** the Plexo-era system (graphite with amber, Manrope and Roboto Mono, a hero band), retired by
  ADR-0034.

---

## The idea

Mergelane is named for a merge lane. **Each network is a lane drawn as thick as its speed, and the lanes merge into
one road** whose width is the merged speed. That diagram (the Confluence) is the one memorable element. It heads the
download list, a download's details and the dashboard. Lane markings drift along a lane only while it carries bytes.
Everything around it stays quiet: a Mac-style window with a sidebar, a list and a details pane.

## Colour

### Themes

There are seven themes, each with a light and a dark version: **Porcelain** (the default), Sandstone, Graphite,
Sage, Dusk, Liquid Glass and High contrast.
- Light, Dark or Auto (follow the Mac) is a separate choice. Auto is the default on a new install.
- A theme is a handful of **seeds** per mode, in `shared/themes.ts`:
  - grounds: `desk`, `window`, `sidebar`, `sidebarCard`, `bg`, `card`;
  - ink: `text`, plus `sidebarInk` when the sidebar is dark in light mode (Graphite, Dusk);
  - one accent: `accent`, `accentOn`, and `accentInk` where the accent differs as text (Liquid Glass);
  - three network colours: `wifi`, `usb`, `ethernet`, and `netOn` for glyphs drawn on them;
  - optional strengths: `line`, `lineSubtle`, `lineStrong`, `ink2`, `ink3`, which High contrast and Liquid Glass
    raise.
- **Everything else is derived** in `main.css` with `color-mix(in oklab, …)`. Components use only derived tokens,
  never a raw hex.

| Token | Derived as |
|---|---|
| `--text-secondary`, `--text-tertiary` | ink at `--ink-2` (76%) and `--ink-3` (63%) into the ground |
| `--border`, `--border-subtle`, `--border-strong` | ink at `--line` (14%), `--line-subtle` (8%), `--line-strong` (34%). Decorative only. |
| `--control` | ink 52% into the ground: the edge of a field, checkbox or switch (at least 3:1) |
| `--sunken`, `--bg-tertiary`, `--track-bg` | ink 4.5%, 5% and 10% into the ground: wells, secondary fills, empty tracks |
| `--hover`, `--selected` | accent 6% and 15% into the ground |
| `--focus`, `--switch-on` | the accent |
| `--color-<network>-bg`, `-border`, `-text` | the network colour 14% and 40% into the ground; 60% into the ink for text |

- `.ml-surface` re-grounds a region on the sidebar's seeds. A dark sidebar in a light theme then gets its own
  hovers, lines and ink.
- Theme changes ease every colour for 220 ms, with no movement, so this runs under Reduce Motion too.

### What colour means

- **A network's colour is its identity:** lanes, split bars, chunks, chart fills, tiles. A network keeps its colour
  everywhere within a theme. The user may pick a colour for a network (the swatches in `main.css`); a pick overrides
  the theme's colour in every theme.
- **Text never takes a network's colour** (except the legacy `-text` tokens, mixed toward the ink for 4.5:1).
- **The accent** marks the primary action, the selection, focus and switches that are on.
- **States** keep one meaning in every theme:
  - `--color-danger`, plus an icon and a word, means something needs action now;
  - `--color-warning` means it needs action soon, though nothing is broken (for example, the helper is out of
    date);
  - healthy states are secondary ink with an icon, never green.

### Contrast (enforced)

`app/src/renderer/src/theme/contrast.test.ts` checks all 14 colour sets against WCAG 2:
- text, secondary and tertiary text: at least 4.5:1 on the ground, cards and the sidebar;
- controls, network colours, the accent and swatches: at least 3:1;
- text on the accent: at least 4.5:1;
- danger and warning: at least 4.5:1.

A theme that fails does not ship.

## Type

| Role | Font | Notes |
|---|---|---|
| Words: headings, labels, body | **Archivo**, variable (`wght` 100–900, `wdth` 62–125) | Weights 540 to 720 carry the hierarchy. |
| Every figure: speeds, sizes, percentages, counts, times | Archivo through the **`figures`** utility | `font-stretch: 76%; font-variant-numeric: tabular-nums`, like a road sign's numerals. A ticking number never moves its neighbours. |
| Identifiers: `en0`, hosts, paths, links, shortcut hints | **Fragment Mono** | Only for things you would type or copy. |
| The wordmark "Mergelane" | Saira 600 | Only in Settings › Updates and About. Bundled when first used (M3.2). |
| Liquid Glass | the system font (SF Pro) | That theme's look. Figures stay tabular at normal width. |

- **Bundled offline.** No font is ever fetched (CLAUDE.md). Licences are in `assets/fonts/` and
  `THIRD-PARTY-NOTICES.md`.
- **Sentence case everywhere.** There are no tracked all-caps labels; section titles are short sentence-case
  headings.

## Layout

- **Window:**
  - the sidebar (236 px) holds the places (Dashboard, Downloads, Networks), each network's live speed, the merged
    total, free space, Slow mode and Settings;
  - then the content, with its own toolbar. There is no title bar, status bar or hero band.
- **Breakpoints follow the window's width, not the screen's:**
  - below 760 px, a compact bar (merged speed, settings, the places as a segmented control) replaces the sidebar;
  - when the content area is at least 860 px, a selected download's details sit beside the list (400 px).
    Otherwise they replace the list, with a back button;
  - below 520 px, "New download" becomes an icon button with a label for assistive tech;
  - New download is a sheet. From 640 px it drops from the toolbar; below that it rises from the bottom;
  - in Settings, the section list sits on the side from 620 px of its own width, and becomes a segmented row below.
- **The minimum window** stays 720 × 620.
- **Alignment:** left aligned; one scrolling column per pane.

## Shapes and depth

- **Radii:** 6, 8, 12 and 16 px (`--radius-sm` to `--radius-xl`). Panels and cards are 12 px. **Controls that act are
  capsules**: buttons, fields, segmented controls, chips.
- **Lines before shadows.** Shadows only lift what floats: the sheet (`--shadow-sheet`), popovers, and a raised
  control (`--shadow-raise`).
- **The scrim** (`--scrim`) sits only behind the modal sheet.

## Components

Rebuilt from the prototype's components, on the Base UI primitives in `components/ui/`:

| Component | Rule |
|---|---|
| **Button** | Variants primary (the accent), secondary, ghost and destructive. A capsule. Pressed: scale 0.96 for 100 ms. |
| **Switch** | 38 × 22. The knob widens while held. On uses the accent, never a network colour. |
| **Segmented** | A capsule group of pressed-state buttons with counts. It replaces drop-down filters. |
| **Confluence** | Lanes as thick as their speed, merging at 60% of the width. Dropped lanes are dashed in danger. Thickness eases to new readings (τ 0.16 s); markings stop when idle or under Reduce Motion. |
| **Chunk map** (LaneMap) | Capsule dashes coloured by the network that fetched each chunk. One focusable group: arrow keys, Home and End, with a polite readout ("Chunk 42 of 97: fetched over Ethernet"). |
| **Split bar** | A download's progress split by network share, 6 px, with 2 px gaps. |
| **Throughput chart** | 60 seconds stacked by network, with a total line in ink. Focusable; arrow keys move the readout. |
| **Network row** | A tinted tile with the network's icon, its name and interface, its state in words, limits, a sparkline, speed and a "Use for downloads" switch. |
| **Sheet** | In 320 ms (`cubic-bezier(0.2, 0.9, 0.25, 1)`), out 200 ms along the same path. Focus is trapped and returns to the trigger. Escape or the scrim closes it. |

## Motion

- **Motion answers an action.** Nothing animates on its own except the Confluence's lane markings while bytes flow.
- **Press feedback** comes on pointer-down, in 100 ms.
- **Reduce Motion:** slides become 150 ms fades; lane markings, springs and smooth scrolling stop; colour fades stay.
  The prototype misses this in two places, and the app must not: the switch knob's slide, and the smooth scroll from
  Settings to Networks.

## Liquid Glass

The Liquid Glass theme adds a material: a translucent sidebar, toolbar controls and sheets over the desktop.
- **The material:** Electron's window material (`vibrancy`), not a painted wallpaper.
- **Lists and cards:** the design's own text says they stay on solid ground, but its CSS gives them a translucent fill.
  Pull request 7 settles this with the owner.
- **Accessibility settings:**
  - Reduce Transparency, from the Mac (`nativeTheme.prefersReducedTransparency`) or the in-app switch, makes every
    layer solid;
  - Increase Contrast thickens fills and lines.
- **Its graphics cost** is measured with "Mergelane on this Mac" before it ships (M3.1 pull request 7).

## Accessibility

- The contrast floors above, tested.
- Focus: a visible 2 px ring in `--focus` with a 2 px offset on every control.
- Every state has a word or an icon as well as a colour.
- Icons are Lucide only, with no emoji; an icon-only button has a label.
- Live numbers are not live regions. Changes worth announcing once, such as a dropped network, go in a polite
  `role="log"`.

## Copy

Plain verbs, sentence case and no jargon, as the prototype's strings do.
- An action keeps its name through the flow ("Remove from list", then "Remove").
- Empty states say what to do next.
- Errors say what happened and how to fix it.
- Typography: typographic apostrophes (’), the ellipsis character (…) and the › separator in paths such as
  "Settings › Appearance".

## Do not

- No hero band, no tracked uppercase or mono section labels, no gradient decoration.
- No network colour on text, and no green for "healthy".
- No `cursor: pointer`: it's a desktop app, so controls keep the arrow.
- No fonts, images or scripts loaded from the internet.
- No control that has nothing behind it: a feature's screen ships with the feature (ADR-0034).

## Before a screen is done

1. It matches the prototype in all seven themes, in light and dark (the contrast test passes).
2. Keyboard: every control is reachable, has a visible focus ring and a sensible order.
3. Reduce Motion, Reduce Transparency and Increase Contrast each change what they should.
4. It works at 720 px wide and in the compact bar below 760.
5. Unit tests cover 90% of the changed lines (Vitest); Playwright specs updated for any changed text.
