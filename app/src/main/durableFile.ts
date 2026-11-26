import { open } from 'node:fs/promises'

// Writes that must survive a power cut, not just a crash (docs/plans/2026-11-new-features-plan.md,
// feature 5). On macOS, Node's FileHandle.sync() asks libuv, which uses fcntl F_FULLFSYNC: the
// drive flushes its own cache too (libuv src/unix/fs.c, uv__fs_fsync). Plain fsync(2) wouldn't
// (Apple's fsync(2) man page). On Windows it is FlushFileBuffers.

/** Writes `text` to `path`, replacing it, and flushes it to the drive before returning. */
export async function writeFlushed(path: string, text: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(text, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Flushes a folder, so a rename in it survives a power cut. Best effort: Windows has no way to
 * open a folder for this, and some file systems refuse it; the rename has happened either way. */
export async function flushFolder(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Not supported here: the file's own flush still holds its bytes.
  }
}
