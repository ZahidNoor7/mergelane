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

The artifact's `notes.md` and `tokens-proposal.css` describe an earlier draft (five themes, ink-only actions) and are
deliberately not copied.

## Changes the owner made after the design was final

| Date | Theme and mode | Seed | Design | Now | Why |
|---|---|---|---|---|---|
| 2026-11-11 | Dusk, light | `sidebarCard` | `#3A3456` | `#353050` | The faintest sidebar text on a card reached only 4.26:1 (WCAG asks 4.5:1); it now reaches 4.56:1. |

`app/src/renderer/src/theme/contrast.test.ts` applies these to the design's values before comparing them with
`app/src/shared/themes.ts`, so any other difference still fails.
