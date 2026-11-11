import { extname, resolve } from 'node:path'
import { containerForCodecs, type Container } from './codecs'
import { assertAbsolute, runJob, type JobInput, type JobOptions } from './run'

/** A container, or `'auto'` to pick one from the codecs (see {@link containerForCodecs}). */
export type ContainerChoice = Container | 'auto'

/** Options every job takes for choosing its container. */
export interface ContainerOptions {
  /**
   * `'mp4'` or `'mkv'` writes that container to `output` exactly as named. `'auto'` picks MP4 when
   * every codec in `codecs` fits it, else MKV, and gives `output` the matching extension: a media
   * extension it already has (.mp4, .m4v, .m4a, .mkv, .mka, .webm, .mov, .ts) is replaced, any
   * other name gets `.mp4`/`.mkv` appended. The result says which path was written.
   */
  container: ContainerChoice
  /** RFC 6381 codec strings from the manifest (HLS CODECS, DASH `@codecs`) for `'auto'`. */
  codecs?: readonly string[]
}

/** Where the file went and in which container. */
export interface MuxResult {
  output: string
  container: Container
}

export interface MuxOptions extends JobOptions, ContainerOptions {
  /** Absolute path of the video track. Its first video stream is used. */
  video: string
  /** Absolute path of the audio track; its first audio stream is used. Without it, the video
   * file's own first audio stream is kept if it has one. */
  audio?: string
}

const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.m4a', '.mkv', '.mka', '.webm', '.mov', '.ts'])

/** Checks the request and settles the container and the final output path. */
export function planOutput(
  options: JobOptions & ContainerOptions,
  inputs: readonly JobInput[]
): MuxResult {
  assertAbsolute('ffmpeg', options.ffmpeg)
  assertAbsolute('output', options.output)
  for (const input of inputs) assertAbsolute(input.role, input.path)
  if (
    options.duration !== undefined &&
    !(options.duration > 0 && Number.isFinite(options.duration))
  ) {
    throw new TypeError(`duration must be a positive number of seconds, got ${options.duration}`)
  }

  let container: Container
  let output = options.output
  if (options.container === 'auto') {
    container = containerForCodecs(options.codecs)
    const extension = extname(output)
    const stem = MEDIA_EXTENSIONS.has(extension.toLowerCase())
      ? output.slice(0, -extension.length)
      : output
    output = `${stem}.${container}`
  } else if (options.container === 'mp4' || options.container === 'mkv') {
    container = options.container
  } else {
    throw new TypeError(`container must be 'mp4', 'mkv' or 'auto', got ${options.container}`)
  }

  if (inputs.some((input) => resolve(input.path) === resolve(output))) {
    throw new TypeError(`output must not be one of the inputs: ${output}`)
  }
  return { output, container }
}

/**
 * Joins a separate video track and audio track into one file without re-encoding (FFmpeg stream
 * copy): the first video stream of `video` and the first audio stream of `audio`.
 *
 * FFmpeg runs as a separate program (never linked, never through a shell), may read only local
 * files of the media formats Mergelane downloads, and writes to a temporary file next to the
 * output that is renamed into place when complete. MP4 output gets its index moved to the front
 * (`-movflags +faststart`) so players can start before reading the whole file.
 *
 * @returns the path written (it differs from `output` only with `container: 'auto'`) and the
 * container used.
 * @throws {MuxError} `input-missing`, `tool-missing`, `ffmpeg-failed` or `output-failed`, with a
 * message fit to show the user and FFmpeg's last stderr lines in `detail`.
 * @throws the signal's reason when aborted; the error `onProgress` threw, if it did.
 * @throws {TypeError} for a relative path, an unknown container, a non-positive duration, or an
 * output that is one of the inputs.
 *
 * @example
 * ```ts
 * const ffmpeg = await resolveToolPath('ffmpeg', locations)
 * if (ffmpeg.path === null) throw new Error(ffmpeg.reason)
 * const { output } = await muxVideoAudio({
 *   ffmpeg: ffmpeg.path,
 *   video: '/tmp/job/video.mp4',
 *   audio: '/tmp/job/audio.m4a',
 *   output: '/Users/me/Downloads/Talk.mp4',
 *   container: 'auto',
 *   codecs: variant.codecs, // e.g. ['avc1.64001f', 'mp4a.40.2']
 *   duration: playlist.duration,
 *   signal,
 *   onProgress: ({ fraction }) => update(fraction)
 * })
 * ```
 */
export async function muxVideoAudio(options: MuxOptions): Promise<MuxResult> {
  const inputs: JobInput[] = [{ path: options.video, role: 'video track' }]
  if (options.audio !== undefined) inputs.push({ path: options.audio, role: 'audio track' })
  const plan = planOutput(options, inputs)

  // `0:v:0` is "the first video stream of input 0" (ffmpeg, Stream specifiers); a trailing `?`
  // makes a map optional: "if the map matches no streams the map will be ignored instead of
  // failing" (ffmpeg, -map).
  const maps =
    options.audio === undefined
      ? ['-map', '0:v:0', '-map', '0:a:0?']
      : ['-map', '0:v:0', '-map', '1:a:0']

  await runJob({
    ...options,
    ...plan,
    inputs,
    outputArgs: maps,
    action: 'combine the video and audio',
    subject: 'tracks'
  })
  return plan
}
