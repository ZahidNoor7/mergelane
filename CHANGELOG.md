# Changelog

All notable changes to Mergelane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The new look begins (ADR-0034):
  - new colours, from the Porcelain theme, the first of seven themes;
  - new fonts, Archivo and Fragment Mono, bundled in the app.
  - The other themes can be chosen once the Settings screen arrives.
- A new app icon: the blue Mergelane mark on a charcoal tile.
- Buttons, switches, fields, checkboxes, tags, menus and dialogs take the new look: capsule controls and a clearer
  focus outline.
- The chunk map, the download list's progress bars and the speed charts take the new look. The chunk map and the
  speed chart can be read with the keyboard: focus them and use the arrow keys.
- The Confluence replaces the old combine diagram and "TOTAL SPEED": each network is a lane as thick as its speed,
  merging into one road beside the merged speed. Its markings drift only while bytes flow, and stop under Reduce
  Motion. Its words are in sentence case ("Merged speed", "2.0× faster than Wi-Fi alone", "Last minute").
- A sidebar replaces the title bar and the status bar. It holds the places (Dashboard and Downloads, with how many
  downloads are in progress), every network with its speed or "Out", the merged speed, slow mode, free space,
  updates and the schedule. In a window narrower than 760 points, a compact bar at the top takes its place.
- The window opens at 1040 × 720 and can be made as narrow as 720 points.
- The Dashboard button in the download list and the Dashboard's "Downloads" back button are gone: the sidebar or
  the compact bar now moves between them.
- The download list takes the new design:
  - a title with what's running, and a search field;
  - the Confluence of every network above the list;
  - status tabs with counts (All, In progress, Finished, Needs attention), which replace the status menu;
  - new rows with a file-type icon, tags for torrents, Usenet and video links, and the progress in plain words.
  - Queued downloads are now listed as "Waiting".
- A download's details now sit beside the list in a pane, as in the design, when the window is wide enough. In a
  narrower window they take the list's place, with a "Downloads" button back. The pane replaces the three separate
  download screens and keeps everything they showed: the speed on each network, the numbers, the last minute, each
  network with its switch, streams and peers, the chunk map, a torrent's files and trackers, a Usenet download's
  server and notes, and a failed download's reason and link.
- Mergelane opens at 1280 × 800, the design's size, or smaller to fit the screen.
- New download is now a sheet that slides down from the top of the window, as in the design. Its fields sit in
  labelled rows (Link, Quality, Networks, Streams, Save to). A video's qualities are listed with their sizes, each
  network shows its tile and a checkbox, and the link says where it comes from (Torrent, Usenet, HLS, DASH,
  YouTube).
- A Networks place in the sidebar replaces the networks menu. It lists every network with its connection type,
  what it's doing, its speed and data limits, its last minute and its speed, with a switch for whether new
  downloads use it. System merge and the recent network dropouts are on it too, and Speed & data limits opens
  from it.
- A network's colour can be set back to the theme's colour.
- The Dashboard takes the new design: the Confluence and the last minute at the top, then Today (what Mergelane
  downloaded today, by network, with the fastest download and the network dropouts) beside what's downloading.
  Its sections have the new sentence-case headings.
- The Dashboard shows "Mergelane on this Mac": how much CPU and memory Mergelane itself uses, in all and for the
  app, the system-merge helper and the video tools (yt-dlp, FFmpeg, Deno), as Activity Monitor counts them, with
  the last minute of CPU.
- A Settings screen (⌘, or the sidebar's foot) with General (speed units, slow mode, total speed), Appearance
  (Auto, Light or Dark, and the seven themes with previews) and Downloads (where downloads go, how many run at
  once, the schedule, the news server, and a way to each network's limits). The units and theme buttons leave the
  sidebar.
- Filters for the download list: by date added (today, yesterday, the last 7 or 30 days, or a custom range) and by
  file type (documents, images, videos, audio, archives, disk images, applications). Each choice shows how many
  downloads it would leave, and the filters that are on show as chips you can remove.

### Fixed

- Two networks of the same kind, or a network with no known kind, could get colours that look alike (for example,
  two teals in the Porcelain theme). An extra network now skips colours close to the theme's network colours.
- On a new install, Mergelane follows the Mac's light or dark appearance. A light or dark choice you made before
  stays.

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
