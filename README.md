# Mergelane

Mergelane is a free, open-source download manager for macOS that can use every internet connection your Mac
has at the same time: Wi-Fi, Ethernet, and a tethered iPhone or Android phone.

- **Downloads:** segmented multi-connection downloads, queues, scheduling, browser capture and torrents.
  Video sites (YouTube, HLS, DASH) are planned.
- **Network merging:** Mergelane's own downloads spread their connections across all your links. An optional
  system-wide mode lets other apps' connections use all links too.

> **Status: early development (Phase 1, proof of concept).** There is no release to install yet. See
> `docs/PROGRESS.md` for what works today.

## Requirements

- macOS 27 or later
- A Mac with Apple silicon (M1 or later). Intel Macs are not supported.

## What to expect (honest limits)

- **One connection always uses one link.** Merging adds speed only when something opens several connections
  at once. Mergelane's own downloads do this. In system-wide mode, other apps gain speed only if they open
  several connections themselves; a single video call or a single-connection download will not get faster.
- **Connections on a link that drops must reconnect.** New connections move to the remaining links, but a
  connection that was already open on the lost link breaks, as it would without Mergelane.
- **Links must be genuinely separate internet connections.** Two Wi-Fi networks from the same router, or a
  phone tethered to the same Wi-Fi, will not add speed.
- **VPNs come first.** If another VPN is active, system-wide merging stays off (or turns itself off) and tells
  you why. Mergelane never installs its routes over a VPN's. Downloads inside Mergelane keep working where they can.
- **No account, no servers, no telemetry.** Everything runs on your Mac. The only network request Mergelane makes
  on its own is the update check against GitHub Releases.

The app says the same on its Dashboard, under **About combined speed**, next to the speeds it describes.

## Installing (once a release exists)

Mergelane is not yet signed with an Apple Developer ID, so macOS asks you to confirm it once:

1. Download `Mergelane-<version>-arm64.dmg` from the GitHub Releases page.
2. Open the DMG and drag **Mergelane** to **Applications**.
3. Open Mergelane. macOS warns that it cannot verify the app and does not open it. Close the warning.
4. Open **System Settings › Privacy & Security**, scroll to the message about Mergelane, and click **Open Anyway**.
   Confirm with your password or Touch ID.

Alternatively, after step 2, run this in Terminal and then open the app normally:

```sh
xattr -dr com.apple.quarantine /Applications/Mergelane.app
```

System-wide merging needs a small helper (`mergelane-daemon`) that runs as a system service. Mergelane asks for
your administrator password once to install it. You can remove it from Mergelane's settings at any time.

## Browser extension (Chrome)

The extension hands downloads you click in Chrome to Mergelane. It talks to Mergelane only through Chrome's native
messaging, so there is no open network port, and Mergelane registers itself with Chrome when it starts. Until the
extension is published, load it by hand:

1. Build it: `cd app && npm ci && npm run build:extension`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
   `app/extension/dist/chrome`.
3. Open Mergelane once, so Chrome learns where to find it. After that the extension's icon shows whether it's
   connected.

You can also paste any direct download link into **New download** without the extension.

## Building from source

Build instructions will be added with the first app milestone (see `docs/PHASE-1.md`).

## Project documents

- `docs/PHASE-1.md`: current plan
- `docs/PROGRESS.md`: what is done, in progress and next
- `docs/DECISIONS.md`: architecture decisions
- `docs/UPSTREAM.md`: the open-source projects Mergelane builds on, and the exact versions imported

## Licence

MIT. See `LICENSE`. Mergelane builds on the MIT-licensed projects Plexo, Net Merge and Awesome Downloader; their
notices are in `THIRD-PARTY-NOTICES.md`.
