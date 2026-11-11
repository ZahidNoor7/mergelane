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
