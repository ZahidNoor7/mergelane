# Upstream sources

All three upstreams are MIT. Mergelane does not depend on any of them at runtime. Code is imported once at
a pinned commit, and every Mergelane change is a separate commit on top. This keeps it possible to replay
later upstream fixes.

## Pinned commits

| Upstream | Commit | Date | Licence holder (kept verbatim) | Imported into |
|---|---|---|---|---|
| https://github.com/anmolkapil/plexo | `2e44a2f3e9dbe92ccc5ae8778e4175f889d624d3` | 2026-11-06 | Copyright (c) 2026 Anmol Kapil | `app/`, `extension/` (M1.2) |
| https://github.com/rohit267/net-merge | `2b333a3ad820996ba337588adfa8f7259a45baec` (Release 0.3.7) | 2026-11-09 | Copyright (c) 2026 Rohit Mahto | `daemon/` (M1.3) |
| https://github.com/Ahmadkhattak1/awesome-downloader | `d99dbe0e9edfec1c07bbe735e1a1990323d919bf` | 2026-11-09 | Copyright (c) 2026 Awesome Downloader contributors | Nothing in Phase 1. Ideas and logic only, from Phase 2 (`app/src/main/media/`, `extension/`). |

## How to replay an upstream fix

```sh
# in a clone of the upstream repo
git diff <pinned-sha>..<new-sha> -- <paths> > /tmp/upstream.patch
# in Mergelane
git apply --3way --directory=app /tmp/upstream.patch   # or --directory=daemon
```

After replaying, update the pinned commit above and add a line to the change log below.

## Planned changes against upstream (Phase 1)

Each line becomes an actual entry, with the Mergelane commit, once the change lands.

### Plexo → `app/`, `extension/`

- Rebrand:
  - App id `io.github.zahidnoor7.mergelane`, product name, URL scheme `mergelane://`, `window.mergelane`.
  - `MERGELANE_*` test knobs, `.mergelane` staging suffix, user agent, bridge ping name.
  - Extension name and ids, publish owner and repo.
- macOS arm64 only: removed the Windows and Linux builder targets, x64, NSIS, the sparse-file module, and the
  Windows/Linux branches.
- `electron-builder.yml`:
  - Ad-hoc signing (`identity: "-"`), `minimumSystemVersion: "27.0"`, `notarize: false`.
  - Keep koffi's `darwin_arm64` prebuild.
- `src/main/network/deviceBinding.ts`: pin per-link sockets on darwin with `IP_BOUND_IF` / `IPV6_BOUND_IF` through
  koffi, replacing the `localAddress`-only path.
- Bridge: added `GET /health` (ready signal for packaging tests).
- Updater: auto-install disabled (ADR D10).
- Telegram: decision pending (PHASE-1 Q4).
- `extension/` moved to the repo top level with its own build.

### Net Merge → `daemon/`

- Removed:
  - The Windows and Linux files.
  - The tray, icon, update checker, sudoers installer and LaunchAgent autostart.
  - The systray, netlink and wireguard dependencies.
- New process model: a root LaunchDaemon installed by the app. Commands `run`, `install`, `uninstall`, `cleanup`,
  `status` and `version`.
- New control API: versioned JSON over a Unix socket with a `LOCAL_PEERCRED` uid check. It replaces file-polling
  IPC under `/var/run/net-merge`.
- New VPN guard.
- Routes the daemon adds are marked with `RTF_PROTO2`, and cleanup removes only marked routes.
- Health probing tightened (ADR D8). Probe targets are configurable.

## Change log of imports

| Date | Upstream | From → To | Mergelane commit | Notes |
|---|---|---|---|---|
| — | — | — | — | Nothing imported yet. |
