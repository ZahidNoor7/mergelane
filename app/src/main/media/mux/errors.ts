/** What went wrong, for code that branches on it (the message is for people). */
export type MuxErrorCode =
  /** An input file isn't there (or isn't a regular file) when the job starts. */
  | 'input-missing'
  /** The FFmpeg program could not be started at all. */
  | 'tool-missing'
  /** FFmpeg ran but failed, crashed, or produced no file. */
  | 'ffmpeg-failed'
  /** The finished file could not be written to, or moved into, the output folder. */
  | 'output-failed'

/** Every error this module throws on purpose. `message` is written to be shown to the user as is;
 * `detail` holds FFmpeg's own last words (stderr) and system error text for logs and bug reports,
 * and never appears in `message`. Aborts are not MuxErrors: they reject with the signal's reason,
 * as the platform does. Misuse of the API (a relative path, output equal to an input) throws a
 * TypeError instead. */
export class MuxError extends Error {
  constructor(
    readonly code: MuxErrorCode,
    message: string,
    /** Technical text for logs: exit status and the last lines FFmpeg wrote to stderr. */
    readonly detail?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'MuxError'
  }
}
