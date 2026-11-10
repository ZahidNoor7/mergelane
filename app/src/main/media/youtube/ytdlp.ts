import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { YoutubeError, ytDlpFailure } from './errors'

/**
 * Running the bundled yt-dlp to find a YouTube video's formats (ADR-0026). It only ever asks, with
 * `--dump-single-json`: Mergelane downloads the formats itself, over the networks the user picked.
 *
 * yt-dlp (GPL) is a separate program, started with an argument list and never through a shell.
 * Every flag below exists in yt-dlp 2026.10.26's `--help`; together they keep it to the one
 * video and away from anything of the user's:
 *
 * - `--ignore-config`: no yt-dlp.conf, the user's or the system's ("Don't load any more
 *   configuration files except those given to --config-locations"). With `YTDLP_NO_PLUGINS` set
 *   and `--no-plugin-dirs`, no plugins either (README, "Plugins").
 * - `--no-cookies`, `--no-cookies-from-browser`: never a cookie, from a file or a browser.
 * - `--no-cache-dir`: nothing kept between runs (yt-dlp would cache in ~/.cache/yt-dlp).
 * - `--no-update`: never replaces itself.
 * - `--no-js-runtimes --js-runtimes deno:<path>`: our Deno and no other JavaScript runtime, and
 *   `--no-remote-components`: the challenge solver scripts built into yt-dlp's official program
 *   (yt-dlp-ejs, hash-checked by yt-dlp), never ones fetched from npm or GitHub at run time.
 * - `--use-extractors youtube`: only YouTube's extractors; the generic one, which would fetch any
 *   page, never runs. `--no-playlist`: a watch link with `list=` stays one video.
 * - `--proxy`: the loopback proxy pinned to one network (see proxy.ts), or "" for none, so no
 *   proxy from the environment is used either.
 *
 * It runs with a minimal environment (no HOME of the user's: a private folder that is deleted
 * after, as are Deno's caches and the folder PyInstaller unpacks yt-dlp into), a time limit after
 * which it and everything it started are killed, and a cap on what it may print.
 */

/** Flags every run passes, before the per-run ones. */
export const SAFETY_ARGS: readonly string[] = [
  '--ignore-config',
  '--no-plugin-dirs',
  '--no-cookies',
  '--no-cookies-from-browser',
  '--no-cache-dir',
  '--no-update',
  '--no-remote-components',
  '--no-js-runtimes',
  '--use-extractors',
  'youtube',
  '--no-playlist',
  '--no-mark-watched',
  '--no-progress',
  '--color',
  'never'
]

/** How long one run may take: yt-dlp asks YouTube several times and runs Deno once. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** What yt-dlp may print. A video's JSON is a few megabytes at most (its formats, captions and
 * thumbnails); anything bigger isn't what was asked for. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** Of stderr, the end is kept for error messages and the log. */
const MAX_STDERR_BYTES = 64 * 1024
/** After the time limit, SIGTERM; this long after, SIGKILL. */
const KILL_GRACE_MS = 2000
/** yt-dlp's own network timeout (`--socket-timeout`), in seconds. */
const SOCKET_TIMEOUT_S = 20

export interface YtDlpOptions {
  /** Absolute paths of the bundled programs (see resolveToolPath). */
  ytDlp: string
  deno: string
  /** The video's watch page: youtubeWatchUrl(), nothing the user typed as it is. */
  url: string
  /** `http://user:password@127.0.0.1:port` of a loopback proxy pinned to one network; left out,
   * yt-dlp connects directly. */
  proxy?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

/** yt-dlp's arguments for one video, in order: the safety flags, then this run's, then `--` and
 * the URL, so the URL can never be taken for an option. */
export function ytDlpArgs(options: Pick<YtDlpOptions, 'deno' | 'url' | 'proxy'>): string[] {
  return [
    ...SAFETY_ARGS,
    '--js-runtimes',
    `deno:${options.deno}`,
    '--proxy',
    options.proxy ?? '',
    '--socket-timeout',
    String(SOCKET_TIMEOUT_S),
    '--dump-single-json',
    '--',
    options.url
  ]
}

/** The whole environment yt-dlp gets: nothing of Mergelane's or the user's is passed on. */
export function ytDlpEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: join(workDir, 'home'),
    // PyInstaller's one-file program unpacks itself here; a run that is killed leaves it behind,
    // in a folder this removes.
    TMPDIR: join(workDir, 'tmp'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NO_COLOR: '1',
    YTDLP_NO_PLUGINS: '1',
    // yt-dlp passes its environment on to Deno (jsc/_builtin/deno.py), and Deno writes caches it
    // can't be told not to into DENO_DIR (`deno --help`, "Environment variables").
    DENO_DIR: join(workDir, 'deno'),
    DENO_NO_UPDATE_CHECK: '1',
    DENO_NO_PROMPT: '1'
  }
}

/** Kills the process group: yt-dlp's one-file program runs Python in a child of its own, and
 * Python runs Deno. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // Gone already.
  }
}

/**
 * Runs yt-dlp for one video and resolves with what it printed: the video's JSON. Fails with a
 * YoutubeError whose message can be shown as it is: yt-dlp's errors mapped to plain words (see
 * ytDlpFailure), or the time limit, the output cap, or a program that wouldn't start.
 */
export async function runYtDlp(options: YtDlpOptions): Promise<string> {
  for (const [name, path] of [
    ['yt-dlp', options.ytDlp],
    ['deno', options.deno]
  ] as const) {
    if (!isAbsolute(path)) throw new TypeError(`${name} must be an absolute path, got ${path}`)
  }
  options.signal?.throwIfAborted()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const workDir = await mkdtemp(join(tmpdir(), 'mergelane-ytdlp-'))
  try {
    await Promise.all(
      ['home', 'tmp', 'deno'].map((name) => mkdir(join(workDir, name), { mode: 0o700 }))
    )
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(options.ytDlp, ytDlpArgs(options), {
        cwd: workDir,
        env: ytDlpEnv(workDir),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a kill reaches everything it started.
        detached: true
      })
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderr = ''
      let failure: Error | null = null
      let escalation: NodeJS.Timeout | undefined

      const stop = (error: Error): void => {
        failure ??= error
        killGroup(child.pid, 'SIGTERM')
        escalation ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
      }
      const timer = setTimeout(() => stop(new YoutubeError('timeout')), timeoutMs)
      const onAbort = (): void => stop(options.signal!.reason as Error)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > maxOutputBytes) {
          stop(
            new YoutubeError(
              'bad-answer',
              'yt-dlp’s answer about this video was larger than Mergelane will read.'
            )
          )
          return
        }
        stdout.push(chunk)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES)
      })
      let settled = false
      const settle = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(escalation)
        options.signal?.removeEventListener('abort', onAbort)
        outcome()
      }
      child.on('error', (error) => {
        // It didn't start (no 'close' may follow), or a kill failed.
        const code = (error as NodeJS.ErrnoException).code ?? error.message
        settle(() =>
          reject(new YoutubeError('failed', `Mergelane couldn’t start yt-dlp (${code}).`))
        )
      })
      child.on('close', (code) => {
        settle(() => {
          if (failure) {
            // Killed: whatever it started may still be running.
            killGroup(child.pid, 'SIGKILL')
            reject(failure)
          } else if (code !== 0) {
            reject(ytDlpFailure(stderr))
          } else {
            resolve(Buffer.concat(stdout).toString('utf8'))
          }
        })
      })
    })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
