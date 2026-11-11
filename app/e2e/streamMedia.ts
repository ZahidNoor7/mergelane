// Real HLS and DASH streams for the stream download tests: tiny media made with FFmpeg's own lavfi
// sources (testsrc, sine), cut into segments by FFmpeg's HLS and DASH muxers, and a static server
// that logs which segments it was asked for, from which source address, and can hold them. Also
// which FFmpeg each test uses: see APP_FFMPEG and FIXTURE_FFMPEG.

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Two FFmpegs (ADR-0028):
// - the app's, the one under test: Mergelane's own minimal LGPL build, which only joins and
//   rewraps. It can't encode, has no lavfi sources and no `null` output format, so it can neither
//   make test media nor read media back the way inspect() does;
// - a full FFmpeg for exactly that (test-only, never shipped): Homebrew's, or another one named by
//   MERGELANE_E2E_FIXTURE_FFMPEG.
// The app's never falls back to Homebrew's, so the tests that join media really join it with ours.

/** The app's FFmpeg: MERGELANE_FFMPEG_PATH, else app/resources/bin/ffmpeg (`npm run
 * fetch:media-tools` builds it there). Null when that isn't an executable file. */
export const APP_FFMPEG_CANDIDATE =
  process.env.MERGELANE_FFMPEG_PATH || join(__dirname, '..', 'resources', 'bin', 'ffmpeg')
export const APP_FFMPEG: string | null = isExecutableFile(APP_FFMPEG_CANDIDATE)
  ? APP_FFMPEG_CANDIDATE
  : null

/** A full FFmpeg to make test media and read it back: MERGELANE_E2E_FIXTURE_FFMPEG when set, else
 * Homebrew's. Null when there is none. */
export const FIXTURE_FFMPEG: string | null =
  (process.env.MERGELANE_E2E_FIXTURE_FFMPEG
    ? [process.env.MERGELANE_E2E_FIXTURE_FFMPEG]
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  ).find(isExecutableFile) ?? null

const NO_APP_FFMPEG = `needs Mergelane's FFmpeg, not found at ${APP_FFMPEG_CANDIDATE}: run "npm run fetch:media-tools" in app/, or set MERGELANE_FFMPEG_PATH`
const NO_FIXTURE_FFMPEG =
  'needs a full FFmpeg to make test media (test-only): brew install ffmpeg, or set MERGELANE_E2E_FIXTURE_FFMPEG'

/** Why a test that needs these FFmpegs can't run, naming each one missing; '' when it can. Use as
 * `test.skip(!!reason, reason)`. */
export function missingFfmpeg(needs: { app?: boolean; fixture?: boolean }): string {
  return [
    needs.app && APP_FFMPEG === null ? NO_APP_FFMPEG : '',
    needs.fixture && FIXTURE_FFMPEG === null ? NO_FIXTURE_FFMPEG : ''
  ]
    .filter(Boolean)
    .join('; ')
}

/** For tests that make media and have the app's FFmpeg join it. */
export const NEEDS_FFMPEG = missingFfmpeg({ app: true, fixture: true })
/** For tests that only make media (or read it back). */
export const NEEDS_FIXTURE_FFMPEG = missingFfmpeg({ fixture: true })

/** The full FFmpeg, or an error saying how to get one. */
export function fixtureFfmpeg(): string {
  if (FIXTURE_FFMPEG === null) throw new Error(NO_FIXTURE_FFMPEG)
  return FIXTURE_FFMPEG
}

/** The app's FFmpeg, or an error saying how to get it. */
export function appFfmpeg(): string {
  if (APP_FFMPEG === null) throw new Error(NO_APP_FFMPEG)
  return APP_FFMPEG
}

async function ff(args: string[], cwd: string): Promise<void> {
  await run(fixtureFfmpeg(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd
  })
}

