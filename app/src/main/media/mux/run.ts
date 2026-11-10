// Logic adapted from Awesome Downloader core/mux.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane: the same spawn-with-argv and stream-copy approach, plus
// a demuxer whitelist, progress, abort with escalation, a temporary file renamed into place, and
// typed errors. See docs/UPSTREAM.md.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Container } from './codecs'
import { MuxError } from './errors'

/** Progress of one FFmpeg run, from its `-progress` output. */
export interface MuxProgress {
  /** How much of the media has been written, in seconds (FFmpeg's `out_time_us`). */
  outTimeSeconds: number
  /** 0–1 against the `duration` given to the job; null when none was given. 1 once done. */
  fraction: number | null
  /** True on FFmpeg's final report (`progress=end`). */
  done: boolean
}

/** What every job takes besides its inputs. */
export interface JobOptions {
  /** Absolute path of the FFmpeg executable (see resolveToolPath). */
  ffmpeg: string
  /** Absolute path of the file to write. An existing file there is replaced. */
  output: string
  /** Length of the media in seconds, when known (from the playlist or manifest), so progress can
   * be reported as a fraction. */
  duration?: number
  /** Aborting stops FFmpeg (SIGTERM, then SIGKILL after {@link KILL_GRACE_MS}), deletes the
   * temporary file and rejects with the signal's reason. */
  signal?: AbortSignal
  /** Called with each progress report, about twice a second (FFmpeg's default `-stats_period`
   * of 0.5 s) and once at the end. If it throws, the job stops and rejects with that error. */
  onProgress?: (progress: MuxProgress) => void
}

/** One input file and what to call it in messages ("video track", "audio track", …). */
export interface JobInput {
  path: string
  role: string
}

export interface Job extends JobOptions {
  inputs: JobInput[]
  /** Output options between the inputs and the output: maps and codec choice. */
  outputArgs: string[]
  container: Container
  /** "combine the video and audio", for "Mergelane couldn't …". */
  action: string
  /** "tracks", for "The downloaded … may be damaged". */
  subject: string
}

/** How long FFmpeg gets to exit after SIGTERM before it is killed with SIGKILL. */
export const KILL_GRACE_MS = 3000

/**
 * Demuxers FFmpeg may use on our inputs (`-format_whitelist`, ffmpeg-formats "Format Options":
 * `"," separated list of allowed demuxers`): MP4/fMP4 (mov), MPEG-TS, Matroska/WebM, and the
 * packed audio HLS allows (ADTS AAC, MP3, AC-3, E-AC-3). Everything else is refused, notably the
 * hls and concat demuxers, which read other files a playlist names: with only
 * `-protocol_whitelist file`, a downloaded `.m3u8` that lists `file:` URLs would make FFmpeg copy
 * those local files into the output.
 */
export const INPUT_DEMUXERS = 'mov,mp4,m4a,3gp,3g2,mj2,mpegts,matroska,webm,aac,mp3,ac3,eac3'

/** Stderr lines kept for {@link MuxError.detail}. */
const DETAIL_LINES = 12
/** Bytes of stderr kept while FFmpeg runs (only the end matters). */
const STDERR_KEEP = 16 * 1024
/** A progress line longer than this is not FFmpeg's `key=value`; it is dropped. */
const MAX_PROGRESS_LINE = 4096

/** `-f` names, and their extra output options. `+faststart` (ffmpeg-formats, mov/mp4 muxer
 * movflags: "Run a second pass moving the index (moov atom) to the beginning of the file") lets
 * players start before the whole file is read. */
const MUXER_ARGS: Readonly<Record<Container, readonly string[]>> = {
  mp4: ['-f', 'mp4', '-movflags', '+faststart'],
  mkv: ['-f', 'matroska']
}

/** Display names for messages. */
export const CONTAINER_LABEL: Readonly<Record<Container, string>> = { mp4: 'MP4', mkv: 'MKV' }

/** Suffix of the temporary file FFmpeg writes next to the output before it is renamed into place.
 * Exported so a cleanup pass can recognise leftovers from a crash. */
