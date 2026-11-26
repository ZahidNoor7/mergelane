import { formatBytes } from './speedText'

// Crash-safe resume (docs/plans/2026-11-new-features-plan.md, feature 5): how often a running
// download's progress is saved, how a launch tells that the last one crashed, and what the
// recovery note says. The main process keeps the record in session.json in userData
// (main/session.ts); everything here is pure, so it is unit-tested on its own.

/** A running download's progress is saved this often: chunk data first, then the chunk map. */
export const CHECKPOINT_MS = 2_000

/** And never less often than this, however slow the drive. */
export const CHECKPOINT_MAX_MS = 15_000

/** How long to wait before the next save, given how long the last one took. A save flushes the
 * drive, which a slow destination (a USB stick, a network share) can take a while over; waiting
 * four times as long as the last save took keeps the flushing to a fifth of the time at most. */
export function checkpointDelay(lastSaveMs: number): number {
  if (!Number.isFinite(lastSaveMs) || lastSaveMs <= 0) return CHECKPOINT_MS
  return Math.min(CHECKPOINT_MAX_MS, Math.max(CHECKPOINT_MS, Math.round(lastSaveMs * 4)))
}

/** While anything downloads, how often the launch notes that it's alive and how far each download
 * has got (not flushed: a crash keeps it, a power cut may not). */
export const HEARTBEAT_MS = 1_000

/** What one launch leaves for the next: whether it ended cleanly, and, while downloads ran, the
 * last time it was alive and how far each had got in memory then. */
export interface SessionRecord {
  version: 1
  startedAt: number
  /** Set only once a quit has paused and saved every download. */
  cleanExit: boolean
  /** The last heartbeat while something was downloading, in ms since the epoch. */
  aliveAt?: number
  /** Bytes each running download had received at `aliveAt`, by download id. */
  running?: Record<string, number>
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The record as read back, or undefined when there is none or it can't be trusted. */
export function sessionFrom(value: unknown): SessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<SessionRecord>
  if (record.version !== 1 || !isCount(record.startedAt) || typeof record.cleanExit !== 'boolean') {
    return undefined
  }
  const session: SessionRecord = {
    version: 1,
    startedAt: record.startedAt,
    cleanExit: record.cleanExit
  }
  if (isCount(record.aliveAt)) session.aliveAt = record.aliveAt
  if (typeof record.running === 'object' && record.running !== null) {
    const running: Record<string, number> = {}
    for (const [id, bytes] of Object.entries(record.running)) {
      if (isCount(bytes)) running[id] = bytes
    }
    session.running = running
  }
  return session
}

/** A saved download as the launch found it. */
export interface RestoredDownload {
  id: string
  /** Its last save says it was downloading: only a crash leaves that, since a quit pauses first. */
  wasDownloading: boolean
  /** When it was last saved. */
  savedAt: number
  /** Bytes its last save holds. */
  savedBytes: number
}

/** What the Downloads screen says after a crash. */
export interface RecoveryNote {
  /** Downloads picked up from their last save. */
  count: number
  /** Bytes they had received after their last save, which are fetched again. Unset when the last
   * heartbeat didn't survive (a power cut can take it), so it isn't known. */
  lostBytes?: number
  /** How long before Mergelane quit their last save was, at most. Unset when not known. */
  agoMs?: number
}

/** Whether the last launch ended without a clean quit. With no record (none yet, or one a power cut
 * garbled), a save that still says "downloading" is the tell: a quit pauses every download first. */
export function crashed(
  previous: SessionRecord | undefined,
  restored: readonly RestoredDownload[]
): boolean {
  if (previous) return !previous.cleanExit
  return restored.some((download) => download.wasDownloading)
}

/** The note for this launch, or undefined when the last one ended cleanly. */
export function recoveryNote(
  previous: SessionRecord | undefined,
  restored: readonly RestoredDownload[]
): RecoveryNote | undefined {
  if (!crashed(previous, restored)) return undefined
  const resumed = restored.filter((download) => download.wasDownloading)
  const note: RecoveryNote = { count: resumed.length }
  if (resumed.length === 0) return note
  const aliveAt = previous?.aliveAt
  const running = previous?.running
  // The last heartbeat says how far each download had got. One a little older than a save is the
  // usual case (the crash came within a beat of the save), and the save then holds nearly all of
  // it. One older than that means later beats were lost (a power cut), so it says nothing.
  const known =
    aliveAt !== undefined &&
    running !== undefined &&
    resumed.every(
      (download) => download.id in running && aliveAt >= download.savedAt - 2 * HEARTBEAT_MS
    )
  if (!known) return note
  note.lostBytes = resumed.reduce(
    (sum, download) => sum + Math.max(0, running[download.id] - download.savedBytes),
    0
  )
  note.agoMs = Math.max(0, ...resumed.map((download) => aliveAt - download.savedAt))
  return note
}

/** What the note says under its title (the design's RecoveredBanner). */
export function recoveryMessage(note: RecoveryNote): string {
  if (note.count === 0) return 'Nothing was downloading, so nothing was lost.'
  const downloads = `${note.count} download${note.count === 1 ? '' : 's'}`
  if (note.agoMs === undefined || note.lostBytes === undefined) {
    return `${downloads} picked up from the last save; nothing else was lost.`
  }
  const seconds = Math.max(1, Math.round(note.agoMs / 1000))
  const saved = `${downloads} picked up from the last save, ${seconds} s before it quit.`
  return note.lostBytes > 0
    ? `${saved} ${formatBytes(note.lostBytes)} fetched again; nothing else was lost.`
    : `${saved} Nothing was lost.`
}
