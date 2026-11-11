# Changelog

All notable changes to Mergelane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- By default the extension now sends Mergelane only files over 1 MB that are videos, archives, disk images, apps
  or of a type Mergelane doesn't recognise. Documents, images and audio stay with the browser unless you tick them in
  Settings › Browser extensions.

### Added

- Settings › General › Troubleshooting › Save Diagnostics… (also in the app menu) saves a zip to attach to a GitHub
  issue: Mergelane's and macOS's versions, your Mac's networks, settings and recent downloads, and the helper's
  log. Links keep only their site, file names only their type, and passwords, cookies, proxy and news-server
  sign-ins, your home folder and public IP addresses are left out. Mergelane never sends it anywhere.
- The Dashboard's Today shows the fastest merged speed of the day, and the network dropouts of the last 24 hours.
  Dropouts and the fastest speed are now kept when Mergelane quits, for a week, and a network that came back
  while Mergelane was closed says so.
- Settings › Updates shows your version, checks GitHub for a newer Mergelane on request and once a day, and shows
  what's new in it. Choose the Stable or Beta channel, skip a version, or turn automatic checks off.
- "Download and install" downloads the new version's disk image, with progress and Cancel, and checks it against
  the SHA-256 published with the release. "Quit and install" then opens it and quits Mergelane, so you drag the
  new version over the old one. Turn on "Download updates in the background" to have it download by itself;
  installing always waits for you.
- Networks › Which network carries what: send every download over one network (Ethernet, say), the running ones
  included, or over all of them as before. Choose whether the other networks stand in when the chosen one drops,
  or downloads wait for it.
- Settings › Browser extensions shows when each browser's extension last reached Mergelane and its version, and
  says when to restart a browser to use a newer one. "What the extension does" sets the rules once for every
  browser: whether to send downloads, a minimum size, the file types, and whether to list a page's videos.
- Settings › Browser extensions finds Chrome, Edge, Chromium and Firefox on your Mac and guides you through
  loading the Mergelane extension in each. The extension now comes inside Mergelane, so you no longer build it
  yourself, and Microsoft Edge is supported. Brave, Vivaldi and Safari are listed with what they still need.
- Mergelane in the menu bar: its icon, and the merged speed beside it while downloads run, in the units you chose.
  Turn it off in Settings › General › On this Mac.
- Open at login (Settings › General › On this Mac), off until you turn it on. Opened at login, Mergelane starts
  in the menu bar without its window. If macOS doesn't accept it or wants your approval, the setting says so and
  tells you where to add Mergelane yourself.
- "Notify me when a download finishes" turns the finished-download notification off or on.
- A notice in the sidebar, and a dot on Settings, when a new version is out. The app menu has "Check for
  Updates…".

## [0.2.0] - 2026-11-11

A new look for the whole app: seven themes, a sidebar, download details beside the list, a Networks screen and a
Settings screen. Downloads, torrents, video and System merge work as in 0.1.0.

### Added

- Seven themes, each with a light and a dark version: Porcelain, Sandstone, Graphite, Sage, Dusk, Liquid Glass and
  High contrast. Appearance can be Auto (follows the Mac), Light or Dark.
- Liquid Glass draws the window in macOS's own glass material. Settings › Appearance offers a Clear or Tinted look
  and Reduce transparency. Mergelane also follows Reduce Transparency and Increase Contrast from the Mac's
  Accessibility settings.
- A Settings screen (⌘, or the foot of the sidebar):
  - General: speed units, slow mode and total speed.
  - Appearance: Auto, Light or Dark, and the themes with previews.
  - Downloads: where downloads go, how many run at once, the schedule, the news server, and a link to each
    network's limits.
- A Networks screen. It lists every network with:
  - its connection type and what it's doing;
  - its speed, its data limits and its last minute;
  - a switch for whether new downloads use it.

  System merge and recent network dropouts are there too.
- Filters for the download list:
  - by date added: today, yesterday, the last 7 or 30 days, or a custom range;
  - by file type: documents, images, videos, audio, archives, disk images and applications.

  Each choice shows how many downloads it would leave. Filters that are on show as chips you can remove.
- "Mergelane on this Mac" on the Dashboard: how much CPU and memory Mergelane uses, as Activity Monitor counts it.
  It shows the total and each part (the app, the System merge helper, and the video tools yt-dlp, FFmpeg and Deno),
  with the last minute of CPU.
- "Today" on the Dashboard: what Mergelane downloaded today, by network, with the fastest download and the network
  dropouts.
- A network's colour can be set back to the theme's colour.
- The chunk map and the speed chart can be read with the keyboard: focus them and use the arrow keys.

### Changed

- New fonts (Archivo and Fragment Mono, bundled in the app), a new app icon, and new buttons, switches, fields,
  menus and dialogs with a clearer focus outline.
- A sidebar replaces the title bar and the status bar. It holds:
  - Dashboard, Downloads and Networks, with how many downloads are in progress;
  - every network with its speed, or "Out";
  - the merged speed, slow mode, free space, updates and the schedule.

  In a window narrower than 760 points, a compact bar at the top takes its place.
- The window opens at 1280 × 800, or smaller to fit the screen. It can be made as narrow as 720 points.
- The download list:
  - has a search field and status tabs with counts (All, In progress, Finished, Needs attention);
  - shows a file-type icon on each row, tags for torrents, Usenet and video links, and the progress in plain words;
  - lists queued downloads as "Waiting".
- A download's details open beside the list when the window is wide enough. In a narrower window they take the
  list's place, with a button back. They keep everything the old download screens showed.
- New download is a sheet that slides down from the top of the window, with a row for each of Link, Quality,
  Networks, Streams and Save to. A video's qualities are listed with their sizes, and the link says where it comes
  from (Torrent, Usenet, HLS, DASH or YouTube).
- The Confluence replaces the old combine diagram: each network is a lane as thick as its speed, merging into one
  road beside the merged speed. Its markings move only while data flows, and stay still with Reduce Motion on.

### Fixed

- Two networks of the same kind, or a network of unknown kind, could get colours that look alike. An extra network
  now skips colours close to the theme's network colours.
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
