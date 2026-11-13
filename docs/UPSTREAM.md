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
- Updater: auto-install disabled (ADR-0010).
- Telegram source removed (owner decision 2026-11-11, superseding ADR-0012; branch `m2.6-remove-telegram`):
  - Deleted `src/main/telegram/`, `src/main/download/telegramTransfer.ts`, `TelegramDialog.tsx` and
    `e2e/telegram.spec.ts`.
  - Removed the Telegram parts of the download manager, transfer, history, shared types, IPC channels and
    contract, preload, IPC handlers, test knobs, renderer store, the Downloads toolbar and empty state, the
    finished-download view, `e2e/fixtures.ts`, and the build-time `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`
    defines in `electron.vite.config.ts`.
  - Dropped the `telegram`, `qrcode`, `big-integer` and `@types/qrcode` dependencies, which only it used.
  - Telegram downloads and history entries saved by an older build are dropped on load, like any saved
    download this version can't restore (`e2e/recovery.spec.ts`).
  - When replaying Plexo fixes, skip changes to the deleted files.
- The extension stays at `app/extension` in Phase 1 (ADR-0014).
- Electron fuses hardened at package time (ADR-0016).
- Removed: Plexo's website (`docs/`), its workflows, the release-notes script and its spec, the website download
  spec, `CONTRIBUTING.md`, `SECURITY.md`, `build/installer.nsh` and `build/icon.ico`.
- Two code comments that named another product's trademark were reworded (`download/plan.ts`).

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
- Health probing tightened (ADR-0008). Probe targets are configurable.
- Ping through the TUN gets the real reply over a link (`internal/tun/icmp.go`, `internal/engine/echo.go`,
  ADR-0062). Upstream passed no `ICMPHandler` to tun2socks, whose own handler answers every IPv4 echo request at
  once for any address.

## Change log of imports

| Date | Upstream | From → To | Mergelane commit | Notes |
|---|---|---|---|---|
| 2026-11-10 | Plexo | — → `2e44a2f` | `ac203ef` | Verbatim import into `app/` (branch `m1.2-app`). |
| 2026-11-10 | Net Merge | — → `2b333a3` | `e3a8aa4` | Verbatim import into `daemon/` (branch `m1.3-daemon`). |
| 2026-11-12 | Net Merge | `2b333a3` (Windows files) | W1b (branch `w1-daemon-builds`) | Re-imported `internal/nics/{counters,egress,info}_windows.go` and `internal/state/replace_windows.go` (comments reworded), and `internal/platform/platform_windows.go` without `RelaunchElevated` and `OpenURL` (tray only), with the mutex renamed `Global\mergelane-daemon`. `internal/tun/tun_windows.go` waits for W5. |
| 2026-11-12 | Net Merge | `2b333a3` (Windows files) | W5 (branch `w5-system-helper`) | Re-imported `internal/tun/tun_windows.go`: the adapter type `Mergelane` with its own GUID, `route` and `netsh` run by their System32 path, the strong-host record kept in the daemon's state folder instead of `%TEMP%`, and the pure strong-host helpers moved to `internal/tun/weakhost.go`. |
| 2026-11-10 | Awesome Downloader | — (logic only) at `d99dbe0` | M2.2 (branch `m2.2-media`) | HLS logic from `core/hls.mjs` rewritten in TypeScript as `app/src/main/media/hls/` (no code copied verbatim); each file credits it. |
| 2026-11-10 | Awesome Downloader | — (logic only) at `d99dbe0` | M2.2 (branch `m2.2-media`) | FFmpeg muxing idea from `core/mux.mjs` rewritten as `app/src/main/media/mux/`; files credit it. |
