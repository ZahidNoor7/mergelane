import { app } from 'electron'
import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  hostOf,
  keepSince,
  plainLink,
  type FileState,
  type HistoryEntry,
  type HistoryKeep
} from '../../shared/history'
import type { DuplicateCandidate } from '../../shared/duplicates'
import type { DownloadState, FinishedDownload } from '../../shared/types'
import { readJson } from '../jsonFile'
import { sealText, unsealText } from '../secrets'
import { testKnobs } from '../testKnobs'
import { database } from './database'

// Download history (ADR-0080): every download Mergelane has started, in userData/mergelane.db, kept
// until the setting's time is up whether or not it's still in the list. Removing a download from
// the list, or deleting its file, leaves it here. The finished ones still in the list are what the
// window lists under Finished (listHistory, as download/history.ts did from history.json).
//
// A link's query, where signed links carry their signature, is never stored in the clear: `link` is
// the link without it, and the whole link is sealed with the keychain (secrets.ts), unless it has no
// query, or the computer can't seal, when it's kept as it is.

/** The most finished downloads the list keeps; older ones leave the list for History alone. */
const LISTED_MAX = 500

interface Row {
  id: string
  kind: HistoryEntry['kind']
  name: string
  link: string
  link_sealed: string | null
  link_full: string | null
  host: string
  size: number
  started_at: number
  completed_at: number | null
  ended: 'completed' | 'cancelled' | null
  in_list: number
  path: string
  finished: string | null
  sha256: string | null
  info_hash: string | null
}

/** Links opened this launch, by download: unsealing asks the keychain each time. */
const unsealed = new Map<string, string>()

async function linkFields(
  id: string,
  url: string
): Promise<{ link: string; host: string; link_sealed: string | null; link_full: string | null }> {
  unsealed.set(id, url)
  const link = plainLink(url)
  const host = hostOf(url)
  if (link === url) return { link, host, link_sealed: null, link_full: url }
  const sealed = await sealText(url).catch(() => undefined)
  return sealed
    ? { link, host, link_sealed: sealed, link_full: null }
    : { link, host, link_sealed: null, link_full: url }
}

