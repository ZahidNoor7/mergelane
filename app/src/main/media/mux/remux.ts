import { planOutput, type ContainerOptions, type MuxResult } from './mux'
import { runJob, type JobInput, type JobOptions } from './run'

export interface RemuxOptions extends JobOptions, ContainerOptions {
  /** Absolute path of the file to rewrap: an HLS transport stream (.ts), a DASH or HLS fMP4
   * track, a WebM file, or packed audio (.aac, .mp3, .ac3, .ec3). */
  input: string
}

/**
 * Rewraps one downloaded file into MP4 or MKV without re-encoding: its first video stream and
 * its first audio stream, whichever it has. For example an HLS transport stream becomes a normal
 * .mp4; ADTS AAC from a transport stream is converted for MP4 by FFmpeg itself ("auto-inserted
 * for MP4A-LATM and MOV/MP4", ffmpeg-bitstream-filters, aac_adtstoasc).
 *
 * Same safety as {@link muxVideoAudio}: no shell, local files of known media formats only, a
 * temporary file renamed into place, abort that stops FFmpeg and cleans up.
 *
 * @returns the path written (it differs from `output` only with `container: 'auto'`) and the
 * container used.
 * @throws {MuxError} `input-missing`, `tool-missing`, `ffmpeg-failed` or `output-failed`.
 * @throws the signal's reason when aborted; the error `onProgress` threw, if it did.
 * @throws {TypeError} for a relative path, an unknown container, a non-positive duration, or an
 * output that is the input.
 */
export async function remux(options: RemuxOptions): Promise<MuxResult> {
  const inputs: JobInput[] = [{ path: options.input, role: 'downloaded file' }]
  const plan = planOutput(options, inputs)
  await runJob({
    ...options,
    ...plan,
    inputs,
    // Both optional, so a video-only or audio-only file works.
    outputArgs: ['-map', '0:v:0?', '-map', '0:a:0?'],
    action: 'convert the downloaded stream',
    subject: 'file'
  })
  return plan
}
