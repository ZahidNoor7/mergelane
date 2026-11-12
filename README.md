<p align="center">
  <img src="design-system/mergelane/redesign/brand/png/icon-default-128.png" width="128" height="128" alt="Mergelane app icon">
</p>

# Mergelane

Mergelane is a free, open-source download manager for macOS that can use every internet connection your Mac
has at the same time: Wi-Fi, Ethernet, and a tethered iPhone or Android phone.

- **Downloads:** segmented multi-connection downloads, queues, a schedule, speed and data limits, and pause and
  resume, also across a restart. It handles direct links, torrents (`.torrent` and magnet links), Usenet (`.nzb`,
  with your own news server), HLS and DASH video, and YouTube videos through yt-dlp.
- **Network merging:** Mergelane's own downloads spread their connections across all your networks, and you choose
  which network carries what (Networks › Which network carries what). An optional system-wide mode, **System
  merge**, lets other apps' connections use every network too.
- **Browser extension** for Chrome, Edge, Chromium and Firefox: the downloads you click go to Mergelane, and it lists
  the videos a page plays.
- **Everyday:** a menu-bar speed, Open at login, a notification when a download finishes, offering links you copy (off
  by default), seven themes with Liquid Glass, and updates from GitHub that it downloads and checks for you.

> **Status: beta (0.3.x).** Releases are on the [Releases page](https://github.com/ZahidNoor7/mergelane/releases).
> The Safari extension and the 1.0 hardening come next. See `docs/PROGRESS.md` for the details.

## Requirements

- macOS 27 or later
- A Mac with Apple silicon (M1 or later). Intel Macs are not supported.

## What to expect (honest limits)

- **One connection always uses one link.** Merging adds speed only when something opens several connections
  at once. Mergelane's own downloads do this. In system-wide mode, other apps gain speed only if they open
  several connections themselves; a single video call or a single-connection download will not get faster.
- **In system-wide mode, each website stays on one network** (on by default; Networks › Other apps › Keep each site
  on one network). Every network has its own public address, and a site that sees you arrive from several at once
  may sign you out, ask "are you a robot?", or break a call. So one site gets one network's speed, while different
  sites spread over all of them. Mergelane's own downloads still use every network. Turn it off to spread a site's
  connections too.
- **Connections on a link that drops must reconnect.** New connections move to the remaining links, but a
  connection that was already open on the lost link breaks, as it would without Mergelane.
- **Links must be genuinely separate internet connections.** Two Wi-Fi networks from the same router, or a
  phone tethered to the same Wi-Fi, will not add speed.
- **VPNs come first.** If another VPN is active, system-wide merging stays off (or turns itself off) and tells
  you why. Mergelane never installs its routes over a VPN's. Downloads inside Mergelane keep working where they can.
- **Video:** only what your own browser could play. Protected (DRM) videos, live streams, playlists and channels
  are refused, and Mergelane never uses your cookies or signs in anywhere.
- **No account, no servers, no telemetry.** Everything runs on your Mac, and nothing about you is sent anywhere. Two
  things reach out on their own:
  - Once installed, the system-wide helper checks every 1 to 2 seconds that each network still reaches the
    internet. It opens a connection to Cloudflare's and Google's public addresses (1.1.1.1 and 8.8.8.8, or their
    IPv6 equivalents) and closes it without sending any data.
  - Once a day, the app asks GitHub's public Releases API whether a newer Mergelane is out. GitHub sees your IP
    address and the app's version, nothing else. You can turn this off in Settings › Updates. A new version is
    downloaded from GitHub only when you ask, or by itself if you turn on "Download updates in the background".

The app says the same on its Dashboard, under **About combined speed**, next to the speeds it describes.

## Installing

Mergelane is not yet signed with an Apple Developer ID, so macOS asks you to confirm it once:

1. Download `Mergelane-<version>-arm64.dmg` from the
   [latest release](https://github.com/ZahidNoor7/mergelane/releases/latest).
2. Open the DMG and drag **Mergelane** to **Applications**.
3. Open Mergelane. macOS warns that it cannot verify the app and does not open it. Close the warning.
4. Open **System Settings › Privacy & Security**, scroll to the message about Mergelane, and click **Open Anyway**.
   Confirm with your password or Touch ID.

Alternatively, after step 2, run this in Terminal and then open the app normally:

```sh
xattr -dr com.apple.quarantine /Applications/Mergelane.app
```

Later versions install from inside the app: **Settings › Updates** downloads the new version, checks it, and opens
it for you to drag into Applications. Each release's `SHA256SUMS` lists the checksums of its files.

System-wide merging needs a small helper (`mergelane-daemon`) that runs as a system service. Mergelane asks for
your administrator password once to install it. When an app update brings a newer helper, the sidebar says so and
**Update…** installs it, with your password again. To remove the helper, with its routes, run
`sudo /Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon uninstall` in Terminal.

### Helper commands

The helper can also be driven from Terminal. It is installed as
`/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon`; the commands below call it
`mergelane-daemon`. Only you (the user who installed it) and root can talk to it.

| Command                                    | What it does                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `mergelane-daemon status`                  | Shows whether system merge is on, and why not if it is off                                    |
| `mergelane-daemon on` / `off`              | Turns system merge on or off                                                                  |
| `mergelane-daemon links` / `stats`         | Lists the networks it uses, and live traffic per network                                      |
| `mergelane-daemon events`                  | Shows the last 50 network changes (a network lost, back, or failing its check)                |
| `mergelane-daemon auto-resume on` / `off`  | Whether merging turns itself back on after the helper crashes (off by default)                |
| `mergelane-daemon sticky-sites on` / `off` | Whether each website stays on one network (on by default)                                     |
| `sudo mergelane-daemon cleanup`            | Removes any routes Mergelane left behind. Use it if your internet stops working after a crash |
| `sudo mergelane-daemon uninstall`          | Removes the helper, its system service and its routes                                         |

After a crash the helper starts with merging off, unless you turned auto-resume on. After a restart of the Mac or
an update of the helper, merging always starts off, and Mergelane turns it back on if it was on before an update.

## Browser extension (Chrome, Edge, Chromium, Firefox)

The extension hands downloads you click in your browser to Mergelane. It talks to Mergelane only through the
browser's native messaging, so there is no open network port, and Mergelane registers itself with each browser
when it starts.

The extension comes inside Mergelane. Until it is in the browsers' stores, you load it by hand once:
**Settings › Browser extensions** finds your browsers. **Install…** saves the extension in a folder you can find:
your Downloads folder, or another you choose with **Change…**. It then walks you through loading it, with buttons
to show the folder in the Finder, open the browser, and copy what to paste. Keep that folder: the browser loads the
extension from it, and Mergelane keeps it up to date. No browser lets another app pick the folder for you, so
choosing it in the browser stays one step of your own.

- **Chrome, Edge and Chromium:** turn on Developer mode on the browser's extensions page, click **Load unpacked**,
  and choose the folder. After a Mergelane update, restart the browser to use the new version.
- **Firefox:** load it as a temporary add-on from `about:debugging`. Firefox keeps an extension Mozilla hasn't
  signed only until it quits, so load it again after a restart.
- **Brave and Vivaldi** don't document where they look for Mergelane's helper, so they aren't supported yet.
  **Safari** needs its own kind of extension, which comes later.

**What it sends** is set once for every browser, in the same screen: sending on or off, a minimum size (1 MB by
default), the file types (by default video, archives, disk images, apps, and any type Mergelane doesn't recognise),
and whether to list the videos on a page. Mergelane checks each download against these rules itself.

To build it yourself instead: `cd app && npm ci && npm run build:extension`, then load `app/extension/dist/chrome`.

You can also paste any direct download link into **New download** without the extension.

## Building from source

You need a Mac with Apple silicon and macOS 27, Node.js 22, Go 1.27 and the Xcode command line tools.

```sh
cd app
npm ci
npm run fetch:media-tools   # yt-dlp and Deno, checked against pinned SHA-256s; builds FFmpeg from source
npm run dev                 # runs the app from source
```

`npm run build:mac` builds the app and the DMG into `app/dist`. A full release build, with the helper, the extension
and every check, is `node scripts/release/local-release.mjs`: see `docs/RELEASING.md`.

Tests: `npm run test:unit` (Vitest) and `npm run test:e2e:smoke` (Playwright for Electron) in `app/`, and
`go test -race ./...` in `daemon/`. The real-hardware suite, which uses your actual networks, is in
`docs/HARDWARE.md`.

## Project documents

- `docs/PROGRESS.md`: what is done, in progress and next
- `docs/PHASE-3.md`: the current plan (Phase 1 and 2 plans: `docs/PHASE-1.md`, `docs/PHASE-2.md`)
- `docs/DECISIONS.md`: architecture decisions
- `docs/RELEASING.md`: how a release is built and published
- `docs/HARDWARE.md`: the real-hardware tests
- `docs/MEDIA-TOOLS.md`: yt-dlp, Deno and FFmpeg, and how they are pinned and built
- `docs/BROWSER-BRIDGE.md`: how the browser extension talks to the app
- `docs/UPSTREAM.md`: the open-source projects Mergelane builds on, and the exact versions imported

## Licence

MIT. See `LICENSE`. Mergelane builds on the MIT-licensed projects Plexo, Net Merge and Awesome Downloader; their
notices are in `THIRD-PARTY-NOTICES.md`. The app bundles yt-dlp (GPL 3 as built), Deno (MIT) and an LGPL
build of FFmpeg as separate programs. Their licences are in `THIRD-PARTY-NOTICES.md` and inside the app, and every
release attaches their source.
