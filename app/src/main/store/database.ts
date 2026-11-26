import { app } from 'electron'
import { chmodSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// userData/mergelane.db: download history now, daily usage later (docs/plans/2026-11-new-features-plan.md,
// ADR-0080). Node's built-in SQLite (node:sqlite, "Release candidate" in Node 24), one connection,
// in the main process only. SQLite's own docs (sqlite.org) for the settings below:
// - journal_mode=WAL is "persistent" and "uses many fewer fsync() operations"; it "does not work over
//   a network filesystem", and userData is always local.
// - synchronous=FULL: with NORMAL, "a transaction committed in WAL mode … might roll back following a
//   power loss"; FULL adds "an additional sync operation of the WAL file … after each transaction
//   commit". History writes are rare, so durability costs nothing here.
// - secure_delete=ON "overwrites deleted content with zeros", so forgotten history isn't left in the
//   file's free pages; Clear history also runs VACUUM, which "will clean the database of all traces of
//   deleted content".

/** Each step takes the schema one version further; PRAGMA user_version says how far a file is. */
const MIGRATIONS: readonly string[] = [
  // 1: download history (ADR-0080).
  `CREATE TABLE downloads (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     link TEXT NOT NULL,
     link_sealed TEXT,
     link_full TEXT,
     host TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER NOT NULL,
     completed_at INTEGER,
     ended TEXT,
     in_list INTEGER NOT NULL DEFAULT 1,
     path TEXT NOT NULL,
     finished TEXT
   );
   CREATE INDEX downloads_started ON downloads(started_at DESC);
   CREATE INDEX downloads_link ON downloads(link);
   CREATE INDEX downloads_name_size ON downloads(name, size);`,
  // 2: what tells a duplicate (ADR-0081): a finished file's SHA-256, and a torrent's info hash.
  `ALTER TABLE downloads ADD COLUMN sha256 TEXT;
   ALTER TABLE downloads ADD COLUMN info_hash TEXT;
   CREATE INDEX downloads_sha ON downloads(sha256);
   CREATE INDEX downloads_hash ON downloads(info_hash);`
]

export const SCHEMA_VERSION = MIGRATIONS.length

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  for (let step = version; step < MIGRATIONS.length; step++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[step])
      db.exec(`PRAGMA user_version = ${step + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    // Only this user may read it: it lists every link and file name (ADR-0080).
    chmodSync(path, 0o600)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA secure_delete = ON')
    const { quick_check: check } = db.prepare('PRAGMA quick_check').get() as {
      quick_check: string
    }
    if (check !== 'ok') throw new Error(`The history database is damaged: ${check}`)
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Opens the database at `path`, made or brought up to date. One that can't be read is set aside
 * (renamed, with its -wal and -shm files) and a new one started: history is worth less than an app
 * that opens. */
export function openDatabase(path: string): DatabaseSync {
  try {
    return connect(path)
  } catch {
    const aside = `${path}.damaged-${Date.now()}`
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix)
    }
    return connect(path)
  }
}

let opened: DatabaseSync | null = null

export const databasePath = (): string => join(app.getPath('userData'), 'mergelane.db')

/** This launch's connection, opened on first use. */
export function database(): DatabaseSync {
  opened ??= openDatabase(databasePath())
  return opened
}

/** Closed at quit, which checkpoints the WAL into the file. */
export function closeDatabase(): void {
  opened?.close()
  opened = null
}
