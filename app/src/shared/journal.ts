// The order a download's progress is saved in (docs/plans/2026-11-new-features-plan.md, feature 5).
// The chunk map may only ever claim bytes that are already safe on the drive, or a crash or power
// cut could leave it pointing at bytes that never got there, and the finished file would be wrong.
// The disk is passed in, so a model of one that loses unflushed writes can test the order
// (journal.test.ts); main/download/downloadManager.ts passes the real one.

export interface JournalDisk {
  /** Flushes the download's data to the drive (on macOS, Node's sync uses F_FULLFSYNC). */
  flushData(): Promise<void>
  /** Writes the map to a temporary file beside it and flushes that file. */
  writeTemporary(text: string): Promise<void>
  /** Renames the temporary file over the map: the map is then the old one or the new one, whole. */
  replace(): Promise<void>
  /** Flushes the folder, so the rename itself survives a power cut. */
  flushFolder(): Promise<void>
}

/**
 * Saves one checkpoint. `map` is the chunk map as it stands now, taken before the data is flushed:
 * bytes written after it are flushed too, but it doesn't claim them, so whatever it claims is on the
 * drive once the flush returns. `flushData` is false for a download with no data in progress
 * (finished or failed), whose map alone changed.
 */
export async function saveCheckpoint(
  disk: JournalDisk,
  map: string,
  flushData: boolean
): Promise<void> {
  if (flushData) await disk.flushData()
  await disk.writeTemporary(map)
  await disk.replace()
  await disk.flushFolder()
}
