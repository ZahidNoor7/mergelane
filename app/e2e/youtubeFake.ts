// A stand-in for YouTube in the YouTube tests: no real YouTube response, signed address, cookie or
// token is ever used or committed. It has two parts.
//
// - A fake yt-dlp (a small Node script) that prints yt-dlp-shaped JSON for the video ids in its
//   config.json, whose format addresses point at the local server below. Like YouTube's, they are
//   "signed" for the address that asked: before answering, the fake asks the server who it is,
//   through the --proxy it was given (an HTTP CONNECT tunnel) or directly, and writes that address
//   into each URL's `ip`. It records every run (its arguments, environment and folder) in
//   calls.jsonl, and can fail as yt-dlp does, hang, or print too much.
// - YoutubeServer, which serves real media (made with the full, test-only FFmpeg) as YouTube
//   serves formats: byte ranges of one file each, refused (403) when the request comes from another
//   address than the one in its `ip`, or after its `expire`. It logs every request, and can hold or
//   refuse some.

import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fixtureFfmpeg } from './streamMedia'

const run = promisify(execFile)

/** What the fake yt-dlp does for one video id. */
export interface FakeVideo {
  /** yt-dlp's JSON. In its strings, `{base}` is the server's address, `{from}` the address that
   * asked, `{gen}` the how-many-th run for this id it is, and `{expire}` when its URLs expire. */
  info?: unknown
  /** Fails with this on stderr, exit code 1. */
  stderr?: string
  /** Fails with this when the address that asked is the key. */
  failFrom?: Record<string, string>
  /** Seconds until the URLs of the n-th run expire (by run, from the first); default 6 hours. */
  expireIn?: number[]
  /** Prints this instead. */
  raw?: string
  /** Prints this many bytes. */
  bytes?: number
  /** Never finishes; starts a child that sleeps, whose pid goes to `<id>.child`. */
  hang?: boolean
  /** Waits this long before answering. */
  delayMs?: number
}

export interface FakeCall {
  id: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  at: number
}

const SCRIPT = String.raw`'use strict'
const fs = require('fs')
const path = require('path')
const net = require('net')
const http = require('http')
const { spawn } = require('child_process')
const here = path.dirname(process.argv[1])
const config = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'))
const args = process.argv.slice(2)
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const end = args.indexOf('--')
const url = end < 0 ? '' : args[end + 1]
let id = ''
try { id = new URL(url).searchParams.get('v') || '' } catch {}
const log = path.join(here, 'calls.jsonl')
fs.appendFileSync(log, JSON.stringify({ id, argv: args, env: process.env, cwd: process.cwd(), at: Date.now() }) + '\n')
const run = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.id === id).length
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1) }
const video = config.videos[id]
const runtime = value('--js-runtimes') || ''
if (!runtime.startsWith('deno:') || !fs.existsSync(runtime.slice(5))) fail('ERROR: [youtube] ' + id + ': no JavaScript runtime')
if (!video) fail('ERROR: [youtube] ' + id + ': Video unavailable. This video is no longer available')

function whoami() {
  const target = new URL(config.whoami)
  const proxy = value('--proxy')
  if (!proxy) {
    return new Promise((resolve, reject) => {
      http.get(config.whoami, (res) => { let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve(body)) }).on('error', reject)
    })
  }
  const via = new URL(proxy)
  const auth = Buffer.from(decodeURIComponent(via.username) + ':' + decodeURIComponent(via.password)).toString('base64')
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(via.port), via.hostname)
    let data = ''
    let tunnelled = false
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      data += chunk
      if (!tunnelled) {
        const head = data.indexOf('\r\n\r\n')
        if (head < 0) return
        const status = data.split(' ')[1]
        if (status !== '200') return reject(new Error('Tunnel connection failed: ' + status))
        tunnelled = true
        data = ''
        socket.write('GET /whoami HTTP/1.1\r\nHost: ' + target.host + '\r\nConnection: close\r\n\r\n')
      }
    })
    socket.on('end', () => resolve(data.slice(data.indexOf('\r\n\r\n') + 4)))
    socket.write('CONNECT ' + target.host + ' HTTP/1.1\r\nHost: ' + target.host + '\r\nProxy-Authorization: Basic ' + auth + '\r\n\r\n')
  })
}

async function main() {
  if (video.delayMs) await new Promise((resolve) => setTimeout(resolve, video.delayMs))
  if (video.hang) {
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(here, id + '.child'), String(child.pid))
    setInterval(() => {}, 1000)
    return
  }
  if (video.stderr) fail(video.stderr)
  if (video.raw !== undefined) { process.stdout.write(video.raw); return }
  if (video.bytes) { process.stdout.write('x'.repeat(video.bytes)); return }
  let from
  try {
    from = (await whoami()).trim()
  } catch (error) {
    fail('ERROR: [youtube] ' + id + ': Unable to download webpage: ' + error.message)
  }
  if (video.failFrom && video.failFrom[from]) fail(video.failFrom[from])
  const seconds = (video.expireIn && video.expireIn[run - 1]) ?? 21600
  const fill = (text) => text
    .split('{base}').join(config.base)
    .split('{from}').join(encodeURIComponent(from))
    .split('{gen}').join(String(run))
    .split('{expire}').join(String(Math.floor(Date.now() / 1000) + seconds))
  process.stdout.write(fill(JSON.stringify(video.info)))
}
main()
`

