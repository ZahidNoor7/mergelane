import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadFile } from '../downloadFile'

/**
 * Where a stream download works: a staging folder, `<final name>.mergelane/`, beside the file it
 * becomes (see reserveStagingFolder). Each track's segments wait in `<track>.parts/` with the
 * segment downloader's resume record, are joined into `<track>.track`, and FFmpeg combines the
 * tracks into the final file in the same folder as the staging one. The folder is the download's
 * alone, so discarding it can't cost the user a file.
 */
export class StreamDestination extends DownloadFile {
  /** The finished file FFmpeg wrote, once it has. */
  output: string | null = null

  /** `reported`: what size() answers while the folder is there (see size). */
  constructor(
    path: string,
    private readonly reported: () => number
  ) {
    super(path)
  }

  /** Where track `role` is saved once all its segments are in. */
  trackPath(role: 'video' | 'audio'): string {
    return join(this.path, `${role}.track`)
  }

  /** Where track `role`'s segments wait, with their resume record. */
  workDirectory(role: 'video' | 'audio'): string {
    return join(this.path, `${role}.parts`)
  }

  /** Its segments are files of their own, each checked by the segment downloader's resume record
   * rather than by an offset in one file: while the folder is there, it reports the download's
   * size so far, which every segment fits in. Throws when the folder is gone. */
  async size(): Promise<number> {
    const folder = await stat(this.path)
    if (!folder.isDirectory()) throw new Error(`${this.path} is not a folder`)
    return this.reported()
  }

  /** Each segment is synced as it is saved (see downloadHlsTrack): nothing is left to sync. */
  sync(): Promise<void> {
    return Promise.resolve()
  }

  /** Already in place: FFmpeg wrote the file where it goes. */
  async publish(
    _destinationPath: string,
    _expectedBytes: number,
    beforeAttempt: (candidate: string) => Promise<void>
  ): Promise<string> {
    if (this.output === null) throw new Error('The video’s tracks haven’t been joined yet.')
    await stat(this.output)
    await beforeAttempt(this.output)
    return this.output
  }

  /** The staging folder, and a file FFmpeg finished for a download that then didn't. */
  async discard(): Promise<void> {
    await this.discardLeftover()
    if (this.output !== null) await rm(this.output, { force: true })
    this.output = null
  }

  /** The staging folder: once the file is published, nothing in it is needed. Only ever a
   * `.mergelane` folder, so a damaged manifest can't point this at the user's own. */
  async discardLeftover(): Promise<void> {
    if (!this.path.endsWith('.mergelane')) return
    await rm(this.path, { recursive: true, force: true })
  }
}
