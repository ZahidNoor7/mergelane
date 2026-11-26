# Plan: nine new features from the redesign prototype

Status: proposal, 2026-11-26. Nothing here is built yet. Decisions marked **Owner** need an answer before the work
they block starts. Updated the same day: the owner parked the wireless iPhone lane (feature 2, D3), then took every
other recommendation (D1, D2, D4 to D13).

## Where the acceptance criteria come from

The brief named `docs/design/mergelane-redesign.html`. That file does not exist in the repository. The prototype that
holds these features is the claude.ai artifact "Mergelane Redesign", version `1795691890-d752` (`index.html`,
445,691 bytes, SHA-256 starting `f7d76f75ef86d77e`). The copy in the repository,
`design-system/mergelane/redesign/prototype.html` (version `1794387759-a310`, ADR-0034), is older and has none of the
nine features. Every behaviour and line of copy below is taken from the newer artifact. Before building starts, save
that version beside the old one with its SHA-256, as `design-system/mergelane/redesign/README.md` did for the first
(Owner decision D1).

Prototype names used below: store actions `dropLink`, `pairCompanion`/`setCompanionVia`, `redownload`/`clearHistory`,
`simulateCrash`, `expireLink`/`resumeWithLink`, `queueFinished`/`finishQueue`, `setTorrentFiles`; helpers `historyOf`,
`findDuplicate`, `timeSavedSec`, `reportDays`, `FILM_PACK`, `phoneLink`; components `Confluence` (handover note),
`Dropouts`, `CompanionPanel`, `HistoryScreen`/`HistoryRow`/`HistoryStatus`, `DuplicateNotice`, `TorrentFiles`,
`FreshLinkPanel`, `SavedAgo`, `RecoveredBanner`, `CrashOverlay`, `QueueDoneNotice`, `AwakeLine`, `AwakeSettings`,
`SafetySettings`, `HistorySettings`, `ReportsSection`/`ReportChart`.

## Two conflicts with the project rules

1. **Plans and licences.** The prototype gates features behind paid plans: Reports' 30 days, 12 weeks, the Monday
   summary and CSV export need "Plus"; the wireless iPhone lane needs "Pro" (`canDo(s, 'net.companion')`,
   `ent.f['stats.reports']`, `PlanBadge`, `PlanLock`, `askUpgrade`). CLAUDE.md says: no servers, no paid services, no
   accounts. This plan builds every feature free and ungated, drops every plan badge, lock and upgrade prompt, and
   rewrites the copy that mentions a plan (for example the Reports note "{plan} shows the last 7 days. … adds 30
   days, 12 weeks, the weekly summary and CSV export." is dropped). Owner decision D2 confirms.
2. **The iPhone app needs an Apple Developer account.** The wireless iPhone lane needs an app on the phone: only an
   app can keep relaying traffic over mobile data, and a QR code scanned with the camera can only open a page or join
   a network. An app reaches other people's iPhones only through the App Store or TestFlight, and both need the paid
   Apple Developer Program. The owner has no account, and CLAUDE.md rules out paid services. **Decided by the owner,
   2026-11-26 (D3): feature 2 is parked**, with no spike for now. The iPhone over the USB cable (Personal Hotspot over
   USB) already works as a lane and stays. See "Feature 2" below.

## Summary

The brief lists nine features. This plan builds eight; the wireless iPhone lane (feature 2) is parked. Most of the
work is in the main process, and the screens around it already exist, because the redesign (sidebar, Confluence,
inspector, Settings screen) is already built (`renderer/src/components/WindowChrome.tsx`,
`components/Confluence.tsx`, `components/inspector/`, `screens/SettingsScreen.tsx`). History is the only new place.
Some pieces already exist, which changes the effort a lot:

- Keep-awake already runs (`downloadManager.ts:2055`), with no setting.
- Choosing torrent files already works before and during a download (`torrent/files.ts`, `chooseTorrentFiles`).
- Replacing an expired link already works (`relink`/`replaceLink`, `FixLinkDialog.tsx`).
- History already exists: a 500-entry JSON list of finished downloads (`download/history.ts`).
- A dropouts log already exists (`networkActivity.ts`, `Dropouts()` in `NetworksScreen.tsx:361`).

Proposed order, each phase shippable on its own:

| Phase | Features | Why here |
|---|---|---|
| 1. Nothing is lost | 5 crash-safe resume, 6 expired links, 7 sleep and the end of the queue, 9 the rest of torrent file choice | Main-process changes on code that already exists. No new storage technology. Each fixes a way users lose work or time today. |
| 2. Remember | 3 history store (SQLite), 4 duplicates; daily usage starts recording | One new store, then the feature that reads it. Usage recording starts here so Reports has weeks of real data when it ships. |
| 3. See it | 1 hot-swap handover, 8 speed reports | Handover is the riskiest engine change (the block scheduler); it ships alone with its own tests. Reports only adds UI and a query on data Phase 2 has been collecting. |

The first draft had a Phase 4 for the iPhone. It is gone: the owner parked that feature (D3).

### How this differs from the suggested order

- **The history store moves from Phase 1 to Phase 2.** The crash journal must not depend on it: per-download manifest
  files with an atomic rename are already the pattern (`persistNow`, `downloadManager.ts:2791`), they isolate one
  download's damage from another's, and they need no new technology. Expired links need nothing from history either.
  That lets Phase 1 ship without the SQLite decision (D4).
- **Torrent files moves to Phase 1.** It is mostly built (see feature 9). What is left is small renderer work.
- **Handover moves to Phase 3.** It changes `scheduler.ts`, `httpTransfer.ts` and `concurrency.ts`, the busiest code
  in the engine. Shipping it alone keeps a regression easy to find and revert.
- **Reports' data collection moves to Phase 2.** Nothing records per-day bytes today (`network/limits.ts` keeps only
  the current day, week and month, and resets them). If recording starts only when the UI ships, the first 12-week
  chart is empty.

## Current state, per feature