/** A fake yt-dlp and Deno in `dir`, run by this Node. */
export class FakeYtDlp {
  readonly ytDlp: string
  readonly deno: string
  private videos: Record<string, FakeVideo> = {}
  private server = { base: 'http://127.0.0.1:9', whoami: 'http://127.0.0.1:9/whoami' }

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.ytDlp = join(dir, 'yt-dlp')
    this.deno = join(dir, 'deno')
    writeFileSync(this.ytDlp, `#!${process.execPath}\n${SCRIPT}`)
    writeFileSync(this.deno, '#!/bin/sh\necho "deno 0.0.0 (fake)"\n')
    chmodSync(this.ytDlp, 0o755)
    chmodSync(this.deno, 0o755)
    writeFileSync(join(dir, 'calls.jsonl'), '')
    this.save()
  }

  /** Answers for `id` as `video` says. */
  set(id: string, video: FakeVideo): this {
    this.videos[id] = video
    this.save()
    return this
  }

  /** Points its format addresses and its "who am I" at `server`. */
  serve(server: YoutubeServer): this {
    this.server = { base: server.base, whoami: `${server.base}/whoami` }
    this.save()
    return this
  }

  /** Every run so far, oldest first; of video `id` only, when given. */
  calls(id?: string): FakeCall[] {
    const lines = readFileSync(join(this.dir, 'calls.jsonl'), 'utf8').trim()
    const all = lines ? lines.split('\n').map((line) => JSON.parse(line) as FakeCall) : []
    return id === undefined ? all : all.filter((call) => call.id === id)
  }

  /** The pid of the sleeping child a hanging run started for `id`. */
  childOf(id: string): number {
    return Number(readFileSync(join(this.dir, `${id}.child`), 'utf8'))
  }

  /** Forgets the runs so far. */
  clearCalls(): void {
    writeFileSync(join(this.dir, 'calls.jsonl'), '')
  }

  /** Adds a run to the log as if one had happened (for tests of what reads it). */
  record(call: FakeCall): void {
    appendFileSync(join(this.dir, 'calls.jsonl'), JSON.stringify(call) + '\n')
  }

  private save(): void {
    writeFileSync(
      join(this.dir, 'config.json'),
      JSON.stringify({ ...this.server, videos: this.videos })
    )
  }
}

// ---- Media --------------------------------------------------------------------------------------

/** Seconds of media. */
export const YT_SECONDS = 4

/** Made with the full, test-only FFmpeg (see streamMedia.ts): the app's can't encode. */
async function ff(args: string[], cwd: string): Promise<void> {
  await run(fixtureFfmpeg(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd
  })
}