/** A row's whole link; the link without its query when the keychain won't open it. */
async function fullLink(row: Row): Promise<string> {
  if (row.link_full) return row.link_full
  const known = unsealed.get(row.id)
  if (known) return known
  if (row.link_sealed) {
    const opened = await unsealText(row.link_sealed).catch(() => undefined)
    if (opened) {
      unsealed.set(row.id, opened.text)
      return opened.text
    }
  }
  return row.link
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

let ready: Promise<void> | null = null

/** The database opened, and history.json (where history was kept before) brought in once. */
function opened(): Promise<void> {
  ready ??= importOldHistory()
  return ready
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** history.json's entries, kept only if they have what the window reads off every one. */
function oldEntries(parsed: unknown): FinishedDownload[] {
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (value): value is FinishedDownload =>
      isRecord(value) &&
      typeof value.id === 'string' &&
      (value.kind === 'http' ||
        value.kind === 'torrent' ||
        value.kind === 'nzb' ||
        value.kind === 'stream') &&
      typeof value.url === 'string' &&
      typeof value.fileName === 'string' &&
      typeof value.destinationPath === 'string' &&
      typeof value.totalBytes === 'number' &&
      typeof value.bytesDownloaded === 'number' &&
      typeof value.startedAt === 'number' &&
      typeof value.completedAt === 'number' &&
      typeof value.unitsWritten === 'number' &&
      Array.isArray(value.networks) &&
      value.networks.every(isRecord)
  )
}

async function importOldHistory(): Promise<void> {
  database()
  const path = join(app.getPath('userData'), 'history.json')
  const entries = oldEntries(await readJson(path).catch(() => undefined))
  if (entries.length === 0 && !(await exists(path))) return
  // Oldest first, so each keeps its place; finished, so in the list as they were.
  for (const entry of [...entries].reverse()) await writeFinished(entry)
  // Kept beside it for one release, then deleted (ADR-0080).
  await rename(path, `${path}.imported`).catch(() => {})
}

async function writeFinished(entry: FinishedDownload): Promise<void> {
  const { missing: omitted, ...kept } = entry
  void omitted
  const fields = await linkFields(entry.id, entry.url)
  const finished = JSON.stringify({ ...kept, url: fields.link })
  database()
    .prepare(
      `INSERT INTO downloads (id, kind, name, link, link_sealed, link_full, host, size, started_at,
         completed_at, ended, in_list, path, finished)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
         link = excluded.link, link_sealed = excluded.link_sealed, link_full = excluded.link_full,
         host = excluded.host, size = excluded.size, completed_at = excluded.completed_at,
         ended = 'completed', in_list = 1, path = excluded.path, finished = excluded.finished`
    )
    .run(
      entry.id,
      entry.kind,
      entry.fileName,
      fields.link,
      fields.link_sealed,
      fields.link_full,
      fields.host,
      entry.totalBytes,
      entry.startedAt,
      entry.completedAt ?? Date.now(),
      entry.destinationPath,
      finished
    )
  // Past the list's limit, the oldest leave the list (not History).
  database()
    .prepare(
      `UPDATE downloads SET in_list = 0 WHERE ended = 'completed' AND in_list = 1 AND id NOT IN (
         SELECT id FROM downloads WHERE ended = 'completed' AND in_list = 1
         ORDER BY completed_at DESC LIMIT ?)`
    )
    .run(LISTED_MAX)
}

/** A download started (or found at launch, from before history): it is in History from now on. */
export async function recordStart(state: DownloadState, infoHash?: string): Promise<void> {
  await opened()
  const fields = await linkFields(state.id, state.url)
  database()
    .prepare(
      `INSERT OR IGNORE INTO downloads (id, kind, name, link, link_sealed, link_full, host, size,
         started_at, path, info_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      state.id,
      state.kind,
      state.fileName,
      fields.link,
      fields.link_sealed,
      fields.link_full,
      fields.host,
      state.totalBytes,
      state.startedAt,
      state.destinationPath,
      infoHash ?? null
    )
}

/** A finished file's SHA-256, once worked out (ADR-0081). */
export async function recordSha256(id: string, sha256: string): Promise<void> {
  await opened()
  database().prepare('UPDATE downloads SET sha256 = ? WHERE id = ?').run(sha256, id)
}

/** The finished downloads, still on disk, that a new one could be the same as: by its link, its
 * file name, or its info hash (shared/duplicates.ts decides). Newest first. */
export async function duplicateCandidates(query: {
  link: string
  name: string
  infoHash?: string
}): Promise<DuplicateCandidate[]> {
  await opened()
  const rows = database()
    .prepare(
      `SELECT * FROM downloads WHERE ended = 'completed' AND (link = ? OR name = ? OR info_hash = ?)
       ORDER BY completed_at DESC LIMIT 50`
    )
    .all(query.link, query.name, query.infoHash ?? '') as unknown as Row[]
  const present = await Promise.all(rows.map((row) => exists(row.path)))
  return rows
    .filter((_, index) => present[index])
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      link: row.link,
      host: row.host,
      size: row.size,
      live: false,
      path: row.path,
      ...(row.completed_at !== null && { completedAt: row.completed_at }),
      ...(row.sha256 && { sha256: row.sha256 }),
      ...(row.info_hash && { infoHash: row.info_hash })
    }))
}

/** A test run can hold a finished download's save here, to act while it is pending
 * (e2e/removal.spec.ts). Never in a packaged app: testKnobs are empty there. */
async function testGate(): Promise<void> {
  if (!testKnobs.userDataDir) return
  const gate = (globalThis as Record<string, unknown>).__mergelaneHistoryGate as
    { reached: () => void; held: Promise<void> } | undefined
  if (!gate) return
  gate.reached()
  await gate.held
}

/** It finished: listed under Finished, and in History. */
export async function addToHistory(entry: FinishedDownload): Promise<void> {
  await opened()
  await testGate()
  await writeFinished(entry)
}

/** Every finished download still in the list, newest first, each marked `missing` when its file
 * is gone. */
export async function listHistory(): Promise<FinishedDownload[]> {
  await opened()
  const rows = database()
    .prepare(
      `SELECT * FROM downloads WHERE ended = 'completed' AND in_list = 1 AND finished IS NOT NULL
       ORDER BY completed_at DESC`
    )
    .all() as unknown as Row[]
  return Promise.all(rows.map(finishedOf))
}

async function finishedOf(row: Row): Promise<FinishedDownload> {
  const entry = JSON.parse(row.finished as string) as FinishedDownload
  return { ...entry, url: await fullLink(row), missing: !(await exists(entry.destinationPath)) }
}

/** One finished download still in the list, its file checked alone. */
export async function findInHistory(id: string): Promise<FinishedDownload | undefined> {
  await opened()
  const row = database()
    .prepare(
      `SELECT * FROM downloads WHERE id = ? AND ended = 'completed' AND in_list = 1
       AND finished IS NOT NULL`
    )
    .get(id) as unknown as Row | undefined
  return row ? finishedOf(row) : undefined
}

/** Takes these finished downloads (none given: every one) out of the list. History keeps them,
 * and their files stay. */
export async function removeFromHistory(ids?: string[]): Promise<void> {
  await opened()
  const db = database()
  if (!ids) {
    db.prepare(`UPDATE downloads SET in_list = 0 WHERE ended = 'completed'`).run()
    return
  }
  const statement = db.prepare(
    `UPDATE downloads SET in_list = 0 WHERE id = ? AND ended = 'completed'`
  )
  for (const id of ids) statement.run(id)
}

/** An unfinished download removed from the list: History says it stopped, its partial file gone. */
export async function recordRemoved(state: DownloadState): Promise<void> {
  await recordStart(state)
  database()
    .prepare(
      `UPDATE downloads SET ended = 'cancelled', in_list = 0, size = ?
       WHERE id = ? AND ended IS NULL`
    )
    .run(state.totalBytes, state.id)
}

/** Everything History lists, but the downloads in the list unfinished (the window has those live),
 * each with where its file is now. */
export async function historyEntries(live: ReadonlySet<string>): Promise<HistoryEntry[]> {
  await opened()
  const rows = (
    database().prepare('SELECT * FROM downloads ORDER BY started_at DESC').all() as unknown as Row[]
  ).filter((row) => !live.has(row.id))
  return Promise.all(
    rows.map(async (row) => {
      const file: FileState =
        row.ended === 'completed'
          ? (await exists(row.path))
            ? 'on_disk'
            : 'missing'
          : row.ended === 'cancelled'
            ? 'stopped'
            : 'partial'
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        link: row.link,
        host: row.host,
        size: row.size,
        startedAt: row.started_at,
        ...(row.completed_at !== null && { completedAt: row.completed_at }),
        ...(row.ended && { ended: row.ended }),
        inList: row.in_list === 1,
        path: row.path,
        file
      }
    })
  )
}

/** An entry's whole link, for Download again and Copy link. */
export async function historyLink(id: string): Promise<string | undefined> {
  await opened()
  const row = database().prepare('SELECT * FROM downloads WHERE id = ?').get(id) as unknown as
    Row | undefined
  return row ? fullLink(row) : undefined
}

/** Where an entry's file was saved, if it is there. */
export async function historyFile(id: string): Promise<string | undefined> {
  await opened()
  const row = database().prepare('SELECT path FROM downloads WHERE id = ?').get(id) as
    { path: string } | undefined
  return row && (await exists(row.path)) ? row.path : undefined
}

/** Forgets every download no longer in the list. Files aren't touched. */
export async function forgetHistory(): Promise<number> {
  await opened()
  const db = database()
  const { changes } = db
    .prepare('DELETE FROM downloads WHERE in_list = 0 AND ended IS NOT NULL')
    .run()
  db.exec('VACUUM')
  return Number(changes)
}

/** Forgets what is past the setting's time and no longer in the list. */
export async function pruneHistory(keep: HistoryKeep, now = Date.now()): Promise<number> {
  await opened()
  const since = keepSince(keep, now)
  if (since === null) return 0
  const { changes } = database()
    .prepare('DELETE FROM downloads WHERE in_list = 0 AND ended IS NOT NULL AND started_at < ?')
    .run(since)
  return Number(changes)
}