export const TEMP_SUFFIX = '.mergelane-mux'

/** Only PATH, so nothing in the app's environment reaches FFmpeg: notably FFREPORT, which makes it
 * write a log file into the working directory (ffmpeg "-report": "Setting the environment variable
 * FFREPORT to any value has the same effect"). */
const CHILD_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/** Throws a TypeError unless `path` is absolute: FFmpeg would read a relative one against the
 * main process's working directory, which is `/` for an app started from the Finder. */
export function assertAbsolute(name: string, path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new TypeError(`${name} must be an absolute path, got ${JSON.stringify(path)}`)
  }
}

/**
 * The argv for one job, without the program name. Never passed through a shell: `spawn` gets the
 * array as is, so spaces, quotes, `$` or `;` in paths are just characters.
 *
 * Every path goes in as a `file:` URL (ffmpeg-protocols, "file": "A file URL can have the form:
 * file:filename"), so a name containing ":" can't be taken for another protocol, and a name
 * starting with "-" can't be taken for an option.
 */
export function buildArgs(job: Job, tempPath: string): string[] {
  const args = [
    // Global options first (ffmpeg synopsis: "ffmpeg [global_options] {[input_file_options] -i
    // input_url} ... {[output_file_options] output_url} ...").
    '-nostdin', // never read the terminal
    '-hide_banner',
    '-loglevel',
    'error', // "Show all errors, including ones which can be recovered from."
    '-nostats', // no human-readable stats on stderr; progress comes from -progress
    '-progress',
    'pipe:1', // "key=value" lines on stdout
    '-y' // the temporary file is ours to overwrite
  ]
  for (const input of job.inputs) {
    // Per-input options "apply ONLY to the next input or output file and are reset between
    // files" (ffmpeg, Description), so they are repeated for every input.
    args.push('-protocol_whitelist', 'file', '-format_whitelist', INPUT_DEMUXERS)
    args.push('-i', `file:${input.path}`)
  }
  args.push(...job.outputArgs, '-c', 'copy', ...MUXER_ARGS[job.container], `file:${tempPath}`)
  return args
}

/** Turns FFmpeg's `-progress` stream ("key=value" lines; "The last key of a sequence of progress
 * information is always "progress" with the value "continue" or "end"") into reports. */
export class ProgressParser {
  private pending = ''
  private outTimeUs = 0

  constructor(private readonly duration: number | undefined) {}

  /** Feeds a chunk of stdout; returns the reports it completed. */
  push(chunk: string): MuxProgress[] {
    const reports: MuxProgress[] = []
    const lines = (this.pending + chunk).split('\n')
    this.pending = lines.pop() ?? ''
    if (this.pending.length > MAX_PROGRESS_LINE) this.pending = ''
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key === 'out_time_us') {
        // "N/A" before the first packet; negative while timestamps settle.
        const us = Number(value)
        if (Number.isFinite(us)) this.outTimeUs = Math.max(0, us)
      } else if (key === 'progress') {
        reports.push(this.report(value === 'end'))
      }
    }
    return reports
  }

  private report(done: boolean): MuxProgress {
    const outTimeSeconds = this.outTimeUs / 1e6
    let fraction: number | null = null
    if (this.duration !== undefined) {
      fraction = done ? 1 : Math.min(1, outTimeSeconds / this.duration)
    }
    return { outTimeSeconds, fraction, done }
  }
}

/** The last few non-empty lines of FFmpeg's stderr, after a line saying how it ended. */
function detailOf(ending: string, stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  return [ending, ...lines.slice(-DETAIL_LINES)].join('\n')
}

/** How the child process ended. */
type Ending =
  | { kind: 'spawn-error'; error: Error }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }

async function checkInputs(job: Job): Promise<void> {
  for (const input of job.inputs) {
    let isFile = false
    try {
      isFile = (await stat(input.path)).isFile()
    } catch {
      // Treated as missing below.
    }
    if (!isFile) {
      throw new MuxError(
        'input-missing',
        `Mergelane couldn't ${job.action}: the ${input.role} is missing (${input.path}). Download it again.`
      )
    }
  }
}