/** A YouTube-like set of files: H.264 video without sound at two sizes, and AAC sound. */
async function generate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mergelane-yt-media-'))
  const video = (size: string, name: string): string[] => [
    ...['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15:duration=${YT_SECONDS}`],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', name]
  ]
  await Promise.all([
    ff(video('320x240', 'v240.mp4'), root),
    ff(video('160x120', 'v120.mp4'), root),
    ff(
      [
        ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${YT_SECONDS}`],
        ...['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', 'a.m4a']
      ],
      root
    )
  ])
  return root
}

let mediaPromise: Promise<string> | undefined
/** The media folder, made once per test worker. */
export function youtubeMedia(): Promise<string> {
  return (mediaPromise ??= generate())
}

export async function removeYoutubeMedia(): Promise<void> {
  if (!mediaPromise) return
  const root = await mediaPromise.catch(() => null)
  mediaPromise = undefined
  if (root) await rm(root, { recursive: true, force: true })
}

/** The media files' sizes, by name. */
export async function mediaSizes(): Promise<Record<string, number>> {
  const root = await youtubeMedia()
  const sizes: Record<string, number> = {}
  for (const name of ['v240.mp4', 'v120.mp4', 'a.m4a'])
    sizes[name] = (await stat(join(root, name))).size
  return sizes
}

/** A format's address on the server, "signed" for whoever asked. */
const address = (file: string): string =>
  `{base}/videoplayback?file=${file}&ip={from}&gen={gen}&expire={expire}&sig=fake`

/** The headers the fake's formats carry, as yt-dlp's do. */
export const FORMAT_HEADERS = {
  'User-Agent': 'FakeYouTubeClient/1.0',
  Accept: '*/*',
  'Sec-Fetch-Mode': 'navigate'
}

/**
 * yt-dlp-shaped JSON for a video on the server: two H.264 qualities without sound (240p "133",
 * 120p "160") and AAC sound ("140"), each fetched in `chunk`-byte ranges; plus formats Mergelane
 * must leave out: one with DRM, one "maybe" DRM, an HLS one, a storyboard, and one without a size.
 */
export async function videoInfo(
  id: string,
  options: { title?: string; chunk?: number; live?: string } = {}
): Promise<Record<string, unknown>> {
  const sizes = await mediaSizes()
  const chunk = options.chunk ?? 16 * 1024
  const common = {
    protocol: 'https',
    http_headers: FORMAT_HEADERS,
    downloader_options: { http_chunk_size: chunk },
    available_at: Math.floor(Date.now() / 1000) - 5
  }
  const video = (
    formatId: string,
    file: string,
    width: number,
    height: number,
    tbr: number
  ): Record<string, unknown> => ({
    ...common,
    format_id: formatId,
    url: address(file),
    ext: 'mp4',
    vcodec: height === 240 ? 'avc1.64000d' : 'avc1.64000b',
    acodec: 'none',
    width,
    height,
    fps: 15,
    tbr,
    filesize: sizes[file],
    format_note: `${height}p`
  })
  return {
    _type: 'video',
    id,
    title: options.title ?? 'Test card',
    extractor_key: 'Youtube',
    duration: YT_SECONDS,
    live_status: options.live ?? 'not_live',
    formats: [
      {
        format_id: 'sb0',
        protocol: 'mhtml',
        ext: 'mhtml',
        vcodec: 'none',
        acodec: 'none',
        url: '{base}/storyboard',
        format_note: 'storyboard'
      },
      {
        ...common,
        format_id: '233',
        protocol: 'm3u8_native',
        ext: 'mp4',
        vcodec: 'none',
        acodec: 'mp4a.40.5',
        url: '{base}/hls.m3u8'
      },
      { ...video('160', 'v120.mp4', 160, 120, 90), has_drm: false },
      { ...video('133', 'v240.mp4', 320, 240, 200), has_drm: false },
      { ...video('999', 'v240.mp4', 640, 480, 900), has_drm: true, format_note: '480p' },
      { ...video('998', 'v240.mp4', 1280, 720, 1900), has_drm: 'maybe', format_note: '720p' },
      { ...video('18', 'v240.mp4', 320, 240, 300), acodec: 'mp4a.40.2', filesize: null },
      {
        ...common,
        format_id: '140',
        url: address('a.m4a'),
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        tbr: 64,
        filesize: sizes['a.m4a'],
        language_preference: -1,
        format_note: 'medium'
      }
    ]
  }
}

// ---- The server -------------------------------------------------------------------------------

export interface YoutubeRequest {
  file: string
  /** Source address: which "network" it came over. */
  from: string
  /** The address its URL was "signed" for. */
  ip: string
  /** The run of the fake yt-dlp its URL came from. */
  gen: number
  range: string | undefined
  userAgent: string | undefined
  status: number
  at: number
  endedAt?: number
  held: boolean
}

/** Serves the media as YouTube serves formats, and answers "who am I". */
export class YoutubeServer {
  readonly log: YoutubeRequest[] = []
  /** Requests to answer 403, as YouTube refuses an address it no longer honours. */
  refuse: ((request: YoutubeRequest) => boolean) | null = null
  /** Requests to hold until release(). */
  hold: ((request: YoutubeRequest) => boolean) | null = null
  /** Wait before each answer. */
  delayMs = 0
  private server: Server | null = null
  private releaseHeld: () => void = () => {}
  private released = Promise.resolve()

  constructor(private readonly root: string) {}

  get base(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
  }

  async start(): Promise<this> {
    this.released = new Promise((resolve) => (this.releaseHeld = resolve))
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (url.pathname === '/whoami') {
        res
          .writeHead(200, {
            'content-type': 'text/plain',
            'content-length': Buffer.byteLength(from)
          })
          .end(from)
        return
      }
      if (url.pathname !== '/videoplayback') {
        res.writeHead(404).end()
        return
      }
      const entry: YoutubeRequest = {
        file: url.searchParams.get('file') ?? '',
        from,
        ip: url.searchParams.get('ip') ?? '',
        gen: Number(url.searchParams.get('gen')),
        range: req.headers.range,
        userAgent: req.headers['user-agent'],
        status: 0,
        at: Date.now(),
        held: false
      }
      this.log.push(entry)
      res.on('close', () => (entry.endedAt = Date.now()))
      const expire = Number(url.searchParams.get('expire')) * 1000
      void this.answer(entry, expire, res).catch(() => res.destroy())
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    return this
  }

  /** Media requests that got their bytes. */
  served(): YoutubeRequest[] {
    return this.log.filter((entry) => entry.status === 206 || entry.status === 200)
  }

  release(): void {
    this.hold = null
    this.releaseHeld()
  }

  async stop(): Promise<void> {
    this.release()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
  }

  private async answer(entry: YoutubeRequest, expire: number, res: ServerResponse): Promise<void> {
    if (this.hold?.(entry)) {
      entry.held = true
      await this.released
    }
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (res.destroyed) return
    // As YouTube: an address is good only for the address it was signed for, until it expires.
    if (entry.ip !== entry.from || !(expire > Date.now()) || this.refuse?.(entry)) {
      entry.status = 403
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
      return
    }
    let data: Buffer
    try {
      if (!/^[\w.-]+$/.test(entry.file)) throw new Error('bad name')
      data = await readFile(join(this.root, entry.file))
    } catch {
      entry.status = 404
      res.writeHead(404).end()
      return
    }
    const match = entry.range && /^bytes=(\d+)-(\d*)$/.exec(entry.range)
    if (match) {
      const start = Number(match[1])
      const end = Math.min(match[2] === '' ? data.length - 1 : Number(match[2]), data.length - 1)
      entry.status = 206
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${data.length}`
      })
      res.end(data.subarray(start, end + 1))
      return
    }
    entry.status = 200
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length })
    res.end(data)
  }
}

/** A fresh folder for a fake yt-dlp, removed by the caller. */
export async function fakeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mergelane-yt-fake-'))
}
