# Changelog

All notable changes to Mergelane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.5] - 2026-11-12

A network you connect mid-download now joins it, the download details can be closed again, and Liquid Glass is
clearer.

### Changed

- **Liquid Glass's Clear look is clearer.** More of your desktop shows through the window, the sidebar and the
  content pane. Cards stay a little more solid, so text stays easy to read. Tinted is unchanged.
- **A network you connect while a download runs now joins it.** Plug in your phone or join Wi-Fi during a download
  and it starts using that network too, without a click. A network you switched off for a download, or left out
  when you started it, stays off, even if it drops out and comes back. A download the server only allows over one
  connection keeps to its one network.

### Fixed

- **The download details beside the list can be closed again**: with the × at their top-right, or with Esc
  when no downloads are ticked. Focus goes back to the download's row.
- Tunnels, such as a VPN app's or iCloud Private Relay's (`utun0`), are no longer offered as networks for
  downloads. They aren't separate internet connections.

## [0.3.4] - 2026-11-12

Mergelane now offers to update its helper as soon as it opens, so the two stay in step.

### Changed

- **Mergelane offers to update its helper as soon as it opens** after an update. A note at the foot of the sidebar
  says the helper needs updating, with an Update button that brings up your Mac's password prompt straight away
  and a Later button. You no longer need to find Networks › System merge › Update. The note only appears if you use
  system merge.

## [0.3.3] - 2026-11-12

Keeping each website on one network now holds from a site's very first connections. Update the helper when
Mergelane asks.

### Fixed

- **System merge now keeps a website on one network from its very first connections.** A browser opens several
  connections to a new site at once; they could each be sent over a different network before the site had one,
  which is what keeping a site on one network is meant to stop. Found by the real-hardware test on Wi-Fi and an
  iPhone. Update the helper when Mergelane asks.

## [0.3.2] - 2026-11-12

System merge keeps each website on one network, and the browser extension looks like Mergelane. Update the helper
when Mergelane asks.

### Added

- **System merge keeps each website on one network** (on by default). Your networks each have their own internet
  address, and some sites sign you out, ask "are you a robot?", or drop a call when you arrive from several at once.
  Now all of one site's connections go over the same network, while different sites still spread over all of
  them. A site moves only if its network stops working. Turn it off in Networks › System merge › Keep each site on
  one network. Mergelane's own downloads still use every network. Update the helper when Mergelane asks.

### Changed

- **The browser extension looks like Mergelane.** Its popup and options page now use the app's colours, fonts,
  switches and buttons, with settings grouped the way Settings groups them. They follow your browser's light or
  dark mode, show a clear outline around whatever the keyboard is on, use stronger lines when your Mac's Increase
  Contrast is on, and keep still when Reduce Motion is on.

## [0.3.1] - 2026-11-12

New download can start a download later or put it in the queue, each network can be kept on standby, the helper
can be removed from your Mac, and the browser extension is easier to install.

### Added

- **Remove helper** (Networks › Other apps): takes system merge's helper off your Mac. After you confirm,
  system merge turns off first, then your Mac asks for your administrator password once. Mergelane says whether
  the helper was removed, whether you canceled the password prompt, or why it couldn't be removed. Downloads
  keep working without the helper.
- **When to start a download.** New download has a "When" row: **Now** (as before), **Add to queue** (it waits for
  a turn: it starts when a running download finishes, or when you choose Start now), or **At a time** (it starts
  the next time the clock reads that time, today or tomorrow). Until then its row says "Starts at 1:00 AM", and
  Start now starts it early. Both survive quitting Mergelane. A time that passed while Mergelane was closed starts
  at the next launch, and the download says it started late. The download schedule still wins: a time outside its
  hours waits for them, and New download says so.
- **A role for each network.** On Networks, each network's pop-up sets what Mergelane's downloads do with it:
  **Use** (as before), **Standby** (used only when no network set to Use is connected, for example a phone's data
  plan kept as a backup: running downloads move to it when the others drop, and back when they return) or
  **Don't use** (never used for downloads). It applies to running downloads too. New download shows a Standby
  network as such and can't pick a Don't use one. "Which network carries what" still wins while it names a
  network.

### Changed

