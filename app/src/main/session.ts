import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HEARTBEAT_MS, sessionFrom, type SessionRecord } from '../shared/recovery'
import { flushFolder, writeFlushed } from './durableFile'
import { renameWithRetry } from './jsonFile'

// How a launch tells that the one before it crashed (docs/plans/2026-11-new-features-plan.md,
// feature 5). session.json in userData says whether the last launch quit cleanly and, while
// downloads ran, how far each had got a moment before it stopped. The rules are in
// shared/recovery.ts.

export const sessionPath = (): string => join(app.getPath('userData'), 'session.json')

export class Session {
  private record: SessionRecord
  private chain: Promise<void> = Promise.resolve()
  private timer?: NodeJS.Timeout
  /** The last heartbeat listed no download, so another empty one would say nothing new. */
  private idle = true

  private constructor(
    /** What the last launch left, if anything could be read. */
    readonly previous: SessionRecord | undefined,
    private readonly path: string
  ) {
    this.record = { version: 1, startedAt: Date.now(), cleanExit: false }
  }

  /** Reads what the last launch left, then marks this one as running, flushed, so that a power cut
   * right after it still reads as this launch not having quit. */
  static async open(path = sessionPath()): Promise<Session> {
    const previous = sessionFrom(
      await readFile(path, 'utf-8')
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined)
    )
    const session = new Session(previous, path)
    await session.write(true).catch(() => {})
    return session
  }

  /** Every HEARTBEAT_MS, while `running` lists downloads, notes the time and how many bytes each
   * has in memory. Not flushed: it is only a hint for the recovery note, and flushing it every
   * second would wear on a slow drive for nothing. */
  startHeartbeat(running: () => Record<string, number>): void {
    clearInterval(this.timer)
    this.timer = setInterval(() => {
      const now = running()
      const busy = Object.keys(now).length > 0
      if (!busy && this.idle) return
      this.idle = !busy
      this.record = { ...this.record, aliveAt: Date.now(), running: now }
      void this.write(false).catch(() => {})
    }, HEARTBEAT_MS)
    this.timer.unref()
  }

  /** Marks a clean quit, flushed. Called only once every download is paused and saved. */
  async end(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    this.record = { version: 1, startedAt: this.record.startedAt, cleanExit: true }
    await this.write(true)
  }

  /** One write at a time, each through a temporary file, so a crash mid-write leaves the last
   * whole record. */
  private write(flush: boolean): Promise<void> {
    const text = JSON.stringify(this.record)
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        const temporary = `${this.path}.${process.pid}.tmp`
        if (flush) await writeFlushed(temporary, text)
        else await writeFile(temporary, text, 'utf-8')
        await renameWithRetry(temporary, this.path)
        if (flush) await flushFolder(dirname(this.path))
      })
    this.chain = next
    return next
  }
}
