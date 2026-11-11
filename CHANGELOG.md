# Changelog

All notable changes to Mergelane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-11

The first release: a download manager for Apple silicon Macs on macOS 27 or later that can use every internet
connection the Mac has at once.

### Added

- Downloads split into parts and fetched over several connections, with queues, scheduling, speed limits and
  torrents. The download engine comes from Plexo 1.0.0-rc.15.
- Every network at once: a download can use Wi-Fi, Ethernet and a tethered phone together. Each network's
  connections stay on that network, even while System merge is on.
- System merge, one switch that combines the networks for every app on the Mac:
  - a helper installed once, with an administrator password;
  - it refuses to turn on while another VPN is on, and turns itself off if one appears;
  - if any part of Mergelane stops, the Mac's own internet keeps working;
  - an optional "Turn back on after a crash" setting, off by default;
  - networks that come back after unplugging, sleep or a reconnected phone are checked again from scratch;
  - the last 50 network changes, shown in the app.
- A Dashboard, opened from the downloads list:
  - every unfinished download, the total speed and when all will be done;
  - each network's speed and condition (up, limited, paused by a data limit, no connection);
  - networks that dropped or came back since the app opened;
  - System merge's traffic on each link;
  - the honest limits of combined speed.
- Video downloads from HLS (`.m3u8`) and DASH (`.mpd`) links, with a quality picker, joined into MP4 or MKV. Live and
  protected (DRM) streams are refused.
- YouTube downloads, through yt-dlp only: paste a YouTube link, or use the extension's "Send this video to
  Mergelane". There are no cookies and no sign-in, and protected (DRM) videos, playlists, channels and live streams
  are refused.
- A Chrome extension that hands the downloads you click to Mergelane, and lists the videos a page loads. It talks to
  Mergelane only through Chrome's native messaging, with no open network port. It is not in the Chrome Web Store
  yet: see "Browser extension" in the README.
- Bundled tools, each pinned by checksum, with their licences inside the app:
  - yt-dlp;
  - Deno, yt-dlp's JavaScript runtime;
  - Mergelane's own minimal LGPL build of FFmpeg, which only joins and rewraps media and never re-encodes.
- Every release attaches the source code of these tools, and the script that builds FFmpeg.

### Removed, compared with Plexo

- The Telegram download source. It needed your own Telegram API keys and a sign-in.
- Automatic updates. Without an Apple Developer ID signature, installing an update in place isn't proven safe yet;
  a check for new releases on GitHub comes later (ADR-0010). Until then, download new releases from GitHub.