| # | Feature | Exists | Partly there | Missing |
|---|---|---|---|---|
| 1 | Hot-swap handover | Interface watcher polls every 1 s (`network/interfaces.ts:304-342`) and calls `manager.networksChanged()` (`downloadManager.ts:1993-2019`). A lost network's streams are retired at once (`httpTransfer.ts:382`, `retireStreams` `:1233-1253`) and their blocks go straight back to `pending` with no backoff (`finishStopped` `:1016-1022`, `settle` `:918-920`). Bytes already written stay credited (`blockProgress.ts:43-62`). Dropouts log: `NetworkActivityLog` (`main/networkActivity.ts:22-91`, `userData/network-activity.json`, 50 events, 7 days), shown in `Dropouts()` (`NetworksScreen.tsx:361-420`) and `FailoverSection` (`DashboardScreen.tsx:560-680`). | Survivors pick released blocks up only at their next poll (`IDLE_POLL_MS = 250`, `httpTransfer.ts:201`) and do not add streams until the doubling rule allows (`concurrency.ts:172-176`). A network whose interface stays up but carries nothing is caught only by `SILENT_AFTER_MS = 5_000` (`testKnobs.ts:45`), `STALL_TIMEOUT_MS = 20_000` (`chunkDownloader.ts:85`) or the slow-stream refresh (`SLOW_FOR_MS 10_000`). | Any handover event: no record of from, to, chunk count or time, anywhere (`grep -ri handover` finds nothing). No handover in `NetworkEvent` (`shared/networkActivity.ts:9-23`) or in `Confluence`. |
| 2 | iPhone wireless lane (parked, D3) | iPhone over USB appears as an ordinary network (Personal Hotspot over USB). Per-network proxy support exists (`connectThroughProxy`, `network/routes.ts:162-260`; `NetworkPreference.proxy`), the shape a relayed lane needs. | — | Everything else: iOS app, Mac-side peer-to-peer listener, pairing, wire protocol, lane type. |
| 3 | Download history | `download/history.ts`: `userData/history.json`, newest first, `MAX_ENTRIES = 500`, finished downloads only (`FinishedDownload`, `types.ts:457-471`), `missing` worked out when listed. `listHistory` IPC and `historyChanged` push (`ipc-channels.ts:15,27`). `moveToHistory` (`downloadManager.ts:1059-1105`). | Only finished downloads; removing one from history removes it everywhere (`removeFromHistory`). No search, filters, retention or clear. | A History place, cancelled and removed downloads, SHA-256, retention, re-download from history, a store that scales past 500. |
| 4 | Duplicate detection | `failedMatch(probe)` (`downloadManager.ts:1803-1821`) matches a failed HTTP download by size, file name and strong ETag, offered as "Resume it" (`NewDownloadDialog.tsx:389-403`). | Covers failed downloads only, and only to resume them. | Matching against finished or running downloads; published SHA-256; a setting; torrent infoHash matching (`start()`, `downloadManager.ts:1360-1385`, does not check). |
| 5 | Crash-safe resume | Manifest per download, `userData/downloads/<id>/manifest.json`, `PersistedDownload` version 7 (`downloadManager.ts:185-210`). The staging file is fsynced (`downloadFile.ts:37-44`) before the manifest is written to `.tmp` and renamed (`downloadManager.ts:2854-2859`). The block snapshot is taken before the fsync, so the map never claims bytes that were not flushed. Stale `.tmp` removed at launch (`:998`). | Checkpoint only every `CHECKPOINT_INTERVAL_MS = 15_000` (`:257`), so a crash can refetch about 15 s. The staging file's flush is already a full one on macOS (corrected at build time: libuv's `uv__fs_fsync` uses `F_FULLFSYNC`). The manifest file and its folder are not flushed. Downloads that were running come back paused (`:1227-1231`). | Crash detection (a crash and a clean quit look the same), the recovery note, auto-resume after a crash. |
| 6 | Expired-link recovery | `LINK_REFUSED` (`shared/errors.ts:5`) recognises 401/403/404/410/416 on a range request; the renderer derives `linkExpired()` (`renderer/src/utils/format.ts:262-264`) and shows a fix action (`downloadActions.ts:48`). `relink`/`replaceLink` (`downloadManager.ts:1709-1775`) re-probes, needs the same size and range support, compares sampled bytes with the disk (`compareWithDisk` `:1777-1799`), swaps the URL and resumes. `FixLinkDialog.tsx`. The browser path offers to resume a matching failed download (`browserBridge.ts:303-310`). | Expiry is noticed only after 5 strikes on every network (`httpTransfer.ts:1130-1136`, `downloadManager.ts:2612-2616`). There is no "expired" state, only `error` (`DownloadStatus`, `types.ts:145-146`). `relink` does not update the stored `etag`/`lastModified`. The browser match needs a strong ETag. | Signed-URL detection, the inspector panel in the prototype's copy, automatic hand-off from the extension, the refusal messages. |
| 7 | Sleep prevention | `keepAwake()` starts `powerSaveBlocker('prevent-app-suspension')` while anything downloads and stops it after (`downloadManager.ts:2053-2069`), called on every `pushUpdate` (`:2709`). Electron's docs: that type "Keeps system active but allows screen to be turned off". | Always on: no setting. | "When the queue finishes": no queue-finished event (`pump`, `:720-739`, never reports an empty queue), no sleep or shut-down code anywhere, no countdown. |
| 8 | Speed reports | Per-download bytes per network, `startedAt`, `completedAt`, `totalPausedMs`, peak (`types.ts:288-361`). Current day, week and month bytes per network in `userData/network-usage.json` (`network/limits.ts:41-104`). | Those periods reset when they roll over (`rollPeriods`, `limits.ts:217-228`): no history. | A per-day store, time saved, the Reports section, the Monday notification, CSV export. |
| 9 | Choose files in torrents | Pure helpers (`torrent/files.ts`: `chosenFiles`, `wantedPieces`, `finishedFiles`); engine selection with `torrent.deselect` then `file.select` (`torrentTransfer.ts:267-273`); changing the choice while running (`chooseTorrentFiles`, `downloadManager.ts:2093-2131`) with disk-space checks; unwanted files deleted at publish (`torrentDestination.ts:38-67`). UI: `TorrentFileList` in New download (`NewDownloadDialog.tsx:735-740`) and live `TorrentFiles` in the inspector (`InspectorProgress.tsx:345-351`). | The list has one folder level only (`TorrentFiles.tsx:44-66`); subfolders (the prototype's `extras/subtitles`) are not grouped. | "Videos only", per-subfolder ticks, the prototype's live summary and "Choose at least one file." alert (check whether present), the shared-pieces note. |

Other facts that shape the plan:

- **No database anywhere.** All persistence is JSON in `userData` through `jsonFile.ts` (temp file, rename, no fsync)
  or the download manifests.
- **`node:sqlite` is available.** The app is on Electron 45.4.1 (`app/package.json:63`), whose Node is 24.22.3.
  Node's docs mark `node:sqlite` "Stability: 1.2 - Release candidate" since v24.15.0, with no flag needed. I checked
  that `DatabaseSync` opens and runs SQL in this Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`); I have not
  yet run it inside the packaged app's main process.
- **The main process has no unit tests.** Vitest runs only `src/renderer`, `src/shared` and `extension/src`
  (`vitest.config.ts:157-163`), with 90% line coverage per file on an explicit `COVERED` list. Main-process code is
  covered by Playwright e2e (`app/e2e/`). The pattern this plan follows: pure logic goes in `src/shared/` (as
  `shared/networkActivity.ts` and `torrent/files.ts`-style helpers do) and is unit-tested to 90%, and main-process
  wiring is covered by e2e.
- **Test tools that exist:** `e2e/origin.ts` (range server with faults: `status`, `cutAfter`, `stallBody`, `crawl`,
  `redirect`…), `e2e/torrentSwarm.ts`, `e2e/fakeDaemon.ts`, `liveNetworks.spec.ts` (networks come and go through
  `MERGELANE_E2E_INTERFACES`), `chaos.spec.ts` (fast-check fault sequences), `netsimDownload.spec.ts` (`@netsim`, real
  shaped links, CI only, and CI is paused), and `testKnobs.ts` timing knobs.

## Architecture

### Where each piece lives

| Piece | Process | New or changed files |
|---|---|---|
| Crash journal and recovery | main | `download/downloadManager.ts` (checkpoint), new `main/session.ts` (crash marker), new `main/durableFile.ts` (flushed writes); pure rules in new `shared/recovery.ts` and `shared/journal.ts` |
| Expired links | main, extension | `download/httpTransfer.ts`, `download/downloadManager.ts`, `shared/errors.ts`, new `shared/linkExpiry.ts`, `main/browserBridge.ts` |
| Sleep and queue end | main | `download/downloadManager.ts` (queue-finished), new `main/power.ts` (sleep and shut down per platform); pure countdown in new `shared/queueEnd.ts` |
| Torrent files | renderer | `components/TorrentFiles.tsx`; tree building in new `shared/torrentTree.ts` |
| History store | main | new `main/store/database.ts` (opens `userData/mergelane.db`), new `main/store/historyStore.ts` replacing `download/history.ts`, new `main/download/fileHash.ts` (SHA-256 in a worker thread); pure queries/filters in `shared/history.ts` |
| Duplicates | main, renderer | `download/probe.ts` (published digest), new `shared/duplicates.ts`, `browserBridge.ts`, `NewDownloadDialog.tsx` |
| Handover | main, renderer | `download/scheduler.ts`, `download/httpTransfer.ts`, `download/concurrency.ts`, `networkActivity.ts`; pure tracker in new `shared/handover.ts`; `Confluence.tsx`, `NetworksScreen.tsx` |
| Reports | main, renderer | new `main/store/usageStore.ts`, hook in `network/limits.ts`; pure maths in new `shared/reports.ts`; new `components/ReportsSection.tsx` on the Dashboard |

### New libraries

None. SQLite comes from Node's built-in `node:sqlite` (D4). Hashing uses `node:crypto` in a `worker_threads`
worker. Full flushes need nothing new: Node's `FileHandle.sync()` already uses `F_FULLFSYNC` on macOS.

### Data model

One SQLite file, `userData/mergelane.db`, opened in WAL mode, created with file mode `0600`. Schema version in
`PRAGMA user_version`; migrations are numbered SQL steps in `main/store/migrations.ts`, each run in a transaction.

```sql
-- Version 1 (Phase 2)
CREATE TABLE downloads (
  id              TEXT PRIMARY KEY,        -- the download id the manager already uses
  kind            TEXT NOT NULL,           -- 'http' | 'stream' | 'torrent' | 'usenet'
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,           -- the link as given (sealed, see Privacy)
  host            TEXT,                    -- for search and display; NULL for magnets
  source          TEXT,                    -- 'YouTube', 'HLS', … for video
  info_hash       TEXT,                    -- torrents only
  size            INTEGER,                 -- bytes, NULL if unknown
  added_at        INTEGER NOT NULL,        -- ms since epoch
  completed_at    INTEGER,
  ended           TEXT,                    -- NULL while live | 'completed' | 'cancelled' | 'failed'
  in_list         INTEGER NOT NULL DEFAULT 1,
  path            TEXT,                    -- where it was saved
  file_state      TEXT NOT NULL DEFAULT 'partial', -- 'partial' | 'on_disk' | 'missing' | 'stopped'
  file_checked_at INTEGER,
  sha256          TEXT,                    -- hex, worked out after it finished
  published_sha256 TEXT,                   -- what the site published, if anything
  active_ms       INTEGER,                 -- completed_at - started_at - total paused
  bytes_by_network TEXT,                   -- JSON {networkId: bytes}
  saved_ms        INTEGER                  -- time saved by merging, see feature 8
);
CREATE INDEX downloads_added ON downloads(added_at DESC);
CREATE INDEX downloads_url ON downloads(url);
CREATE INDEX downloads_name_size ON downloads(name, size);
CREATE INDEX downloads_sha ON downloads(sha256);
CREATE INDEX downloads_hash ON downloads(info_hash);

CREATE TABLE usage_days (                  -- feature 8, recorded from Phase 2
  day        TEXT NOT NULL,                -- local 'YYYY-MM-DD'
  network_id TEXT NOT NULL,
  network_name TEXT NOT NULL,              -- kept: the network may be gone later
  kind       TEXT NOT NULL,                -- 'wifi' | 'usb' | 'ethernet' | …
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, network_id)
);
CREATE TABLE usage_minutes_saved (         -- feature 8
  day        TEXT PRIMARY KEY,
  busy_ms    INTEGER NOT NULL DEFAULT 0,   -- minutes with any download traffic
  saved_ms   INTEGER NOT NULL DEFAULT 0,
  peak_bps   INTEGER NOT NULL DEFAULT 0
);
```

The download manifest (`PersistedDownload`) goes from version 7 to 8 with two new optional fields; see feature 5.
`NetworkEvent` gains an optional `handover`; see feature 1.

### Settings (`AppSettings`, `shared/types.ts:664-726`)

Added the existing way: field in `AppSettings`, line in `sanitizeSettings` (`settings.ts:106-195`), field in
`InitialState`, both branches of the initial-state handler (`ipc/handlers.ts:212-275`), applied in
`manager.applySettings`, a store setter that calls `persist(patch)` (`useAppStore.ts:205-207`). No new channel: the
`updateSettings` channel carries them.

| Field | Values | Default | Saved only when |
|---|---|---|---|
| `keepAwake` | boolean | `true` (today's behaviour) | `false` |
| `afterQueue` | `'nothing' \| 'sleep' \| 'shutdown'` | `'nothing'` | not `'nothing'` |
| `catchFreshLinks` | boolean | `true` | `false` |
| `duplicateCheck` | `'off' \| 'link' \| 'both'` | `'both'` | not `'both'` |
| `historyKeep` | `'30d' \| '1y' \| 'forever'` | `'forever'` | not `'forever'` |
| `weeklyReport` | boolean | `false` | `true` |

### IPC

Following `ipc-channels.ts` naming (`domain:kebab-action`), each invoke channel in `IpcContract`, each push as an
`onX` in preload.

| Channel | Kind | Args → result | Phase |
|---|---|---|---|
| `InitialState.recovery` | initial state | `RecoveryNote \| undefined` | 1 |
| `session:dismiss-recovery` | invoke | `() → void` | 1 |
| `queue:ended` | push | `QueueEnd { action, endsAt }` or `null` when cancelled | 1 |
| `queue:cancel-end` / `queue:end-now` | invoke | `() → void` | 1 |
| `download:relink` | invoke (exists) | result gains `{ ok: false, reason: 'not-a-link' \| 'other-file' \| 'changed' \| 'probe-failed' }` | 1 |
| `history:query` | invoke | `HistoryQuery { text, show, before?, limit } → { items, counts, total, removed }` | 2 |
| `history:redownload` | invoke | `(id) → { linkId }` (opens New download, as `offerLink` does) | 2 |
| `history:reveal` | invoke | `(id) → boolean` | 2 |
| `history:clear` | invoke | `() → { forgotten }` | 2 |
| `history:changed` | push (exists) | unchanged | 2 |
| `ProbeResult.duplicate` / `PendingLink.duplicate` | field | `DuplicateMatch \| undefined` | 2 |
| `NetworkEvent.handover`, `DownloadState.handover` | field | `Handover \| undefined` | 3 |
| `reports:get` | invoke | `(range: '7d' \| '30d' \| '12w') → ReportBars` | 3 |
| `reports:export-csv` | invoke | `(range) → { saved: boolean }` (save dialog) | 3 |

### Events

- `Handover { from: string; to: string[]; chunks: number; ms: number; at: number }`, from the engine, kept on the
  `NetworkEvent` for that drop and briefly on the download state.
- `QueueEnd`, from `DownloadManager` when the queue empties.
- `RecoveryNote { count; lostBytes; agoMs }`, worked out once at launch.

## Feature 1: hot-swap handover

### Scope

When a network drops, its blocks in flight go to the networks still up at once, survivors add streams at once, and a
`Handover` is recorded and shown. HTTP downloads only. Torrents already spread peers across networks and reconnect
(`torrentTransfer.ts:377-413`); video tracks share the connection code but not the block scheduler and are out of
scope for v1.

**What "no stall" can honestly mean.** The merged speed still falls by the dropped network's share; nothing can
avoid that. What goes away is the gap in which released blocks sit unclaimed and survivors run below their capacity.
And handover is only as fast as detection: an interface that disappears is seen within 1 s; a Wi-Fi network that
keeps its address but carries nothing is seen only by silence. The prototype's 0.3 to 0.5 s figure is achievable for
the first case, not the second.

### UI (prototype → app)

- `Confluence` handover note → `components/Confluence.tsx`, new prop `handover`. Shown for 7 s after `at`. Wide:
  "{from} dropped: {n} chunk(s) handed over in {s} s, no pause." Stacked: "{from} dropped. {n} chunk(s) moved to {to
  joined with ' and '} in {s} s, no pause." `role="status"`, `ArrowRightLeft` icon, accent ink. Dashed paths from the
  dropped lane to each receiving lane with three moving capsules; under reduced motion a single dot. It replaces the
  "N× your fastest network" line while shown.
- `Dropouts` → `Dropouts()` in `NetworksScreen.tsx:361` and `FailoverSection` in `DashboardScreen.tsx:560`: append
  ". {n} chunk(s) moved to {to} in {s} s, no pause" to the event line.
- Inspector "By network" row: "Dropped, its streams moved to the others" (peers for torrents) in danger ink.

### Engine changes

1. **Know at once.** In `HttpTransfer.reconcile` (`httpTransfer.ts:347-395`), when a network goes from carrying to
   `offline`/`unreachable`/`off`, collect the blocks its streams held before `retireStreams` aborts them: block id,
   bytes left. Start a `HandoverTracker` (pure, `shared/handover.ts`) with those ids and `t0 = now`.
2. **Hand over at once.** Call `transfer.wake()` on survivors instead of waiting for `IDLE_POLL_MS`. In
   `ConcurrencyController` (`concurrency.ts:131-210`), add `absorb(fromStreams)`: each survivor's target goes up by
   its share of the lost network's stream count right away, capped at `MAX_STREAMS_PER_NETWORK` and at the server
   ceiling, bypassing the "double once all received data" rule. The boost decays back to the controller's normal
   rule after 30 s or when the network returns.
3. **Pick released blocks first.** In `scheduler.ts`, `nextWaitingBlock` (`:150-160`) prefers blocks marked
   `releasedAt`, oldest first, then the usual order. That matters near the end of a download, where the dropped
   network may hold the last blocks.
4. **Catch silent networks sooner.** New rule in `refreshStuckConnections` (`:535-574`): if every stream on one
   network has received nothing for `HANDOVER_SILENCE_MS` (proposed 1,500 ms, a new test knob) while at least one
   other network is delivering, mark it `unreachable` and release its blocks as in step 1. Today that takes 5 to
   20 s. If the system-merge helper is installed, also treat its `down` link state (`daemon-api.ts` `LinkEvent`) as
   a drop; the app already polls it (`snapshot.ts:95-158`).
5. **Measure.** The tracker records each released block's first byte on another network. `ms` = time from `t0` to
   the first byte of the last released block, or the tracker closes at 5 s with the count it has. `to` = networks
   that took at least one block. `chunks` = released blocks. No handover is recorded when no block was in flight or
   no network is left (matching the prototype: `chunks > 0 && to.length`).
6. **Record.** `NetworkActivityLog` adds the handover to that drop's `NetworkEvent` (several downloads add up into
   one event: sum `chunks`, union `to`, max `ms`) and pushes `networkActivityChanged`. The download state carries
   `handover` for 7 s for the inspector's compact Confluence.

### Storage

`NetworkEvent.handover?: { to: string[]; chunks: number; ms: number }` in `network-activity.json`. Older files read
fine (optional field).

### Edge cases

- The last network drops: no handover; the download waits as today.
- A network flaps (drops and returns inside a second): the boost is cancelled on return; one event.
- A server limits connections: the boost stays under `ConcurrencyController`'s server ceiling.
- A download that can't be split runs on one network: on a drop it restarts on another (`reconcile` already moves
  it); its handover is "1 chunk".
- Hedged duplicates of a released block: the tracker counts the block once.
- Split segments (in memory only) of a dropped stream: released as gaps (`nextGap`), counted with their block.

### Acceptance criteria

- The moment a network drops, its chunks in flight move to the networks still up, with no pause.
- The merge diagram shows the chunks jumping from the dropped lane into the others, with "{name} dropped: {n} chunks
  handed over in {s} s, no pause."
- The dropouts log records each handover: "{n} chunks moved to {A} and {B} in {s} s, no pause".
- When a network's interface disappears, released blocks start receiving bytes on survivors within 1 s of the drop
  being seen (target from the prototype's 0.28 to 0.46 s; the test asserts under 1 s to stay stable on CI).

### Test plan

- **Unit (`shared/handover.test.ts`, 90%+):** tracker with fake clock: single and multiple downloads, block arrives
  twice (hedge), tracker timeout, no survivors, zero blocks, merge of events.
- **Unit (`shared/concurrency` logic extracted from `concurrency.ts` if needed):** `absorb` caps and decay.
- **e2e (`e2e/handover.spec.ts`):** two fake networks via `MERGELANE_E2E_INTERFACES` (as `liveNetworks.spec.ts`),
  `origin.ts` throttled to keep blocks in flight; remove one interface mid-download; assert a `handover` on the
  network event with `chunks > 0`, `to` the other network, `ms < 1000`; assert bytes keep flowing (no 1 s window
  with zero bytes after the drop); assert the Networks log line text. Second case: keep the interface but make the
  origin stall that network's connections (`stallBody` per local address) and assert detection within
  `HANDOVER_SILENCE_MS + 1 s`.
- **Existing suites:** `chaos.spec.ts` and `blockProgress` specs must stay green; add a fast-check property: for any
  drop/return sequence, every byte of the file is written exactly once and the result matches the origin's bytes.
- **CI netsim (when CI resumes):** `drop <id> down` and `drop <id> loss` in `netsimDownload.spec.ts`.
- **Manual (owner's Mac):** Ethernet + Wi-Fi + iPhone USB; start a large download; unplug the iPhone; walk out of
  Wi-Fi range; check the note, the log, and that the speed graph has no flat gap.

### Effort and risks

**M.** Risk: the scheduler is the most-tested and most-tuned part of the engine; the boost can overload a server that
limits connections (mitigated by the server ceiling) and a too-short silence rule can wrongly drop a slow network
(mitigated by requiring another network to be delivering, and a test knob to tune).

## Feature 2: the iPhone as a wireless lane (parked)

**Decision (owner, 2026-11-26, D3): not built now.** It is kept here, and in the appendix, so the reasons and the
first design aren't lost.

Why it can't be "scan and done":

- The phone has to keep working the whole time a download runs: fetch pieces over its mobile data and pass them to
  the Mac. Only an app on the phone can do that job.
- Scanning a QR code with the camera only does built-in things: open a web page, join a Wi-Fi network, add a
  contact. A web page in Safari can't relay another computer's traffic, and it stops when you leave it.
- An app reaches other people's iPhones only through the App Store or TestFlight, and both need the paid Apple
  Developer Program. Without it, Xcode installs an app only on the developer's own phone, and that install expires
  after a short time (about 7 days, from memory; not checked against Apple's docs).

What users have instead, with no app and no account:

- **iPhone over the USB cable** (Personal Hotspot over USB). Already a Mergelane lane today, and the phone charges.
  Unchanged by this plan.
- **iPhone hotspot over Wi-Fi.** The Mac's Wi-Fi joins one network at a time, so this replaces the home Wi-Fi
  instead of adding to it. No gain, so nothing is planned for it.

What is not ported from the prototype:

- The "Your iPhone, without the cable" panel (`CompanionPanel`, `PairCode`, `PhoneMock`) on the Networks screen.
- The store actions `pairCompanion`, `confirmPair`, `cancelPair`, `setCompanionVia` and `forgetCompanion`, and the
  wireless naming in `phoneLink`. The USB iPhone keeps its current name and behaviour.
- The "iPhone without a cable" row of the prototype's change list.

If it comes back (only with a developer account): start with the 2 to 3 day spike in the appendix, on the owner's
own iPhone, before any design is final.

## Feature 3: download history

### Scope

Every download ever started, kept until the retention period ends, whether or not it is still in the list. Search,
filters, re-download, show in Finder/File Explorer, copy link, retention, clear.

### UI (prototype → app)

- New place **History** in the sidebar (`WindowChrome.tsx` `NAV`; `Screen` gains `'history'`, `useAppStore.ts:39`),
  new `screens/HistoryScreen.tsx`.
- Toolbar: "History", subtitle "{n} downloads, {m} no longer in the list", search capsule "Search names, sites and
  links" (Escape clears).
- Segmented "Show in history" with counts: All, On disk, Not in the list, File missing.
- Groups by `historyBucket`: Today, Yesterday, Earlier this week, Earlier this month, Older.
- `HistoryRow`: glyph, name, `HistoryStatus` tag ("In the list, {pct}%", "Link expired", "File moved or deleted" in
  caution, "Stopped, partial file removed", "Not in the list"), site, size, date; actions "Show in list" (live) or
  "Download again", Show in Finder (disabled with "The file isn't where it was saved"), Copy link.
- Empty: "Nothing in your history matches "{q}"" / "Nothing here", "Search looks at file names, the sites they came
  from and their links.", "Show all history".
- Footer: "Kept {forever | for 30 days | for a year}, only on this Mac. Removing a download from the list or deleting
  its file doesn't remove it here." with "History settings".
- Settings › Downloads › "Duplicates and history" (`HistorySettings`): "Keep download history" (30 days, A year,
  Forever; hint "History is stored only on this computer. Removing a download from the list doesn't remove it from
  history."), "Clear history" ("Forgets the {n} downloads no longer in the list. Files on disk aren't touched.",
  inline confirm Clear/Keep, disabled at 0; toast "History cleared. Everything in the list stays.").

### Engine and main changes

- `main/store/database.ts`: opens `mergelane.db` with `DatabaseSync`, `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL` (to confirm against SQLite's docs before building), runs migrations, closes on quit.
  All access stays in the main process.
- `main/store/historyStore.ts` replaces `download/history.ts` with the same API names where they still fit
  (`listHistory`, `findInHistory`, `addToHistory`) plus `recordStart`, `recordEnd`, `markRemoved`, `query`, `clear`,
  `prune`.
- `DownloadManager` writes a row when a download is created (`start*`), updates it on finish, cancel, failure and
  removal from the list (`in_list = 0`, never delete). `moveToHistory` keeps working but writes to the store.
- **SHA-256 on finish:** after publish, `fileHash.ts` hashes the file in a `worker_threads` worker (streamed reads,
  `node:crypto`), lowest priority, one at a time, cancelled if the file is removed. The row shows the hash when done.
  Chunks arrive out of order, so hashing while downloading isn't possible without a second pass anyway.
- **File state:** checked when History is opened and every 10 minutes while it is open: `stat` the path, compare size;
  `on_disk` or `missing`. No hashing at check time.
- **Retention:** `prune()` at launch and daily deletes rows with `ended IS NOT NULL AND in_list = 0` older than the
  setting. Rows for items still in the list are never pruned.
- **Re-download:** builds a pending link from the row (as `offerLink`, `openLinks.ts:63`) so the user confirms in New
  download, consistent with "nothing ever starts automatically" (`openLinks.ts:9-11`). The prototype starts it at
  once with a toast "Downloading {name} again."; proposal: open New download pre-filled instead, so the duplicate
  warning and network choice still apply (D7).
- **Migration:** at first launch with the store, import `history.json` rows (they are all finished, `in_list = 0`),
  then rename it `history.json.imported` (kept one release, then deleted).

### Storage, privacy

See Data model and the Risks section. Search: `LIKE` on name, host and source with indexes; links are matched on the
plaintext host and path only (see Privacy). At 100,000 rows this is well within SQLite's comfortable range; no full-
text index needed.

### Edge cases

DB file corrupt (rename to `.corrupt-<date>`, start empty, tell the user once); disk full (writes fail soft, downloads
continue); a file moved by the user (shows missing; v1 doesn't look for it); network volumes (stat may be slow: time
out after 2 s and show the last known state); two copies of the app (single-instance lock already applies).

### Acceptance criteria

History searches every download ever started, by name, site or link, including ones removed from the list. It says
when a file was moved or deleted, and fetches anything again from its saved link. Removing from the list keeps it in
history. Retention and clear behave as the settings copy says.

### Test plan

- Unit: `shared/history.ts` (buckets, filters, counts, search matching, retention cut-offs, 90%+).
- e2e: start/finish/cancel/remove downloads, assert rows and filters; delete a file on disk and assert "File moved or
  deleted"; retention with a test knob for "now"; clear; import of an old `history.json` fixture; kill the app mid-
  write (`SIGKILL`) and assert the DB opens and passes `PRAGMA integrity_check`.
- Manual: search a long history, re-download, Show in Finder.

### Effort and risks

**M.** Risks: `node:sqlite` is a release candidate (D4); WAL files beside the DB on network home folders; the
migration from JSON.

## Feature 4: duplicate detection

### Scope

Before downloading, warn when the same link is in history, or (setting "Link or file") the same file comes from
another site and that site publishes a SHA-256 that matches ours.

### UI (prototype → app)

`DuplicateNotice` in `NewDownloadDialog.tsx`, below the found-link card, `role="status"`, caution styling:

- Live: "This is already downloading" / "It's in your list, {pct}% done." + "Show in list".
- Finished: "You already have this file" / "Downloaded {ago} to {folder}, {size}." + "Show in Finder".
- "Same link." or "Same file from {host}: the name and size match, and so does the SHA-256 this site publishes."
- The primary button reads "Download again" when a duplicate is shown.

Settings › Downloads › "Duplicates and history": "Warn before downloading something you already have", Off / Same
link / Link or file, with the prototype's three hints.

### Main changes

- `shared/duplicates.ts` (pure): `findDuplicate(candidates, probe, url, mode)` → `DuplicateMatch | undefined`, same
  rules as the prototype's `findDuplicate`: candidates are rows `on_disk` or live; link match = same normalised URL,
  or same host and file name; file match (mode `both`, HTTP only) = same name and size, different host, and
  `published_sha256` of the new link equals a stored `sha256`. Torrents: same `info_hash` (new, cheap, not in the
  prototype; D8).
- **Where the site's SHA-256 comes from.** In `probe.ts`, read a `Repr-Digest` or `Digest` header with `sha-256`
  (RFC 9530 / RFC 3230; I have not re-read those RFCs for this plan, check before building). With mode `both`, also
  try `GET <url>.sha256` (first 4 KiB) when the name and size already match a stored file: one extra small request
  to the same site, only in that case. Most sites publish nothing; then no file match is shown. A name-and-size
  match alone never warns (D9).
- `ProbeResult.duplicate` and `PendingLink.duplicate` are filled in main (`probeUrl`, `browserBridge.ts` `add()`),
  as `resumes` is today.
- Matching ignores ordering of query parameters but not their values (signed links differ each time, so a fresh
  signed link to the same file is a file match, not a link match).

### Edge cases

Same link but the server's file changed (we can't know before downloading; the warning still offers "Download
again"); a history row whose file is missing (not a duplicate); a magnet with trackers that differ (infoHash match).

### Acceptance criteria

The two notices and the setting as in the prototype; Off shows nothing; "Same link" ignores file matches; "Download
again" stays one click away.

### Test plan

Unit: `duplicates.test.ts` (each rule and mode, 90%+). e2e: `origin.ts` serving a file with and without a
`Repr-Digest` header and a `.sha256` sibling on a second origin port; finish one, paste the same and the other link,
assert the notice texts. Manual: paste a link already downloaded.

### Effort and risks

**S** after the history store. Risk: the "same file from another site" case will rarely fire, because few sites
publish a SHA-256; that is acceptable and honest.

## Feature 5: crash-safe resume

### Scope

Chunk data and the chunk map are written together every 2 s, so a crash, force quit or power cut loses at most a few
seconds. On the next launch, downloads that were running resume, and a note says what happened.

### UI (prototype → app)

- `SavedAgo` in the inspector header: " · progress saved {s} s ago", title "Progress is saved every 2 seconds, so a
  crash, a force quit or a power cut loses at most a few seconds."
- `RecoveredBanner` at the top of Downloads: "Mergelane recovered after quitting unexpectedly" / "{n} download(s)
  picked up from the last save, {s} s before it quit. {bytes} fetched again; nothing else was lost." or "Nothing was
  downloading, so nothing was lost." + Dismiss.
- `CrashOverlay` is a prototype-only device; not ported.
- Settings › Downloads › "If something goes wrong" (`SafetySettings`): "Save progress every 2 seconds", tag "Always
  on", hint "Each chunk is written and its place in the file recorded together. After a crash, a force quit or a power
  cut, downloads resume from the last save."

### Engine changes

1. `CHECKPOINT_INTERVAL_MS` 15,000 → 2,000 (`downloadManager.ts:257`), only while a download is `downloading`
   (paused/queued ones save on change, as today).
2. **Order of a checkpoint** (keeps today's correct order, adds the missing flushes):
   1. snapshot the block frontiers (`saveBlocks`, already before the flush);
   2. flush the staging file with a full sync: `FileHandle.sync()`, which on macOS libuv turns into
      `fcntl(fd, F_FULLFSYNC)`, then F_BARRIERFSYNC, then `fsync` (libuv v1.52.1 `src/unix/fs.c`, `uv__fs_fsync`;
      Apple's `fsync(2)` man page: "The F_FULLFSYNC fcntl asks the drive to flush all buffered data to permanent
      storage"). **Correction at build time:** the first draft planned a koffi call; it isn't needed. On Windows it
      is `FlushFileBuffers`;
   3. write `manifest.json.tmp`, flush it the same way, `rename` over `manifest.json`;
   4. flush the folder (open it read-only and `fsync`, macOS only; Windows has no directory fsync and `rename` there
      is already retried, `jsonFile.ts:27-37`).
   The map on disk can therefore only ever claim bytes that were durable before it was written.
3. **Cost control.** `F_FULLFSYNC` flushes the whole drive cache and can take tens of milliseconds. One checkpoint
   loop for all running downloads (not one timer each), skip a download whose frontier didn't move, and if a
   checkpoint takes longer than 1 s, stretch the interval to 4 s and report "saved {s} s ago" honestly. Measure on
   the owner's SSD before choosing (part of the Phase 1 work).
4. **Crash marker.** New `main/session.ts`: at launch write `userData/session.json` `{pid, startedAt, cleanExit:
   false}`; on a clean quit (`before-quit` after `suspendAll`, `index.ts:409-425`) set `cleanExit: true`. Also write a
   heartbeat every 1 s without a flush (`lastAlive`, and per running download the in-memory received bytes). At the
   next launch, if `cleanExit` is false, it was a crash: `ago = lastAlive - savedAt` per download, `lostBytes = sum
   (heartbeat bytes - saved bytes)`. After a power cut the heartbeat itself may be stale; then report from the
   manifests' `savedAt` only and say less ("picked up from the last save").
5. **Resume after a crash.** `restoreOne` (`:1227-1231`) restores running downloads as `paused` today. After a crash,
   restore those whose last save says `downloading` as `queued`, ahead of those that were `queued`, which keep their
   order; `pump` restarts them. After a clean quit, keep today's behaviour (paused): D6.
6. **No new manifest version (as built).** The last save's own `state.status` says whether a download was running,
   so version 7 stays. A save cut off at its rename is read from its flushed `manifest.json.tmp` instead of a
   `manifest.prev.json`.
7. **"Reopens by itself."** The prototype's overlay says Mergelane reopens by itself after a crash. Nothing can
   relaunch an app after `kill -9` or a power cut without a launchd job; CLAUDE.md rules out `SMAppService`, and a
   LaunchAgent is a system change. Proposal: recover at the next launch (and at login if "Open at login" is on), and
   relaunch only after a JavaScript crash in main, where `app.relaunch()` can run (D5).
8. Torrents (verified pieces, bitfield) and video tracks (per-track `resume.json`) already resume from verified data;
   they join the 2 s loop for their manifests only.

### Edge cases

`.tmp` left behind (removed at launch, already; read first when the manifest is garbled or missing, as built); staging file shorter than the map (already handled, `:1266-1277`);
external disk unplugged (checkpoint fails soft, download pauses); split segments (in memory, refetched, counted in
`lostBytes`).

### Acceptance criteria

Progress saved every 2 s, shown in the inspector. After `kill -9` during a download, the next launch resumes it and
shows the banner with a count and bytes fetched again; at most about 2 s of data per download is fetched again; the
finished file is byte-identical to the origin.

### Test plan

- Unit: `shared/recovery.ts` (crash decision, `ago` and `lostBytes` maths, stale heartbeat, 90%+).
- Property test (fast-check, in `shared/`): a model of a non-durable disk where unflushed writes may be lost or torn;
  run random write/flush/rename/crash sequences through the checkpoint order and assert the restored map never
  claims bytes that were lost.
- e2e `e2e/crash.spec.ts`: start a throttled download, wait for "saved", `electronApp.process().kill('SIGKILL')`,
  relaunch with the same `MERGELANE_USER_DATA`, assert the banner text, the resumed state, the final SHA-256 equal to
  the origin's, and refetched bytes ≤ speed × 3 s. Variants: kill between manifest write and rename (test knob that
  aborts there); kill during publish.
- Simulated power loss: the property test above, plus a test knob that truncates `manifest.json.tmp` and drops the
  last N KiB of the staging file before restart.
- Manual (owner, optional, on an external drive only, never the boot disk): start a download to a USB drive, unplug
  the drive, re-plug, relaunch.

### Effort and risks

**M.** Risk: data loss in the journal (see Risks); the cost of `F_FULLFSYNC` every 2 s on some disks.

## Feature 6: expired-link recovery

### Scope

Detect expiry fast, move the download to Needs attention at its progress, accept a fresh link pasted or caught by the
extension, verify it is the same file before continuing, refuse otherwise.

### UI (prototype → app)

`FreshLinkPanel` at the top of the inspector for an expired download (replaces `FixLinkDialog` for this case; the
dialog stays for other failures):

- "The link expired at {pct}%" / "Links from {host} are signed and stop working after a while. Get a fresh one and
  Mergelane carries on from {bytes}. It checks the size and the server's file tag first, so nothing is fetched twice."
- Field "Paste the fresh link", Continue → "Checking…".
- Errors (`role="alert"`): "That isn't a link. Paste an address that starts with https://" and "That link is for
  {file}, not this download. Add it as a new download instead."
- Success toast: "Same file: the size and the server's file tag match. Continuing from {pct}%."
- "Open the download page" (opens `pageUrl`, the referrer the extension recorded) — the prototype's "paste an example
  fresh link" is prototype-only.
- Status word "Link expired"; History tag "Link expired"; the list's Needs attention group (`DownloadsScreen.tsx:70`).
- Settings › Downloads › "If something goes wrong": "Pick up fresh links from the browser" (`catchFreshLinks`), hint
  as in the prototype.

### Engine changes

- **State:** keep `DownloadStatus` as is (adding a status ripples through every screen and filter) and add
  `problem?: { kind: 'link-expired'; at: number }` to the download state, set in main. `linkExpired()` in the
  renderer reads it.
- **Detect fast** (`shared/linkExpiry.ts`, pure): a response of 401, 403 or 410 on a range request, or a 400 whose
  body names an expired signature, counts as expiry when (a) it comes from two networks, or (b) the URL is signed
  (query has a key like `expires`, `Expires`, `X-Amz-Expires`, `X-Amz-Signature`, `Signature`, `sig`, `token`,
  `exp`) — then one is enough. On expiry, stop every stream, checkpoint, set `problem`. No more strike counting for
  these. 404 stays a normal failure (often a real removal). Body sniffing reads at most 2 KiB.
- **Verify same file** in `replaceLink` (`:1737-1775`): re-probe; require the same `totalBytes` and range support
  (today); then if both the old and new have a strong ETag, they must match (fast path, no sampling); if they differ,
  refuse as "changed"; if either is missing, compare `Last-Modified` when both exist, and always run the existing
  sampled-bytes `compareWithDisk`. Store the new `etag`/`lastModified` (today's gap). Refusal reasons map to the
  prototype's messages; a file-name mismatch is checked first ("That link is for {file}…").
- **From the browser:** widen `failedMatch` (`:1803-1821`) to downloads with `problem.kind === 'link-expired'`, and
  allow ETag-less matches on name + size + sampled bytes. When `catchFreshLinks` is on and exactly one expired
  download matches, at `case 'confirm'` (`browserBridge.ts:160-166`, after the browser's copy is cancelled) call
  `relink` instead of `offer`, and show the success toast. When it's off or ambiguous, keep today's "Resume it" offer.
  No change to `BRIDGE_API = 3`: no new message fields.

### Edge cases

A fresh link to a server that drops range support (refuse, "can't continue, start again"); a CDN that returns a
different but equivalent ETag per edge (sampling decides, ETag is a hint only for "different"); a site that answers
403 to too many connections (two-network rule, plus the concurrency controller already treats 403 as a refusal);
video and torrent downloads (out of scope: streams re-resolve their manifests; torrents don't expire).

### Acceptance criteria

The download moves to Needs attention at the point it stopped. Pasting a fresh link, or clicking the download again
in the browser, carries on once the size and the server's file tag match; otherwise the prototype's refusal shows.
No byte already on disk is fetched again.

### Test plan

Unit: `linkExpiry.test.ts`, the verify decision table (90%+). e2e: `origin.ts` route that checks `?expires=` against a
clock knob; expire mid-download; assert state and panel; paste a fresh link (same file) → resumes, total bytes fetched
≈ file size; paste a link to a different file → refusal text; changed ETag → refusal; browser path with
`page-host/` and the extension e2e harness. Manual: a real signed S3 or Google Drive link with a short expiry.

### Effort and risks

**S/M.** Risk: misclassifying a temporary 403 as expiry (mitigated by the two-network rule for unsigned links; the
user can still press Resume).

## Feature 7: sleep prevention and the end of the queue

### Scope

Setting for today's keep-awake; when the queue finishes: nothing, sleep or shut down, after a 60-second cancellable
countdown.

### UI (prototype → app)

- Settings › General › "On this Mac" (`OnThisMacSettings.tsx`), `AwakeSettings`: "Keep the Mac awake while
  downloading" ("Only while something is downloading. The display can still sleep, and the Mac sleeps as usual when
  the queue is empty."), "When the queue finishes" Do nothing / Sleep / Shut down (hints as in the prototype). PC
  wording on Windows through `platformWords.ts`.
- `AwakeLine` under the Downloads list: "Keeping this Mac awake[, then sleep | , then shut down]".
- `QueueDoneNotice` (`role="alertdialog"`): "The queue is done" / "Your Mac will {sleep | shut down} in {n} s, as set
  in Settings › General.[ Apps with unsaved work can stop the shutdown.]", a draining bar, Cancel and "Sleep now" /
  "Shut down now" (autofocus). Cancel toast: "Staying awake. Your Mac sleeps on its usual schedule." Action
  "nothing": toast "The queue is done."

### Main changes

- `keepAwake()` (`downloadManager.ts:2055`) respects `keepAwake`, and also holds the blocker during the countdown.
- **Queue finished:** in `DownloadManager`, after any change that can empty the queue (`launch` end, `pump`, remove,
  pause), if the set of `downloading` plus unscheduled `queued` went from non-empty to empty, emit `queueEnded`. Pure
  rule in `shared/queueEnd.ts` (paused and scheduled downloads don't count; a download added during the countdown
  cancels it; an error ends the queue).
- **Countdown in main** (60 s timer, so a closed window doesn't stop it; the notice also shows a system notification
  if the window is hidden). At zero, `power.ts`:
  - macOS sleep: `pmset sleepnow` (Apple's `pmset(8)` man page: "sleepnow - causes an immediate system sleep"), no
    admin needed (to confirm in the Phase 1 work).
  - macOS shut down: an Apple event `kAEShutDown` to `loginwindow` (Apple QA1134: such a shutdown "can be cancelled
    by running applications", which gives the prototype's "Apps with unsaved work can stop the shutdown."). Sent via
    `osascript`. QA1134 is archived (2008); whether macOS 13+ asks for Automation permission for this is not
    verified and is part of Phase 1.
  - Windows sleep: `SetSuspendState(FALSE, FALSE, FALSE)` from `powrprof.dll` via koffi ("The calling process must
    have the SE_SHUTDOWN_NAME privilege").
  - Windows shut down: `shutdown /s /t 0`. Microsoft's docs say a time-out greater than 0 implies `/f` ("Forces
    running applications to close without warning users"), so use `/t 0`, never `/f`; apps with unsaved work get
    `WM_QUERYENDSESSION` and can block with `ShutdownBlockReasonCreate`.
  - Mergelane itself saves everything (`suspendAll`) before asking.

### Edge cases

Battery low; a download added during the countdown (cancel); the user cancels the system shutdown dialog (nothing
more happens); scheduled downloads later today (queue "finished" now, so warn in the notice: "A scheduled download
starts at {time}" — new copy, D10); system merge on (the daemon stays installed and cleans its routes on shutdown,
already required).

### Acceptance criteria

The Mac stays awake while something downloads (display can sleep); when the queue finishes it does nothing, sleeps
or shuts down after a 60-second countdown that Cancel stops.

### Test plan

Unit: `queueEnd.test.ts` (90%+). e2e: power actions stubbed by a test knob that records instead of acting (like
`testRecord('notifications')`); finish a queue with each setting; assert the notice text, countdown, cancel, "now";
assert the blocker is held (record its start/stop). Never actually sleeps or shuts down in tests. Manual: owner, once
each on the Mac and the Windows laptop, with an unsaved TextEdit/Notepad document open for the shutdown case.

### Effort and risks

**S.** Risk: macOS Automation permission prompt for the shutdown event; Windows privilege for sleep under some
policies.

## Feature 8: speed reports

### Scope

Per-day bytes per network and time saved; 7 days, 30 days, 12 weeks; optional Monday summary; CSV export; time saved
per finished download.

### UI (prototype → app)

`ReportsSection` and `ReportChart` → new `components/ReportsSection.tsx` on the Dashboard after the active downloads
(prototype order: before the usage panel):

- Title "Reports", segmented 7 days / 30 days / 12 weeks (all unlocked, see conflict 1).
- Stats: "Merging saved you" {time} "against your fastest single network"; Downloaded; Busiest day; Fastest merged
  speed.
- Share by network legend; stacked bars per day or week in network colours, keyboard-readable (arrows, Escape), the
  tooltip with each network, Total and "Saved by merging".
- Switch "A summary every Monday morning" ("The summary arrives as a notification: what you downloaded, each
  network's share and the time merging saved."), "Export CSV".
- Inspector of a finished download: "Saved by merging" {time} in place of Received when over 30 s.

### Main changes

- **Recording (Phase 2):** `network/limits.ts` already counts every byte Mergelane moves per network
  (`limits.ts:134-171`). Add a listener that accumulates per (local day, network) in memory and flushes to
  `usage_days` every 60 s and on quit (`ON CONFLICT DO UPDATE SET bytes = bytes + ?`). Downloads only (received
  bytes), not uploads or speed tests, so "Downloaded" means what it says.
- **Time saved per download (the brief's formula):** `saved = activeTime × (1 / f − 1)`, where `activeTime =
  completedAt − startedAt − totalPausedMs` and `f = max(bytes on one network) / total bytes`. Stored in
  `downloads.saved_ms` at finish. Zero when one network carried everything.
- **Time saved per day:** summing per-download values double-counts when downloads overlap (two downloads in the same
  minute each "save" that minute). Proposal: per minute, take all Mergelane download bytes per network in that
  minute, apply the same formula with `activeTime` = seconds with traffic in that minute, and add to that day's
  `saved_ms`; this never exceeds elapsed time. The per-download figure stays exactly the brief's formula (D11).
- **Queries** (`shared/reports.ts`, pure): bars for 7 and 30 days, 12 ISO weeks starting Monday, busiest, peak,
  shares; empty days filled with zeros; network names from the row (a network gone today still shows).
- **Monday summary:** at the first moment after Monday 09:00 local while Mergelane runs, if `weeklyReport` is on and
  not yet sent this week, a `Notification` with last week's total, shares and time saved. Clicking opens the
  Dashboard. If the app wasn't running Monday, it is sent at the next launch that week.
- **CSV:** `dialog.showSaveDialog`, default name `mergelane-report.csv`, default folder Downloads (the user picks; tests
  pass a path through a knob and never write to the real Downloads). Columns: `date,network,interface,bytes,
  saved_seconds` (one row per day and network; saved on the first row of each day). UTF-8, comma, ISO dates.
- **Retention:** keep all `usage_days` rows (one row per network per day: tiny). "Clear history" does not clear
  reports; a separate "Clear reports" row is not in the prototype (D12).

### Edge cases

Time-zone change and DST (days are local dates at the time of counting); clock jumps (ignore minutes with negative
elapsed time); a renamed network (id stays, name updated); first week (bars show only days with data).

### Acceptance criteria

The section, ranges, stats, chart and tooltip as in the prototype; time saved per finished download; Monday
notification when on; CSV with the chosen range.

### Test plan

Unit: `reports.test.ts` (formula, overlap rule, week bucketing, DST days, CSV rows, 90%+). e2e: test knob for "now",
two networks, finish downloads with known shares (origin throttled per network), assert stored rows, "Saved by
merging" on the inspector, the CSV written to a temp path, the notification recorded via `testRecord`. Manual: look at
a week of real data.

### Effort and risks

**M** (UI), **S** (recording). Risk: the time-saved figure overstates when networks share one upstream bottleneck;
the wording "against your fastest single network" is the honest qualifier and stays.

## Feature 9: choose files in torrents

### Scope

What is missing from what exists: subfolder rows with mixed ticks, "Videos only", the live summary, the "Choose at
least one file." alert, the shared-pieces note, in both New download and the inspector.

### UI (prototype → app)

`TorrentFiles` (prototype): header "All files" tick (mixed state), live "{n} of {m} files, {size}" (`aria-live`),
"Videos only" (mkv, mp4, mov, webm); folders first, Finder-like; each folder tick sets its files; per-file size, or
in the inspector progress bar and "{pct}%", "Skipped" for unticked; alert "Choose at least one file." Inspector
section "Files", aside "Change any time", note "A skipped file isn't downloaded. Pieces it shares with a chosen file
are, so a few MB of it can appear until the torrent finishes."

### Engine changes

None beyond what exists. File priorities (sequential, high/low) are not in WebTorrent's documented `file.select` API
beyond on/off and are not in the prototype; not planned. The shared-pieces note matches the engine: `torrent.deselect`
plus `file.select` fetches whole pieces, and `torrentDestination.ts` removes unwanted files at publish.

### Changes

New `shared/torrentTree.ts` (pure, from the prototype's `fileTree`, but recursive for any depth and both `/` and `\`
separators), used by `TorrentFiles.tsx` for both views. Live size is the sum of chosen file lengths. Changing the
choice while running keeps today's rules (a fully downloaded file can't be dropped: show it ticked and disabled with a
title saying why).

### Acceptance criteria and tests

As in the prototype. Unit: `torrentTree.test.ts` and component tests in `TorrentFiles.test.tsx` (90%+). e2e: extend
the existing torrent spec with `torrentSwarm.ts` and a multi-folder torrent like `FILM_PACK`; untick a subfolder before
start and one file while running; assert skipped files are absent after finishing.

### Effort and risks

**S.** Low risk.

## Dependencies and phases

```
Phase 1  journal ── expired links (uses the checkpoint)        sleep/queue end    torrent files
Phase 2  history store ── duplicates                            usage recording (same DB)
Phase 3  handover (uses NetworkEvent)                           reports UI (uses usage rows + downloads.saved_ms)
```

Each phase is one milestone branch with small PRs, e2e and unit tests in the same PRs, `docs/PROGRESS.md`,
`CHANGELOG.md` and an ADR per decision:

- **Phase 1** (3 PRs): crash-safe journal + recovery note; expired links + extension hand-off; sleep/queue end +
  torrent files. ADRs: checkpoint durability and `F_FULLFSYNC`; expiry detection; power actions.
- **Phase 2** (3 PRs): SQLite store + migration + History place; duplicates; usage recording. ADR: `node:sqlite`.
- **Phase 3** (2 PRs): handover; reports. ADR: handover rules and silence threshold.
- **With Phase 1:** add "Wireless iPhone lane (needs an Apple Developer account)" to the Later row of CLAUDE.md's
  roadmap, beside Developer ID signing, so the parked feature stays visible.

## Open questions and decisions

**All decided, owner, 2026-11-26:** "go ahead with your recommendations". Each answer below is the
recommendation it was given, now the decision. D1 is done (`design-system/mergelane/redesign/prototype-features.html`);
D5 and D6 are built (ADR-0077).

| # | Question | Decision |
|---|---|---|
| D1 | Save the newer prototype (version `1795691890-d752`) into the repository as the reference for these features? | Yes: `design-system/mergelane/redesign/prototype-features.html` with its SHA-256, README updated. |
| D2 | Build every feature free and drop the plan gating, badges and upgrade prompts in the prototype? | Yes, as CLAUDE.md requires. |
| D4 | Use Node's built-in `node:sqlite` (release candidate in Node 24) for history and reports? | Yes. It adds no dependency; keep all access behind `historyStore.ts` so a JSON fallback stays possible. |
| D5 | After a crash, "Mergelane reopens by itself" isn't possible after `kill -9` or a power cut without a launchd job. Recover at next launch instead? | Yes: recover at next launch (and at login if Open at login is on); relaunch only after a JavaScript crash. Change the copy. |
| D6 | Downloads running at a clean quit come back paused today. Resume them at the next launch too? | Yes, resume them, matching the crash case; paused-by-user stays paused. |
| D7 | "Download again" from History starts at once in the prototype. Open New download pre-filled instead? | Open New download, so the network choice and duplicate notice apply and nothing starts on its own. |
| D8 | Also treat the same torrent (infoHash) as a duplicate? | Yes; it's cheap and certain. |
| D9 | When a different site offers a file with the same name and size but publishes no SHA-256, warn? | No warning, as the prototype says: name and size alone give false alarms. |
| D10 | When the queue ends but a scheduled download comes later, still sleep or shut down? | Still act, but say so in the notice: "A scheduled download starts at {time}." |
| D11 | Time saved per day: sum the per-download figures, or the per-minute rule that can't exceed elapsed time? | Per-minute rule for days and weeks; the brief's formula for each download. |
| D12 | Should "Clear history" also clear reports? | No; add "Clear reports" later only if asked. |
| D13 | Store links in history in full (needed for Download again, may contain signing tokens), or seal them? | Store host and path in plain text for search, seal the full link with `safeStorage` (`secrets.ts`). |

### Decided

| # | Question | Answer |
|---|---|---|
| D3 | The wireless iPhone lane needs an iOS app, and an app needs a paid Apple Developer account to reach anyone but the owner. Get one, or park the feature? | Owner, 2026-11-26: no account. Park the wireless lane, keep the iPhone over USB, no spike for now. |

Two questions from the first draft, D14 (pairing by a matching code) and D15 (turning the lane off while a VPN is
active), went with feature 2. They are in the appendix.

## Risks

- **Data loss in the journal.** A map that claims unflushed bytes would publish a corrupt file. Mitigations: snapshot
  before flush (already), `F_FULLFSYNC` for data and manifest, folder flush, the temporary-manifest fallback, the
  property test over torn writes, end-to-end hash comparison in e2e, and the existing sampled-bytes checks on resume.
  The cost of flushing every 2 s is measured before the interval is fixed.
- **Privacy of history.** History holds every link and file name. It stays on the computer: `mergelane.db` in
  `userData` (`~/Library/Application Support/Mergelane` on macOS), file mode `0600`, never sent anywhere (no
  telemetry, consistent with CLAUDE.md), never included in the diagnostics bundle (`diagnostics.ts` gets an explicit
  exclusion and a test), and full links sealed with `safeStorage` (D13) so a copied database file doesn't expose
  signed links. Retention and Clear are real deletes (`DELETE` then `VACUUM` on clear). The footer and settings copy
  say "only on this Mac".
- **`node:sqlite` maturity.** Release candidate in Node 24; covered by D4's single access module and an e2e that opens
  the DB in the packaged app.
- **Handover regressions.** The scheduler is tuned; Phase 3 ships it alone with property tests and the existing chaos
  suite.
- **Power actions.** The shutdown Apple event may need Automation permission on current macOS (unverified); Windows
  sleep needs a privilege some policies remove. Both fail soft with a message.
- **Tests on the owner's Mac.** CI is paused, so the netsim lane can't run; local e2e uses the interface-list test
  seam, which doesn't exercise real sockets on real links. The manual steps above cover that gap.

## Verified sources

- Node.js 24 `node:sqlite`: nodejs.org/docs/latest-v24.x/api/sqlite.html (release candidate, no flag). Local check:
  `DatabaseSync` runs in Electron 45.4.1 (Node 24.22.3) with `ELECTRON_RUN_AS_NODE=1`.
- Node.js 24 `filehandle.sync()`: refers to POSIX `fsync(2)`; no mention of `F_FULLFSYNC` (fs.html). libuv:
  `uv_fs_fsync` "Equivalent to fsync(2)" (docs.libuv.org). libuv's source, v1.52.1 `src/unix/fs.c`
  (`uv__fs_fsync`), shows the Apple branch uses `F_FULLFSYNC` first (read when building Phase 1).
- Apple `fsync(2)` and `pmset(8)` man pages, read on the owner's Mac.
- Electron `powerSaveBlocker` and `powerMonitor`: electronjs.org/docs/latest.
- WebTorrent: webtorrent.io/docs (`file.select`, `file.deselect`, `torrent.deselect`, `deselect` option; the page is
  silent on shared pieces).
- Apple (read for feature 2, now parked): `includePeerToPeer`, `requiredInterfaceType`, `NWInterface.InterfaceType`, `prohibitedInterfaceTypes`,
  "Extending your app's background execution time", `NSLocalNetworkUsageDescription` (developer.apple.com docs
  JSON), App Review Guidelines (read in full), QA1134 (archived).
- Microsoft: `shutdown`, `SetSuspendState`, `SetThreadExecutionState`, "Shutting Down" (learn.microsoft.com).
- Not verified here: RFC 9530/3230 digest headers, SQLite's WAL and `synchronous` guidance, Network framework TLS PSK,
  Apple Developer Program price and terms, any carrier's tethering terms, IOPMAssertion types (Apple's page returned
  no body).

## Appendix: the wireless iPhone lane, first-draft notes (parked)

Kept in case D3 changes. Not part of any phase. This is a first draft, not reviewed. Two questions went with it:
D14, pairing by a matching code instead of a code typed in advance (a typed six-digit code is too weak to secure the
link), and D15, turning the lane off while a VPN is active (its traffic would bypass the Mac's VPN).

### Assessment first

This needs a spike before any commitment. Unknowns, each with what is and is not verified:

| Question | What the docs say | Not verified |
|---|---|---|
| Peer-to-peer Wi-Fi | `NWParameters.includePeerToPeer`: "A Boolean that enables peer-to-peer link technologies for connections and listeners." iOS 12+, macOS 10.14+. | The page never says AWDL. Whether it works for an ad-hoc-signed Mac app, and its throughput. |
| Forcing cellular on the phone | `NWParameters.requiredInterfaceType` takes `NWInterface.InterfaceType`, which has `.cellular`. | Whether iOS honours it while Wi-Fi is up and what happens with no cellular path. |
| Background | `applicationDidEnterBackground` "has five seconds"; "Shortly after that method returns, the system puts your app into the suspended state." Guideline 2.5.4: background services only "for their intended purposes: VoIP, audio playback, location, task completion, local notifications, etc." | No background mode fits a relay, so the lane works only while the app is in front (screen on). |
| App Review | No guideline mentions tethering or hotspots (I read the whole page, last updated 2026-10-16). 5.4 covers VPN apps (NEVPNManager, organisations only); this is not a VPN. | How a reviewer reads an app that relays another device's traffic over cellular. |
| Local network | `NSLocalNetworkUsageDescription` is required for "direct unicast or multicast connections to local hosts" (iOS 14+, macOS 11+). | Whether the Mac side, launched from Electron, gets the prompt correctly (the owner's VS Code already lacks this permission). |
| AWDL and Wi-Fi speed | — | AWDL shares the Wi-Fi radio, so Wi-Fi may slow down (the prototype says so). No Apple page I read quantifies it. The spike measures it. |
| Carrier rules | — | Many mobile plans restrict tethering. A relay app is tethering in effect; the UI must say it uses mobile data. I checked no carrier's terms. |
| Battery | — | Screen on plus cellular plus Wi-Fi radio. The prototype's "Plug in for long downloads" is the right message. |

**Spike S-iPhone (2 to 3 days, owner's own iPhone, free personal signing):** a minimal iOS app and a minimal Swift Mac
listener; measure (a) whether a peer-to-peer connection forms with Wi-Fi off a network and on one, (b) relay
throughput phone-cellular to Mac, (c) the Mac's Wi-Fi throughput with the link idle and busy, (d) what happens when
the phone locks or switches app, (e) whether the Mac listener works ad-hoc signed and from inside the Electron app's
bundle. Go/no-go: relay throughput at least 3 MB/s on 5G, Mac Wi-Fi loses under 20%, and suspension is detected in
under 2 s.

### Scope (if the spike passes and D3 allows)

macOS only for v1: Windows has no AWDL. The prototype's Windows copy ("It joins over your Wi-Fi network") describes a
LAN variant that can follow later. HTTP downloads only in v1; torrents later (their `connect` hook can use the same
lane).

### Design

- **Mac side, a new helper `mergelane-lane`** (Swift, arm64, ad-hoc signed, in `Contents/Resources`, like the other
  helpers). Electron cannot use the Network framework. It listens with `includePeerToPeer = true` and advertises a
  Bonjour service (`_mergelane-lane._tcp`); it talks to the main process over a Unix socket in `userData` with mode
  `0600`, the same pattern as the daemon socket. It runs as the user, never as root, and needs no entitlements beyond
  what an ad-hoc app has (to be confirmed by the spike). The app's `Info.plist` (`electron-builder.yml` `extendInfo`)
  gains `NSLocalNetworkUsageDescription` and `NSBonjourServices`.
- **Pairing.**
  - QR (primary): carries the Mac's long-term X25519 public key, a one-time 128-bit secret and the service name. The
    phone connects, both run an X25519 key exchange authenticated by the one-time secret, and both show the same six
    digits derived from the transcript (HKDF-SHA256). The user taps Pair on both.
  - Code (fallback): the phone lists nearby Macs; after an unauthenticated key exchange both show six digits derived
    from the transcript and the user confirms they match (numeric comparison). **Conflict with the prototype:** it
    shows "482 913" before the phone connects and asks the user to type it. A six-digit code typed in advance is too
    weak to key a connection (a recorded handshake can be brute-forced offline), and a comparison code can't exist
    before the phone connects. Proposal: show the code only at the "{phone} wants to pair. Check that it shows
    {code} too." step, and drop "enter 482 913" from the searching step.
  - Result: each side stores the other's public key. Mac: sealed with the existing `secrets.ts` (`safeStorage`) in the
    settings. Phone: Keychain. Forget deletes both.
- **Encryption.** Each connection: a Noise-style handshake (XX pattern) with the stored static keys, then
  ChaCha20-Poly1305 frames. Both ends are Swift (the Mac helper and the iOS app), so both use CryptoKit and the crypto
  lives in one Swift package shared by both, with test vectors. The main process sees only
  plaintext on its local socket. Alternative: TLS 1.3 with a pre-shared key (Node's docs say all TLS 1.3 ciphers are
  eligible for PSK); not chosen because the Network framework's PSK API is unverified here. The spike picks.
- **Wire protocol (version 1).** One peer-to-peer TCP connection per relayed stream (the engine opens 8 to 32), plus
  one control connection.
  - Control: JSON lines. `hello {v, phoneName, carrier, battery, charging}`; `status {cellularUp, battery}` every
    1 s; `pausing` sent from `applicationWillResignActive`; `bye`.
  - Stream: first frame `connect {host, port}`; the phone opens `NWConnection` with `requiredInterfaceType =
    .cellular` and replies `ok {localAddress}` or `error {code}`; then raw bytes both ways. TLS to the origin stays
    end to end between the Mac and the server: the phone relays bytes it can't read.
- **The lane.** A virtual network in the main process: `NetworkMonitor` (`interfaces.ts`) merges a `companion:<phoneId>`
  entry of a new kind `'companion'` into the interface list while the control connection is up. In `routes.ts`, the
  connection factory gets a branch beside `connectThroughProxy` (`:162-260`): for a companion network, connect to the
  helper's socket and send `connect`. Limits, data limits and routing apply as for any network (prototype: "Limits
  under Speed limits apply to it as they do to any network").
- **USB and wireless.** USB stays the existing iPhone USB network (Personal Hotspot over USB). Both carry the same
  mobile data, so both at once add nothing; the segmented control "Connect over: USB cable / Wireless" turns one off
  (`NetworkPreference.off`). The pairing record keeps the phone's name to match it with the USB network.
- **Paused or killed app.** `pausing` → the lane goes `standby` at once → feature 1's handover moves its blocks. A
  killed app or a lost link: 2 missed `status` beats (2 s) or a closed control connection → `offline` → handover.
  When the app comes back to the front, the lane rejoins and the controller adds streams as for any joining network.

### UI (prototype → app)

`CompanionPanel` → new `components/CompanionPanel.tsx` on the Networks screen after the network list. States: none
("Pair an iPhone"), searching (`PairCode` QR, "Scan this with your iPhone's camera", "Waiting for your iPhone…",
Cancel), confirm ("{phone} wants to pair", "Pair only phones you own: a paired phone can carry this Mac's downloads.",
Pair/Cancel), paired (tile, carrier, battery, "Mergelane open on the phone", "Connect over" control, the three
wireless notes, "Forget this iPhone"). The `PhoneMock` is a picture of the iOS app's sharing screen: the iOS app
implements that screen ("Sharing mobile data with {Mac}", speed, "{bytes} of mobile data today", battery note, "Stop
sharing").

### Storage

Pairing record (sealed) in settings. Per-day mobile-data bytes come from feature 8's `usage_days` like any network.

### Edge cases

Wi-Fi turned off on the Mac (AWDL needs the radio on); phone on Low Data Mode (`prohibitConstrainedPaths`); phone
with no signal (`status.cellularUp = false` → standby); two paired phones (v1: one); the Mac's VPN (the lane is not a
route, so the VPN rule is unaffected, but relayed traffic bypasses the Mac's VPN: show that in the panel and turn the
lane off while a VPN is active, matching the spirit of the VPN rule).

### Acceptance criteria

From the prototype copy: pair once with a code; switch between the cable and wireless in Networks; it keeps working
when the Mac leaves a Wi-Fi network; if iOS pauses the app, its chunks move to the other networks and come back when
the user returns to the app; the panel says the direct link may slow Wi-Fi and that it uses mobile data.

### Test plan

- Unit: framing, handshake and pairing transcript (Swift package tests on both platforms with shared vectors); a TS
  model of the lane state machine in `shared/companion.ts` (90%+).
- e2e: a fake helper on the Unix socket (like `fakeDaemon.ts`) that relays to `origin.ts`; pair, download over it,
  send `pausing`, assert handover and resume.
- Manual: owner's iPhone, Mac on and off Wi-Fi, lock the phone mid-download, kill the app, switch USB/wireless.

### Effort and risks

**L** (iOS app, Swift helper, pairing, crypto, lane). Biggest risks: D3 (no account, no shipping), App Review, AWDL
behaviour unverified, iOS suspension limiting it to screen-on use, custom crypto (mitigated by standard primitives,
a standard Noise pattern, shared vectors and a review before release).