/** Seconds of media, in one-second segments: 8 per track. */
export const SECONDS = 8
const VIDEO = (size: string): string[] => [
  '-f',
  'lavfi',
  '-i',
  `testsrc=size=${size}:rate=15:duration=${SECONDS}`
]
const AUDIO = ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`]
/** A key frame every second, so every one-second segment starts with one. */
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15']
const HLS = (folder: string): string[] => [
  '-f',
  'hls',
  '-hls_time',
  '1',
  '-hls_playlist_type',
  'vod',
  '-hls_segment_filename',
  `${folder}/seg%03d.ts`,
  `${folder}/index.m3u8`
]

/** What the server serves, by path. */
export const PATHS = {
  /** Two qualities (v0: 320x240, v1: 160x120) and an audio group. */
  master: '/hls/master.m3u8',
  /** One media playlist whose segments hold video and audio together. */
  muxed: '/hls/muxed/index.m3u8',
  live: '/hls/live.m3u8',
  encrypted: '/hls/encrypted.m3u8',
  /** Two video representations (0: 320x240, 1: 160x120) and audio (2), SegmentTemplate. */
  mpd: '/dash/manifest.mpd',
  liveMpd: '/dash/live.mpd',
  protectedMpd: '/dash/protected.mpd'
} as const

async function generate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mergelane-streams-'))
  for (const folder of ['hls/v240', 'hls/v120', 'hls/audio', 'hls/muxed', 'dash']) {
    await mkdir(join(root, folder), { recursive: true })
  }
  await Promise.all([
    ff([...VIDEO('320x240'), ...H264, '-sc_threshold', '0', '-an', ...HLS('hls/v240')], root),
    ff([...VIDEO('160x120'), ...H264, '-sc_threshold', '0', '-an', ...HLS('hls/v120')], root),
    ff([...AUDIO, '-c:a', 'aac', '-b:a', '64k', ...HLS('hls/audio')], root),
    ff(
      [
        ...VIDEO('160x120'),
        ...AUDIO,
        ...H264,
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        ...HLS('hls/muxed')
      ],
      root
    ),
    ff(
      [
        ...VIDEO('320x240'),
        ...AUDIO,
        ...['-map', '0:v', '-map', '0:v', '-map', '1:a'],
        ...H264,
        ...['-sc_threshold', '0', '-s:v:0', '320x240', '-s:v:1', '160x120'],
        ...['-b:v:0', '300k', '-b:v:1', '100k', '-c:a', 'aac', '-b:a', '64k'],
        ...['-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1'],
        ...['-adaptation_sets', 'id=0,streams=v id=1,streams=a'],
        ...['-init_seg_name', 'init-$RepresentationID$.m4s'],
        ...['-media_seg_name', 'chunk-$RepresentationID$-$Number%05d$.m4s'],
        'dash/manifest.mpd'
      ],
      root
    )
  ])
  await writeFile(
    join(root, 'hls/master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,CODECS="avc1.64000d,mp4a.40.2",AUDIO="aud"',
      'v240/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x120,CODECS="avc1.64000b,mp4a.40.2",AUDIO="aud"',
      'v120/index.m3u8',
      ''
    ].join('\n')
  )
  const media = await readFile(join(root, 'hls/v240/index.m3u8'), 'utf-8')
  await writeFile(
    join(root, 'hls/live.m3u8'),
    media.replace('#EXT-X-ENDLIST', '').replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '')
  )
  await writeFile(
    join(root, 'hls/encrypted.m3u8'),
    media.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF')
  )
  const mpd = await readFile(join(root, 'dash/manifest.mpd'), 'utf-8')
  await writeFile(join(root, 'dash/live.mpd'), mpd.replace('type="static"', 'type="dynamic"'))
  await writeFile(
    join(root, 'dash/protected.mpd'),
    mpd.replaceAll(
      /(<AdaptationSet[^>]*>)/g,
      '$1\n<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>'
    )
  )
  return root
}

let mediaPromise: Promise<string> | undefined
/** The folder the media is in, made once per test worker. */
export function streamMedia(): Promise<string> {
  return (mediaPromise ??= generate())
}

/** Removes the worker's media. */
export async function removeStreamMedia(): Promise<void> {
  if (!mediaPromise) return
  const root = await mediaPromise.catch(() => null)
  mediaPromise = undefined
  if (root) await rm(root, { recursive: true, force: true })
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment'
}

export interface ServedRequest {
  path: string
  /** Source address: which "network" it came over. */
  from: string
  at: number
  /** When its response ended or broke off. */
  endedAt?: number
  status: number
  /** Held (see StreamServer.hold) before it was answered. */
  held: boolean
}

/** Serves the media folder over HTTP (with byte ranges), logging every request. */
export class StreamServer {
  readonly log: ServedRequest[] = []
  /** Responses to hold back until release(): the request arrives, its answer doesn't. */
  hold: ((path: string) => boolean) | null = null
  /** Wait before each segment's answer, to keep a download going long enough to act on. */
  delayMs = 0
  /** Answers by path, instead of the media folder's. */
  readonly overrides = new Map<
    string,
    {
      status?: number
      type?: string
      headers?: Record<string, string>
      body?: string
      /** Sends the headers and this much of the body, then goes silent. */
      stallAfter?: string
    }
  >()
  private server: Server | null = null
  private releaseHeld: () => void = () => {}
  private released = Promise.resolve()

  constructor(private readonly root: string) {}

  async start(): Promise<this> {
    this.released = new Promise((resolve) => (this.releaseHeld = resolve))
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const entry: ServedRequest = {
        path,
        from: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
        at: Date.now(),
        status: 0,
        held: false
      }
      this.log.push(entry)
      res.on('close', () => (entry.endedAt = Date.now()))
      void this.answer(path, req.headers.range, entry, res).catch(() => res.destroy())
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    return this
  }

  url(path: string): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}${path}`
  }

  /** Lets every held answer go, and stops holding. */
  release(): void {
    this.hold = null
    this.releaseHeld()
  }

  /** Segment requests (not playlists or manifests). */
  segments(): ServedRequest[] {
    return this.log.filter((entry) => /\.(ts|m4s)$/.test(entry.path))
  }

  async stop(): Promise<void> {
    this.release()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
  }

  private async answer(
    path: string,
    range: string | undefined,
    entry: ServedRequest,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const override = this.overrides.get(path)
    if (override) {
      entry.status = override.status ?? 200
      res.writeHead(entry.status, {
        'content-type': override.type ?? 'text/plain',
        ...override.headers
      })
      if (override.stallAfter !== undefined) res.write(override.stallAfter)
      else res.end(override.body ?? '')
      return
    }
    const file = normalize(join(this.root, path))
    let data: Buffer
    try {
      if (!file.startsWith(this.root + sep)) throw new Error('outside')
      data = await readFile(file)
    } catch {
      entry.status = 404
      res.writeHead(404).end()
      return
    }
    const segment = /\.(ts|m4s)$/.test(path)
    if (segment && this.hold?.(path)) {
      entry.held = true
      await this.released
    }
    if (segment && this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (res.destroyed) return
    const type = TYPES[extname(path)] ?? 'application/octet-stream'
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match) {
      const start = Number(match[1])
      const end = Math.min(match[2] === '' ? data.length - 1 : Number(match[2]), data.length - 1)
      entry.status = 206
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${data.length}`,
        'accept-ranges': 'bytes'
      })
      res.end(data.subarray(start, end + 1))
      return
    }
    entry.status = 200
    res.writeHead(200, { 'content-type': type, 'content-length': data.length })
    res.end(data)
  }
}

export interface Inspection {
  /** The demuxer FFmpeg picked, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm". */
  format: string
  video: string[]
  audio: string[]
  /** Its length, in seconds, as the container says. */
  duration: number
  /** "320x240", from the video stream. */
  size: string | null
}

/** Reads a file back with the full FFmpeg: every stream must copy through cleanly, and the input
 * dump says what streams there are. Needs the `null` output format, which the app's FFmpeg doesn't
 * have. */
export async function inspect(file: string): Promise<Inspection> {
  const { stderr } = await run(fixtureFfmpeg(), [
    '-nostdin',
    '-hide_banner',
    '-i',
    `file:${file}`,
    '-map',
    '0',
    '-c',
    'copy',
    '-f',
    'null',
    '-'
  ])
  const input = stderr.slice(0, stderr.indexOf('Output #0'))
  const streams = [...input.matchAll(/Stream #0:\d+\S*: (Video|Audio): (\w+)/g)]
  const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(input)
  return {
    format: /Input #0, (\S+), from/.exec(input)?.[1] ?? '',
    video: streams.filter((match) => match[1] === 'Video').map((match) => match[2]),
    audio: streams.filter((match) => match[1] === 'Audio').map((match) => match[2]),
    duration: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : 0,
    size: /Video: .*?, (\d+x\d+)/.exec(input)?.[1] ?? null
  }
}