async function checkOutputFolder(job: Job): Promise<void> {
  const folder = dirname(job.output)
  try {
    await access(folder, constants.W_OK)
  } catch (error) {
    throw new MuxError(
      'output-failed',
      `Mergelane couldn't save ${basename(job.output)}: the folder ${folder} doesn't exist or can't be written to.`,
      (error as Error).message,
      { cause: error }
    )
  }
}

/**
 * Runs one FFmpeg stream-copy job: checks the inputs, writes to a temporary file next to the
 * output, then renames it into place, so the output path only ever holds a finished file.
 * Rejects with a {@link MuxError}, with the signal's reason when aborted, or with the error
 * `onProgress` threw. The temporary file never outlives the call.
 */
export async function runJob(job: Job): Promise<void> {
  const { signal } = job
  signal?.throwIfAborted()
  await checkInputs(job)
  await checkOutputFolder(job)
  signal?.throwIfAborted()

  const tempPath = join(
    dirname(job.output),
    `${basename(job.output)}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`
  )
  const removeTemp = (): Promise<void> => rm(tempPath, { force: true })

  const child = spawn(job.ffmpeg, buildArgs(job, tempPath), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: CHILD_ENV,
    shell: false
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP)
  })

  let killTimer: NodeJS.Timeout | undefined
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
  }

  let callbackError: { error: unknown } | undefined
  const parser = new ProgressParser(job.duration)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (callbackError || !job.onProgress) return
    for (const report of parser.push(chunk)) {
      try {
        job.onProgress(report)
      } catch (error) {
        callbackError = { error }
        stop()
        return
      }
    }
  })

  signal?.addEventListener('abort', stop, { once: true })
  const ending = await new Promise<Ending>((resolve) => {
    child.once('error', (error) => resolve({ kind: 'spawn-error', error }))
    child.once('close', (code, exitSignal) => resolve({ kind: 'exit', code, signal: exitSignal }))
  })
  signal?.removeEventListener('abort', stop)
  clearTimeout(killTimer)

  if (signal?.aborted) {
    await removeTemp()
    throw signal.reason
  }
  if (callbackError) {
    await removeTemp()
    throw callbackError.error
  }
  if (ending.kind === 'spawn-error') {
    // Kill the process if it did start; harmless if it didn't.
    child.kill('SIGKILL')
    await removeTemp()
    throw new MuxError(
      'tool-missing',
      `Mergelane couldn't ${job.action} because FFmpeg could not be started. Reinstall Mergelane.`,
      ending.error.message,
      { cause: ending.error }
    )
  }
  if (ending.code !== 0) {
    await removeTemp()
    if (ending.signal) {
      throw new MuxError(
        'ffmpeg-failed',
        `Mergelane couldn't ${job.action}: FFmpeg stopped unexpectedly.`,
        detailOf(`FFmpeg was killed by ${ending.signal}.`, stderr)
      )
    }
    throw new MuxError(
      'ffmpeg-failed',
      `Mergelane couldn't ${job.action}: FFmpeg reported an error. The downloaded ${job.subject} may be damaged, or use a format that ${CONTAINER_LABEL[job.container]} can't hold.`,
      detailOf(`FFmpeg exited with code ${ending.code}.`, stderr)
    )
  }

  let written = 0
  try {
    written = (await stat(tempPath)).size
  } catch {
    // Treated as empty below.
  }
  if (written === 0) {
    await removeTemp()
    throw new MuxError(
      'ffmpeg-failed',
      `Mergelane couldn't ${job.action}: FFmpeg finished without writing a file.`,
      detailOf('FFmpeg exited with code 0 but the output is missing or empty.', stderr)
    )
  }
  try {
    await rename(tempPath, job.output)
  } catch (error) {
    await removeTemp()
    throw new MuxError(
      'output-failed',
      `Mergelane couldn't save ${basename(job.output)} in ${dirname(job.output)}.`,
      (error as Error).message,
      { cause: error }
    )
  }
}
