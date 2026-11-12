# The 2026 redesign: final design

The owner's final design for Mergelane's new look, declared final on 2026-11-11 (ADR-0034). It is the reference for
milestone M3.1 in `docs/PHASE-3.md`.

- `prototype.html` is a copy of the claude.ai artifact "Mergelane Redesign", version `1794387759-a310`
  (SHA-256 `73d0e63ee27cff344955a3c7fd4078239d4db7c056aa79672c1bb2d5564eaeaa`).
  - It is a single-file React prototype with simulated data. Open it in a browser. It loads React, Tailwind's
    browser build, lucide and Babel from public CDNs, and its fonts from Google Fonts. The app bundles everything
    offline instead.
  - It is a design reference, not app code. Parts that only make the prototype run are not ported: the CDN
    builds, the `createLucideIcon` and zustand-shaped stand-ins, plain buttons in place of Base UI, the simulated
    data and timers, the prototype controls and the identity section.
- `brand/` holds the new app icon (default and light) as SVG and PNG, the menu-bar template icon and the marks.
  - In the app (M3.1 pull request 2): `app/build/icon.icns`, from `icon-default` (all ten iconset sizes, built with
    `iconutil`); `app/build/icon.png` and `app/resources/icon-dark.png` at 512 px; and
    `app/resources/trayTemplate.png` and `trayTemplate@2x.png` (set to 144 dpi) for the menu-bar item in M3.3.
  - Settings › Updates shows `app/src/renderer/src/assets/brand/icon-128.png`, a copy of `icon-default-128.png`.
  - The browser extension (2026-11-12): `app/extension/icons/icon-128.png` and `icon-32.png` are copies of
    `icon-default-128.png` and `icon-default-32.png`; `icon-16.png` and `icon-48.png` are scaled from
    `icon-default-1024.png` (ImageMagick, Lanczos). `icon-off-16.png` and `icon-off-32.png`, shown while the extension
    isn't capturing or can't reach Mergelane, are those in grey at 55% opacity.
  - `app/src/shared/brandIcons.test.ts` keeps all of these on the design's files.
  - The light icon variant is not used yet: macOS's light, dark and tinted app-icon variants need checking against
    Apple's and electron-builder's docs first.

The artifact's `notes.md` and `tokens-proposal.css` describe an earlier draft (five themes, ink-only actions) and are
deliberately not copied.

## Changes the owner made after the design was final

| Date | Theme and mode | Seed | Design | Now | Why |
|---|---|---|---|---|---|
| 2026-11-11 | Dusk, light | `sidebarCard` | `#3A3456` | `#353050` | The faintest sidebar text on a card reached only 4.26:1 (WCAG asks 4.5:1); it now reaches 4.56:1. |

`app/src/renderer/src/theme/contrast.test.ts` applies these to the design's values before comparing them with
`app/src/shared/themes.ts`, so any other difference still fails.
