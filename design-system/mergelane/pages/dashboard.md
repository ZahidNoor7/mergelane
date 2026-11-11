# Dashboard

> Overrides `../MASTER.md` only where it says so. The layout follows the final design's Dashboard
> (`../redesign/prototype.html`, `DashboardScreen`). It is rebuilt in M3.1 pull request 6. Until then the screen in
> `app/src/renderer/src/screens/DashboardScreen.tsx` keeps its M2.3 layout with the new colours and fonts.

## What the page is for

One place that answers, at a glance:
- what is downloading, and how fast;
- what each network is doing, and whether one dropped;
- what Mergelane itself costs the Mac.

It is reached from the sidebar, where it is the first place. The app opens on Downloads (ADR-0034).

## Layout, top to bottom

1. **The Confluence:** every network's lane merging into the total.
2. **Last minute:** the stacked throughput chart by network, with its legend.
3. **Today:** bytes per network, the fastest merged speed, and network dropouts (for example "2, all back").
4. **Downloading:** every unfinished download with its split bar. A row opens it in Downloads.
5. **Mergelane on this Mac:** CPU (as Activity Monitor counts it: 100% is one full core) and memory, a one-minute CPU
   sparkline in ink, and a table by part: downloads engine, app window, graphics, system merge helper, video tools.

Two columns when the content is at least `@3xl` wide; one column below.

## Rules that stay from M2.3

- Text never takes a network's colour. Healthy states use secondary ink with an icon.
- Live numbers are not live regions. Network dropouts are a polite `role="log"`, so a drop is announced once.
- The honest limits of combined speed ("About combined speed") stay on the Dashboard.
- Every empty state says what to do:
  - nothing downloading: how to start one;
  - no network: connect one;
  - one network: there is nothing to fail over to;
  - helper not installed: what system merge needs.

## Data the design needs that the app adds

- **"Today" totals and the fastest merged speed** are kept across restarts, with a daily rollover. Until that exists
  (M3.7), the section shows only what is known since the app opened, and says so.
- **CPU and memory:** from Electron's `app.getAppMetrics()` (`cumulativeCPUUsage` over the interval, so 100% is one
  core), plus a new optional status field in which the helper reports its own usage (protocol v1, additive). Built
  in M3.1 pull request 6.
