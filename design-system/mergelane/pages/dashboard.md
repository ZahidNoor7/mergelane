# Dashboard Page Overrides

> **PROJECT:** Mergelane
> **Generated:** 2026-11-10 23:39:13, then written up for M2.3
> **Page Type:** Dashboard / Data View
>
> **IMPORTANT:** Rules in this file **override** the Master file (`design-system/mergelane/MASTER.md`), whose
> "Reconciliation" section already overrides its generated values. Only deviations are documented here.

---

## What the page is for

One place that answers, at a glance: what is downloading and how fast, what each network is doing, whether a
network dropped and what happened to the traffic, whether system-wide merging is on (and why not), and what
combined speed can and can't do. Implemented in `app/src/renderer/src/screens/DashboardScreen.tsx`.

## Layout (default window 760×640, minimum 720×620)

```
┌ ‹ Downloads │ Dashboard ─────────────────────────────────────────────┐  header (h-12), like a download's screen
├ hero band ─────────────────────────────────────────────────────────────┤
│ [combine diagram: every network → one stream]  TOTAL SPEED  [throughput │  the one memorable element:
│                                                 12.4 MB/s    chart, all │  the same instrument a download's
│                                                 ACTIVE 2 · DONE IN 1m  │  screen opens on, for everything
├────────────────────────────────────────────────────────────────────────┤
│ DOWNLOADING 2                                           1 queued       │  rows: name, speed, network-colored
│ ubuntu.iso ……………………………………………………………………………… 4.1 MB/s       │  progress, "42% · 1.2 of 3 GB · 1m left"
│ NETWORKS 3                    │ FAILOVER                               │  side by side from 900px
│ ● Wi-Fi  en0   Up    3.2 MB/s │ All 3 networks are up.                 │
│ OTHER APPS                                                             │  system merge (SystemMergeSection,
│ [System merge  ◯]  per-link charts while on                            │  embedded as-is) + per-link charts
│ ABOUT COMBINED SPEED   four plain statements (2 columns from 900px)    │  the honest limits, always shown
└────────────────────────────────────────────────────────────────────────┘
```

- Left aligned; one scrolling column under a fixed header and hero; 20px side gutters (the list's).
- Section labels use the list screen's group label (mono, 10.5px, tracked, uppercase) so the two screens read as
  one app. Statements and empty states are sentence case.
- No cards with shadows. Sections are separated by the list's hairline label rule; the system merge control sits
  in one bordered well because it is a control surface (it came from the networks popover).

## Type

- Header title 15px Manrope semibold, -0.01em. Row titles 13.5–14px medium. Body 12.5px, leading 1.6.
- Figures in Roboto Mono with `tabular-nums` where they line up (row speeds, axis ticks); the hero figure keeps
  the existing BigStat treatment.

## Color

- Network hue = identity only (dots, progress segments, chart fills). Text never takes a network's color.
- `--color-danger` + an icon + a word for states that need action (no connection, paused by a data limit,
  can't reach the server, link without internet). Healthy states use secondary ink with an icon.

## Motion and live data

- Nothing enters with motion. Rows give instant press feedback (100ms background change).
- Live numbers are not live regions (they would be read every second). New failover events are a polite
  `role="log"`, so a dropped network is announced once.
- Reduced motion: the global rule in `main.css` stops the combine diagram's flow and every transition.

## Empty states (each says what to do)

- Nothing downloading: how to start one (paste, drop, New download).
- No network: join Wi-Fi, plug in Ethernet or tether a phone; Scan again / Network settings.
- One network: nothing to fail over to; connect a second.
- Helper not installed: SystemMergeSection's own install prompt, plus a line saying downloads don't need it.