- **Installing the browser extension is easier.** **Install…** in Settings › Browser extensions now saves the
  extension in your Downloads folder, as "Mergelane Extension" (and "Mergelane Extension for Firefox"), instead of
  the hidden Library folder. **Change…** saves it somewhere else. The guide then has buttons to show the folder in
  the Finder, open the browser, and copy the browser's extensions page and the folder's path, each on the step
  that uses it, with a tip for going straight to the folder in the browser's file picker. Every folder Mergelane
  saved, including the old one in Library, is kept up to date when Mergelane updates. A folder of the same name
  that Mergelane didn't make is never touched. Chrome doesn't let another app choose the folder for you, so that
  step stays yours.
- The browser extension uses the new Mergelane icon, in the toolbar, its menu and its options page. It had kept the
  old one. While it isn't capturing or can't reach Mergelane, the icon is a grey copy of the new one.
- While New download checks a link, the place where its preview will appear shows a spinning tile and a glowing
  name line above "Checking the link…", so the wait is visible and the window doesn't jump when the answer
  arrives. With Reduce motion on, both stay still.

### Fixed

- Selecting a download no longer nudges the download list up a few pixels.
- New download lists a video's qualities one under another again, as designed. They sat side by side, which pushed
  the window's contents sideways and cut off its left edge. The up and down arrow keys now move between them.
- The Dashboard says when a download with a start time starts ("Starts at 1:00 AM"), and that a download started
  late, as the download list does, instead of "Waiting for a turn".

## [0.3.0] - 2026-11-12

Mergelane now keeps itself up to date from GitHub, sits in the menu bar, and lets you choose which network carries
your downloads and your uploads. The browser extension comes inside the app, with one set of rules for every
browser.

### Added

- **Updates.** Settings › Updates checks GitHub for a newer Mergelane on request and once a day, and shows what's
  new. "Download and install" downloads it with progress, checks it against the SHA-256 published with the
  release, and "Quit and install" opens it so you drag the new version over the old one. Choose Stable or Beta,
  skip a version, download in the background, or turn checks off. The sidebar and the app menu ("Check for
  Updates…") say when one is out.
- **On this Mac** (Settings › General):
  - the merged speed in the menu bar while downloads run;
  - Open at login, off until you turn it on; it starts in the menu bar, and says plainly if macOS wants your
    approval or didn't accept it;
  - a switch for the notification when a download finishes.
- **Which network carries what** (Networks): send every download over one network, the running ones included,
  and every torrent upload over one network (keep them off your iPhone's data plan, say). Choose whether the other
  networks stand in when the chosen one drops.
- **Upload limits** (Speed & data limits): how fast torrents upload, in total and per network.
- **Browser extensions** (Settings):
  - finds Chrome, Edge, Chromium and Firefox on your Mac and walks you through loading the extension, which now
    comes inside Mergelane; Microsoft Edge is supported; Brave, Vivaldi and Safari say what they still need;
  - shows when each browser last reached Mergelane, and when to restart one for a newer extension;
  - "What the extension does": one set of rules for every browser: whether to send downloads, a minimum size, the
    file types, and whether to list a page's videos.
- **Offer links I copy** (Settings › Downloads), off until you turn it on. When you switch to Mergelane, a link you
  copied is offered at the foot of the sidebar. Mergelane reads the clipboard only then, and never saves it. macOS
  may ask once whether to allow it.
- **Save Diagnostics…** (Settings › General › Troubleshooting, and the app menu) saves a zip to attach to a GitHub
  issue. Links keep only their site and file names only their type; passwords, cookies, sign-ins, your home folder
  and IP addresses are left out. Mergelane never sends it anywhere.
- **Today** on the Dashboard shows the fastest merged speed of the day and the network dropouts of the last 24
  hours. Dropouts and the fastest speed are kept when Mergelane quits, for a week.

### Changed

- By default the extension sends Mergelane only files over 1 MB that are videos, archives, disk images, apps, or
  of a type Mergelane doesn't recognise. Documents, images and audio stay with the browser unless you tick them in
  Settings › Browser extensions.
- A network's data limit counts what torrents upload over it as well as what Mergelane downloads, as carriers do.
  A network at its limit stops uploading too.
- Slow mode holds uploads too: at most its speed for all downloads together, and the same for all uploads.

### Fixed

- Speed & data limits › Reset data usage: when the reset fails, its window stays open and says why, instead of
  closing as if it had worked.

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
