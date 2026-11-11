// Layer B (Node only, no Electron): the FFmpeg module in src/main/media/mux. The app's own FFmpeg
// (ADR-0028) joins and rewraps tiny media that a full, test-only FFmpeg generates with its lavfi
// sources (testsrc, sine) and reads back (see streamMedia.ts); stand-in "ffmpeg" shell scripts
// cover what a real run can't show on demand: the exact argv and environment, a process that is
// still running when it's aborted, one that ignores SIGTERM, and crashes. The app's FFmpeg is also
// checked to be the minimal LGPL build: no encoders, no network, no devices.

import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  INPUT_DEMUXERS,
  KILL_GRACE_MS,
  MuxError,
  TEMP_SUFFIX,
  TOOL_PROGRAM,
  containerForCodecs,
  muxVideoAudio,
  remux,
  resolveToolPath,
  type MuxProgress
} from '../src/main/media/mux'
import { NEEDS_FFMPEG, appFfmpeg, fixtureFfmpeg, inspect, missingFfmpeg } from './streamMedia'

const run = promisify(execFile)
let rootPromise: Promise<string> | undefined
/** Media made by generate(), inside the root folder; forgotten when the folder is removed. */
let mediaPromise: Promise<Media> | undefined
/** One scratch folder per worker, removed after the file's tests. */
function root(): Promise<string> {
  return (rootPromise ??= mkdtemp(join(tmpdir(), 'mergelane-mux-')))
}

// Fully parallel, a worker can be handed more of this file's tests after its afterAll: the folder
// is made again on demand (as in streamTransfer.spec.ts). Playwright splits a fully parallel file
// with afterAll hooks into one group per worker and runs afterAll at the end of each group, so a
// worker that picks up a second group of this file starts again from nothing. The media made in
// the folder go with it: keeping their promise would hand the next group paths that no longer
// exist (that was the "video track is missing" flake on the first real-FFmpeg test of a group).
test.afterAll(async () => {
  const removed = rootPromise
  rootPromise = undefined
  mediaPromise = undefined
  if (removed) await rm(await removed, { recursive: true, force: true })
})

/** A fresh, empty folder for one test. */
async function scratch(): Promise<string> {
  return mkdtemp(join(await root(), 'case-'))
}

/** Settles with what `promise` rejected with; fails if it fulfilled. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(TEMP_SUFFIX))
}

/** Quotes for /bin/sh. */
function sq(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** A stand-in "ffmpeg": a shell script that knows its output path as `$out` (the last argument,
 * minus the `file:` prefix). */
async function fakeTool(dir: string, body: string, mode = 0o755): Promise<string> {
  const path = join(dir, `fake-ffmpeg-${Math.random().toString(16).slice(2)}`)
  const prelude = 'for last; do :; done\nout="${last#file:}"\n'
  await writeFile(path, `#!/bin/sh\n${prelude}${body}\n`, { mode })
  return path
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- Real media ------------------------------------------------------------------------------

interface Media {
  dir: string
  h264: string
  aac: string
  vp9: string
  opus: string
  vp8: string
  /** H.264 video with its own AAC audio. */
  muxed: string
  /** An MPEG transport stream with H.264 and AAC, as HLS serves. */
  ts: string
}

/** Makes media with the full, test-only FFmpeg: the app's can't encode. */
async function ff(args: string[]): Promise<void> {
  await run(fixtureFfmpeg(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args])
}

const VIDEO_SOURCE = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=2']
const AUDIO_SOURCE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']

async function generate(): Promise<Media> {
  const dir = await mkdtemp(join(await root(), 'media-'))
  const at = (name: string): string => join(dir, name)
  const media: Media = {
    dir,
    h264: at('h264.mp4'),
    aac: at('aac.m4a'),
    vp9: at('vp9.webm'),
    opus: at('opus.webm'),
    vp8: at('vp8.webm'),
    muxed: at('muxed.mp4'),
    ts: at('stream.ts')
  }
  await Promise.all([
    ff([...VIDEO_SOURCE, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media.h264]),
    ff([...AUDIO_SOURCE, '-c:a', 'aac', media.aac]),
    ff([...VIDEO_SOURCE, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', media.vp9]),
    ff([...AUDIO_SOURCE, '-c:a', 'libopus', media.opus]),
    ff([...VIDEO_SOURCE, '-c:v', 'libvpx', '-deadline', 'realtime', media.vp8])
  ])
  const both = ['-i', media.h264, '-i', media.aac, '-map', '0:v', '-map', '1:a', '-c', 'copy']
  await ff([...both, media.muxed])
  await ff([...both, '-f', 'mpegts', media.ts])
  return media
}

/** The test media, made once per group of tests (see the afterAll above). */
function media(): Promise<Media> {
  return (mediaPromise ??= generate())
}

/** Top-level ISO BMFF box types, in file order. */
async function topLevelBoxes(file: string): Promise<string[]> {
  const data = await readFile(file)
  const boxes: string[] = []
  let offset = 0
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset)
    boxes.push(data.toString('latin1', offset + 4, offset + 8))
    if (size === 1) size = Number(data.readBigUInt64BE(offset + 8))
    if (size === 0) break
    offset += size
  }
  return boxes
}

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

test.describe('FFmpeg mux module @smoke', () => {
  test.describe('finding the tools', () => {
    async function layout(): Promise<{ resources: string; appDir: string; bin: string }> {
      const dir = await scratch()
      const resources = join(dir, 'Contents', 'Resources')
      const appDir = join(dir, 'app')
      const bin = join(appDir, 'resources', 'bin')
      await mkdir(resources, { recursive: true })
      await mkdir(bin, { recursive: true })
      return { resources, appDir, bin }
    }

    /** Writes a stand-in program at `path`, making its folder. */
    async function program(path: string, mode = 0o755): Promise<void> {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, '#!/bin/sh\n', { mode })
    }

    test('a packaged app uses Contents/Resources and ignores the environment', async () => {
      const { resources, appDir, bin } = await layout()
      await program(join(resources, 'ffmpeg'))
      await program(join(resources, 'yt-dlp', 'yt-dlp_macos'))
      await program(join(bin, 'ffmpeg'))
      const where = {
        isPackaged: true,
        resourcesPath: resources,
        appRoot: appDir,
        env: { MERGELANE_FFMPEG_PATH: join(bin, 'ffmpeg') }
      }
      expect(await resolveToolPath('ffmpeg', where)).toEqual({
        path: join(resources, 'ffmpeg'),
        source: 'packaged'
      })
      expect(await resolveToolPath('yt-dlp', where)).toEqual({
        path: join(resources, 'yt-dlp', 'yt-dlp_macos'),
        source: 'packaged'
      })
    })

    test('development uses app/resources/bin; an empty override is no override', async () => {
      const { resources, appDir, bin } = await layout()
      await program(join(bin, 'yt-dlp', 'yt-dlp_macos'))
      expect(
        await resolveToolPath('yt-dlp', {
          isPackaged: false,
          resourcesPath: resources,
          appRoot: appDir,
          env: { MERGELANE_YTDLP_PATH: '' }
        })
      ).toEqual({ path: join(bin, 'yt-dlp', 'yt-dlp_macos'), source: 'development' })
    })

    test('yt-dlp is its unpacked build: the program inside its folder, as fetch and packaging install it', async () => {
      // tools.json says how fetch.mjs installs each tool, electron-builder.yml where it goes.
      const manifest = JSON.parse(
        await readFile(join(__dirname, '..', '..', 'scripts', 'media-tools', 'tools.json'), 'utf8')
      ) as { tools: { name: string; install: string; executable?: string }[] }
      const builder = await readFile(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
      for (const { name, install, executable } of manifest.tools) {
        const tool = name as keyof typeof TOOL_PROGRAM
        expect(TOOL_PROGRAM[tool], name).toBe(install === 'folder' ? `${name}/${executable}` : name)
        expect(builder, name).toContain(`- from: resources/bin/${name}\n    to: ${name}\n`)
      }
      expect(TOOL_PROGRAM['yt-dlp']).toBe('yt-dlp/yt-dlp_macos')

      // The single program an older fetch left in its place is not taken for it.
      const { resources, appDir, bin } = await layout()
      await program(join(bin, 'yt-dlp'))
      const old = await resolveToolPath('yt-dlp', {
        isPackaged: false,
        resourcesPath: resources,
        appRoot: appDir,
        env: {}
      })
      expect(old.path === null && old.reason).toBe(
        `yt-dlp was not found at ${join(bin, 'yt-dlp', 'yt-dlp_macos')}. Run "npm run fetch:media-tools" in app/ to download it.`
      )
    })

    test('the environment overrides each tool in development', async () => {
      const { resources, appDir } = await layout()
      const elsewhere = await scratch()
      for (const tool of ['ffmpeg', 'yt-dlp']) {
        await writeFile(join(elsewhere, tool), '#!/bin/sh\n', { mode: 0o755 })
      }
      const where = {
        isPackaged: false,
        resourcesPath: resources,
        appRoot: appDir,
        env: {
          MERGELANE_FFMPEG_PATH: join(elsewhere, 'ffmpeg'),
          MERGELANE_YTDLP_PATH: join(elsewhere, 'yt-dlp')
        }
      }
      expect(await resolveToolPath('ffmpeg', where)).toEqual({
        path: join(elsewhere, 'ffmpeg'),
        source: 'override'
      })
      expect(await resolveToolPath('yt-dlp', where)).toEqual({
        path: join(elsewhere, 'yt-dlp'),
        source: 'override'
      })
    })

    test('without an env option it reads process.env', async () => {
      const elsewhere = await scratch()
      const tool = join(elsewhere, 'yt-dlp')
      await writeFile(tool, '#!/bin/sh\n', { mode: 0o755 })
      const before = process.env.MERGELANE_YTDLP_PATH
      process.env.MERGELANE_YTDLP_PATH = tool
      try {
        expect(
          await resolveToolPath('yt-dlp', { isPackaged: false, resourcesPath: '', appRoot: '' })
        ).toEqual({ path: tool, source: 'override' })
      } finally {
        if (before === undefined) delete process.env.MERGELANE_YTDLP_PATH
        else process.env.MERGELANE_YTDLP_PATH = before
      }
    })

    test('a missing tool resolves to null with a reason for each mode', async () => {
      const { resources, appDir, bin } = await layout()
      const dev = await resolveToolPath('ffmpeg', {
        isPackaged: false,
        resourcesPath: resources,
        appRoot: appDir,
        env: {}
      })
      expect(dev).toEqual({
        path: null,
        source: 'development',
        candidate: join(bin, 'ffmpeg'),
        reason: `FFmpeg was not found at ${join(bin, 'ffmpeg')}. Run "npm run fetch:media-tools" in app/ to download it.`
      })

      const packaged = await resolveToolPath('yt-dlp', {
        isPackaged: true,
        resourcesPath: resources,
        appRoot: appDir
      })
      expect(packaged).toMatchObject({ path: null, source: 'packaged' })
      expect(packaged.path === null && packaged.reason).toBe(
        `yt-dlp was not found at ${join(resources, 'yt-dlp', 'yt-dlp_macos')}. Reinstall Mergelane to restore it.`
      )

      const override = await resolveToolPath('ffmpeg', {
        isPackaged: false,
        resourcesPath: resources,
        appRoot: appDir,
        env: { MERGELANE_FFMPEG_PATH: join(bin, 'nope') }
      })
      expect(override.path === null && override.reason).toBe(
        `FFmpeg was not found at ${join(bin, 'nope')} (set by MERGELANE_FFMPEG_PATH).`
      )
    })

    test('a relative override, a folder and a non-executable file are refused', async () => {
      const { resources, appDir, bin } = await layout()
      const base = { isPackaged: false, resourcesPath: resources, appRoot: appDir }

      const relative = await resolveToolPath('ffmpeg', {
        ...base,
        env: { MERGELANE_FFMPEG_PATH: 'bin/ffmpeg' }
      })
      expect(relative).toEqual({
        path: null,
        source: 'override',
        candidate: 'bin/ffmpeg',
        reason: 'MERGELANE_FFMPEG_PATH must be an absolute path, but it is "bin/ffmpeg".'
      })

      await mkdir(join(bin, 'ffmpeg'))
      const folder = await resolveToolPath('ffmpeg', { ...base, env: {} })
      expect(folder.path === null && folder.reason).toBe(
        `FFmpeg at ${join(bin, 'ffmpeg')} is not a file. Run "npm run fetch:media-tools" in app/ to download it.`
      )

      await program(join(bin, 'yt-dlp', 'yt-dlp_macos'), 0o644)
      const plain = await resolveToolPath('yt-dlp', { ...base, env: {} })
      expect(plain.path === null && plain.reason).toBe(
        `yt-dlp at ${join(bin, 'yt-dlp', 'yt-dlp_macos')} is not executable. Run "npm run fetch:media-tools" in app/ to download it.`
      )
    })
  })

  test.describe('choosing a container from RFC 6381 codecs', () => {
    test('codecs MP4 holds pick MP4', () => {
      for (const codecs of [
        ['avc1.64001f', 'mp4a.40.2'],
        ['avc3.4d401e', 'mp4a.40.5'],
        ['hvc1.1.6.L93.B0', 'ec-3'],
        ['hev1.2.4.L120.B0', 'ac-3'],
        ['av01.0.04M.08', 'Opus'],
        ['vp09.00.10.08', 'opus'],
        ['vp9', 'fLaC'],
        ['avc1.42e01e', 'mp4a.69'],
        ['avc1.42e01e', 'mp4a.6B'],
        ['avc1.42e01e', 'mp4a.67'],
        ['avc1.42e01e', 'mp4a.ad'],
        ['mp4a.40.2,avc1.4d401e'],
        [' avc1.64001f , mp4a.40.2 ', 'wvtt', 'stpp.ttml.im1t']
      ]) {
        expect(containerForCodecs(codecs), codecs.join(',')).toBe('mp4')
      }
    })

    test('VP8, Vorbis, Theora, unknown or missing codecs pick MKV', () => {
      for (const codecs of [
        ['vp8', 'vorbis'],
        ['vp08.00.10.08', 'opus'],
        ['avc1.64001f', 'vorbis'],
        ['theora', 'mp4a.40.2'],
        ['avc1.64001f', 'mp4a.dd'],
        ['avc1.64001f', 'mp4a'],
        ['avc1.64001f', 'mp4a.A5'],
        ['dvh1.05.06', 'mp4a.40.2'],
        ['constructor', 'mp4a.40.2'],
        ['wvtt'],
        [''],
        []
      ]) {
        expect(containerForCodecs(codecs), codecs.join(',')).toBe('mkv')
      }
      expect(containerForCodecs(undefined)).toBe('mkv')
    })
  })

  test.describe('requests it refuses', () => {
    test('relative paths, unknown containers, bad durations and output = input', async () => {
      const dir = await scratch()
      const video = join(dir, 'v.mkv')
      const cases: [Parameters<typeof muxVideoAudio>[0], string][] = [
        [{ ffmpeg: 'ffmpeg', video, output: join(dir, 'o.mp4'), container: 'mp4' }, 'ffmpeg'],
        [{ ffmpeg: '/x', video, output: 'o.mp4', container: 'mp4' }, 'output'],
        [{ ffmpeg: '/x', video: 'v.mp4', output: join(dir, 'o.mp4'), container: 'mp4' }, 'video'],
        [
          { ffmpeg: '/x', video, audio: 'a.m4a', output: join(dir, 'o.mp4'), container: 'mp4' },
          'audio'
        ],
        [
          {
            ffmpeg: '/x',
            video,
            output: join(dir, 'o.mp4'),
            container: 'webm' as unknown as 'mp4'
          },
          'container'
        ],
        [
          { ffmpeg: '/x', video, output: join(dir, 'o.mp4'), container: 'mp4', duration: 0 },
          'duration'
        ],
        [
          { ffmpeg: '/x', video, output: join(dir, 'o.mp4'), container: 'mp4', duration: NaN },
          'duration'
        ],
        [
          { ffmpeg: '/x', video, output: join(dir, 'o.mp4'), container: 'mkv', duration: Infinity },
          'duration'
        ],
        // 'auto' with no codecs picks MKV, which makes the output the input itself.
        [{ ffmpeg: '/x', video, output: join(dir, 'v.mp4'), container: 'auto' }, 'output must not']
      ]
      for (const [options, mentions] of cases) {
        const error = await failure(muxVideoAudio(options))
        expect(error, mentions).toBeInstanceOf(TypeError)
        expect((error as Error).message).toContain(mentions)
      }
      const same = await failure(
        remux({
          ffmpeg: '/x',
          input: video,
          output: join(dir, 'x', '..', 'v.mkv'),
          container: 'mkv'
        })
      )
      expect(same).toBeInstanceOf(TypeError)
    })

    test('a missing input is reported before FFmpeg runs', async () => {
      const dir = await scratch()
      const marker = join(dir, 'ran')
      const tool = await fakeTool(dir, `: > ${sq(marker)}`)
      await writeFile(join(dir, 'v.mp4'), 'video')

      const noVideo = await failure(
        muxVideoAudio({
          ffmpeg: tool,
          video: join(dir, 'missing.mp4'),
          audio: join(dir, 'v.mp4'),
          output: join(dir, 'o.mp4'),
          container: 'mp4'
        })
      )
      expect(noVideo).toBeInstanceOf(MuxError)
      expect(noVideo).toMatchObject({
        code: 'input-missing',
        message: `Mergelane couldn't combine the video and audio: the video track is missing (${join(dir, 'missing.mp4')}). Download it again.`
      })

      const noAudio = await failure(
        muxVideoAudio({
          ffmpeg: tool,
          video: join(dir, 'v.mp4'),
          audio: dir, // a folder is not a track either
          output: join(dir, 'o.mp4'),
          container: 'mp4'
        })
      )
      expect(noAudio).toMatchObject({ code: 'input-missing' })
      expect((noAudio as Error).message).toContain('the audio track is missing')

      const noInput = await failure(
        remux({
          ffmpeg: tool,
          input: join(dir, 'gone.ts'),
          output: join(dir, 'o.mp4'),
          container: 'mp4'
        })
      )
      expect((noInput as Error).message).toContain(
        "couldn't convert the downloaded stream: the downloaded file is missing"
      )
      await expect(stat(marker)).rejects.toThrow()
    })

    test('a missing output folder is reported before FFmpeg runs', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'video')
      const error = await failure(
        remux({
          ffmpeg: await fakeTool(dir, 'exit 0'),
          input: join(dir, 'v.mp4'),
          output: join(dir, 'no-such-folder', 'o.mp4'),
          container: 'mp4'
        })
      )
      expect(error).toBeInstanceOf(MuxError)
      expect(error).toMatchObject({
        code: 'output-failed',
        message: `Mergelane couldn't save o.mp4: the folder ${join(dir, 'no-such-folder')} doesn't exist or can't be written to.`
      })
      expect((error as MuxError).detail).toContain('ENOENT')
    })
  })

  test.describe('how FFmpeg is run (stand-in executable)', () => {
    /** A stand-in that records its argv and environment, then writes "x" as its output. */
    async function recorder(dir: string): Promise<{ tool: string; args: () => Promise<string[]> }> {
      const argsFile = join(dir, 'args.txt')
      const tool = await fakeTool(
        dir,
        [
          `printf '%s\\n' "$@" > ${sq(argsFile)}`,
          `env > ${sq(join(dir, 'env.txt'))}`,
          `printf x > "$out"`
        ].join('\n')
      )
      return {
        tool,
        args: async () => (await readFile(argsFile, 'utf8')).split('\n').slice(0, -1)
      }
    }

    test('joining to MP4: argv array, file: URLs, whitelists per input, faststart', async () => {
      const dir = await scratch()
      const { tool, args } = await recorder(dir)
      const video = join(dir, 'video.mp4')
      const audio = join(dir, 'audio.m4a')
      await writeFile(video, 'v')
      await writeFile(audio, 'a')
      const output = join(dir, 'Talk.mp4')

      const result = await muxVideoAudio({ ffmpeg: tool, video, audio, output, container: 'mp4' })
      expect(result).toEqual({ output, container: 'mp4' })
      expect(await readFile(output, 'utf8')).toBe('x')
      expect(await leftovers(dir)).toEqual([])

      const argv = await args()
      const temp = argv.at(-1) ?? ''
      expect(temp.startsWith(`file:${output}.`)).toBe(true)
      expect(temp.endsWith(TEMP_SUFFIX)).toBe(true)
      expect(argv).toEqual([
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostats',
        '-progress',
        'pipe:1',
        '-y',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        INPUT_DEMUXERS,
        '-i',
        `file:${video}`,
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        INPUT_DEMUXERS,
        '-i',
        `file:${audio}`,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-f',
        'mp4',
        '-movflags',
        '+faststart',
        temp
      ])
    })

    test('MKV has no movflags; video alone keeps its own audio; remux maps both optionally', async () => {
      const dir = await scratch()
      const { tool, args } = await recorder(dir)
      const video = join(dir, 'video.webm')
      await writeFile(video, 'v')

      await muxVideoAudio({ ffmpeg: tool, video, output: join(dir, 'o.mkv'), container: 'mkv' })
      const muxArgs = await args()
      expect(muxArgs.slice(8, -1)).toEqual([
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        INPUT_DEMUXERS,
        '-i',
        `file:${video}`,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-f',
        'matroska'
      ])

      await remux({ ffmpeg: tool, input: video, output: join(dir, 'o.mp4'), container: 'mp4' })
      const remuxArgs = await args()
      expect(remuxArgs.slice(14, -1)).toEqual([
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-f',
        'mp4',
        '-movflags',
        '+faststart'
      ])
    })

    test('FFmpeg gets only PATH from the environment (no FFREPORT)', async () => {
      const dir = await scratch()
      const { tool } = await recorder(dir)
      await writeFile(join(dir, 'v.mp4'), 'v')
      const saved = { FFREPORT: process.env.FFREPORT, SENTINEL: process.env.MERGELANE_SENTINEL }
      process.env.FFREPORT = `file=${join(dir, 'report.log')}`
      process.env.MERGELANE_SENTINEL = 'leaked'
      try {
        await remux({
          ffmpeg: tool,
          input: join(dir, 'v.mp4'),
          output: join(dir, 'o.mkv'),
          container: 'mkv'
        })
      } finally {
        for (const [key, value] of [
          ['FFREPORT', saved.FFREPORT],
          ['MERGELANE_SENTINEL', saved.SENTINEL]
        ] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      const env = await readFile(join(dir, 'env.txt'), 'utf8')
      expect(env).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin')
      expect(env).not.toContain('FFREPORT')
      expect(env).not.toContain('leaked')
    })

    test("'auto' names the output after the container it picked", async () => {
      const dir = await scratch()
      const { tool } = await recorder(dir)
      const video = join(dir, 'video.bin')
      await writeFile(video, 'v')
      const h264 = ['avc1.64001f', 'mp4a.40.2']
      const cases: [string, readonly string[] | undefined, string][] = [
        ['Talk', h264, 'Talk.mp4'],
        ['Talk.MKV', h264, 'Talk.mp4'],
        ['Talk.mp4', ['vp8', 'vorbis'], 'Talk.mkv'],
        ['Talk.2024', undefined, 'Talk.2024.mkv'],
        ['Talk.webm', ['vp09.00.10.08', 'opus'], 'Talk.mp4']
      ]
      for (const [name, codecs, expected] of cases) {
        const result = await muxVideoAudio({
          ffmpeg: tool,
          video,
          output: join(dir, name),
          container: 'auto',
          codecs
        })
        expect(result.output, name).toBe(join(dir, expected))
        expect(await readFile(result.output, 'utf8')).toBe('x')
      }
    })

    test('an existing output is replaced only once the new file is complete', async () => {
      const dir = await scratch()
      const { tool } = await recorder(dir)
      await writeFile(join(dir, 'v.mp4'), 'v')
      const output = join(dir, 'o.mp4')
      await writeFile(output, 'old')
      await remux({ ffmpeg: tool, input: join(dir, 'v.mp4'), output, container: 'mp4' })
      expect(await readFile(output, 'utf8')).toBe('x')
    })

    test('progress lines become reports, in any chunking', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'v')
      const tool = await fakeTool(
        dir,
        [
          `printf 'frame=1\\nout_time_us=N/A\\nprogress=continue\\n'`,
          'sleep 0.1',
          `printf 'out_time_us=500000\\nprog'`,
          'sleep 0.1',
          `printf 'ress=continue\\n'`,
          // A runaway line with no newline yet: dropped, not buffered forever.
          `printf '%5000s' ''`,
          'sleep 0.1',
          `printf '=junk\\nnot a key value line\\nout_time_us=-5\\nprogress=continue\\n'`,
          `printf 'out_time_us=9000000\\nprogress=continue\\n'`,
          `printf 'out_time_us=1900000\\nprogress=end\\n'`,
          `printf x > "$out"`
        ].join('\n')
      )
      const reports: MuxProgress[] = []
      await remux({
        ffmpeg: tool,
        input: join(dir, 'v.mp4'),
        output: join(dir, 'o.mp4'),
        container: 'mp4',
        duration: 2,
        onProgress: (report) => reports.push(report)
      })
      expect(reports).toEqual([
        { outTimeSeconds: 0, fraction: 0, done: false },
        { outTimeSeconds: 0.5, fraction: 0.25, done: false },
        { outTimeSeconds: 0, fraction: 0, done: false },
        { outTimeSeconds: 9, fraction: 1, done: false },
        { outTimeSeconds: 1.9, fraction: 1, done: true }
      ])

      const unknownLength: MuxProgress[] = []
      await remux({
        ffmpeg: tool,
        input: join(dir, 'v.mp4'),
        output: join(dir, 'o2.mp4'),
        container: 'mp4',
        onProgress: (report) => unknownLength.push(report)
      })
      expect(unknownLength.map((report) => report.fraction)).toEqual([null, null, null, null, null])
    })

    test('aborting mid-run stops FFmpeg and deletes the temporary file', async () => {
      const dir = await scratch()
      const pidFile = join(dir, 'pid')
      await writeFile(join(dir, 'v.mp4'), 'v')
      const tool = await fakeTool(
        dir,
        `echo $$ > ${sq(pidFile)}\nprintf partial > "$out"\nexec sleep 30`
      )
      const controller = new AbortController()
      const reason = new Error('user cancelled')
      const job = remux({
        ffmpeg: tool,
        input: join(dir, 'v.mp4'),
        output: join(dir, 'o.mp4'),
        container: 'mp4',
        signal: controller.signal
      })
      await waitFor(async () => (await leftovers(dir)).length === 1)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(isRunning(pid)).toBe(true)

      const started = Date.now()
      controller.abort(reason)
      expect(await failure(job)).toBe(reason)
      expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS)
      expect(isRunning(pid)).toBe(false)
      expect(await leftovers(dir)).toEqual([])
      await expect(stat(join(dir, 'o.mp4'))).rejects.toThrow()
    })

    test('an FFmpeg that ignores SIGTERM is killed after the grace period', async () => {
      const dir = await scratch()
      const pidFile = join(dir, 'pid')
      await writeFile(join(dir, 'v.mp4'), 'v')
      const tool = await fakeTool(
        dir,
        `trap '' TERM\necho $$ > ${sq(pidFile)}\nprintf partial > "$out"\nexec sleep 30`
      )
      const controller = new AbortController()
      const job = remux({
        ffmpeg: tool,
        input: join(dir, 'v.mp4'),
        output: join(dir, 'o.mp4'),
        container: 'mp4',
        signal: controller.signal
      })
      await waitFor(async () => (await leftovers(dir)).length === 1)
      const pid = Number(await readFile(pidFile, 'utf8'))

      const started = Date.now()
      controller.abort()
      const error = await failure(job)
      const took = Date.now() - started
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(took).toBeGreaterThanOrEqual(KILL_GRACE_MS - 50)
      expect(took).toBeLessThan(KILL_GRACE_MS + 2000)
      expect(isRunning(pid)).toBe(false)
      expect(await leftovers(dir)).toEqual([])
    })

    test('an abort before FFmpeg starts never starts it', async () => {
      const dir = await scratch()
      const marker = join(dir, 'ran')
      const tool = await fakeTool(dir, `: > ${sq(marker)}`)
      await writeFile(join(dir, 'v.mp4'), 'v')
      const options = {
        ffmpeg: tool,
        video: join(dir, 'v.mp4'),
        output: join(dir, 'o.mp4'),
        container: 'mp4' as const
      }

      const reason = new Error('already gone')
      expect(await failure(muxVideoAudio({ ...options, signal: AbortSignal.abort(reason) }))).toBe(
        reason
      )

      // Aborted while the inputs are being checked.
      const controller = new AbortController()
      const job = muxVideoAudio({ ...options, signal: controller.signal })
      controller.abort(reason)
      expect(await failure(job)).toBe(reason)

      await expect(stat(marker)).rejects.toThrow()
    })

    test('an onProgress that throws stops FFmpeg and rejects with its error', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'v')
      const tool = await fakeTool(
        dir,
        `printf partial > "$out"\nprintf 'out_time_us=1\\nprogress=continue\\nprogress=continue\\n'\nexec sleep 30`
      )
      const oops = new Error('UI went away')
      let calls = 0
      const started = Date.now()
      const error = await failure(
        remux({
          ffmpeg: tool,
          input: join(dir, 'v.mp4'),
          output: join(dir, 'o.mp4'),
          container: 'mp4',
          onProgress: () => {
            calls++
            throw oops
          }
        })
      )
      expect(error).toBe(oops)
      expect(calls).toBe(1)
      expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS)
      expect(await leftovers(dir)).toEqual([])
    })

    test('an FFmpeg that cannot start is reported as missing', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'v')
      const notExecutable = await fakeTool(dir, 'exit 0', 0o644)
      for (const tool of [join(dir, 'no-ffmpeg-here'), notExecutable]) {
        const error = await failure(
          remux({
            ffmpeg: tool,
            input: join(dir, 'v.mp4'),
            output: join(dir, 'o.mp4'),
            container: 'mp4'
          })
        )
        expect(error).toBeInstanceOf(MuxError)
        expect(error).toMatchObject({
          code: 'tool-missing',
          message:
            "Mergelane couldn't convert the downloaded stream because FFmpeg could not be started. Reinstall Mergelane."
        })
        expect((error as MuxError).detail).toMatch(/ENOENT|EACCES/)
      }
      expect(await leftovers(dir)).toEqual([])
    })

    test('a failing FFmpeg: the message is for people, stderr goes to detail', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'v')
      const tool = await fakeTool(
        dir,
        `printf partial > "$out"\ni=1\nwhile [ $i -le 40 ]; do echo "stderr line $i" >&2; i=$((i+1)); done\nexit 3`
      )
      const error = await failure(
        muxVideoAudio({
          ffmpeg: tool,
          video: join(dir, 'v.mp4'),
          output: join(dir, 'o.mkv'),
          container: 'mkv'
        })
      )
      expect(error).toBeInstanceOf(MuxError)
      const { code, message, detail } = error as MuxError
      expect(code).toBe('ffmpeg-failed')
      expect(message).toBe(
        "Mergelane couldn't combine the video and audio: FFmpeg reported an error. The downloaded tracks may be damaged, or use a format that MKV can't hold."
      )
      expect(message).not.toContain('stderr')
      const lines = (detail ?? '').split('\n')
      expect(lines[0]).toBe('FFmpeg exited with code 3.')
      expect(lines.slice(1)).toEqual(
        Array.from({ length: 12 }, (_, index) => `stderr line ${29 + index}`)
      )
      expect(await leftovers(dir)).toEqual([])
      await expect(stat(join(dir, 'o.mkv'))).rejects.toThrow()
    })

    test('an FFmpeg killed by a signal, or one that writes nothing, fails', async () => {
      const dir = await scratch()
      await writeFile(join(dir, 'v.mp4'), 'v')
      const options = {
        input: join(dir, 'v.mp4'),
        output: join(dir, 'o.mp4'),
        container: 'mp4' as const
      }

      const crashed = await failure(
        remux({
          ...options,
          ffmpeg: await fakeTool(dir, `printf partial > "$out"\necho dying >&2\nkill -KILL $$`)
        })
      )
      expect(crashed).toMatchObject({
        code: 'ffmpeg-failed',
        message: "Mergelane couldn't convert the downloaded stream: FFmpeg stopped unexpectedly.",
        detail: 'FFmpeg was killed by SIGKILL.\ndying'
      })

      const silent = await failure(remux({ ...options, ffmpeg: await fakeTool(dir, 'exit 0') }))
      expect(silent).toMatchObject({
        code: 'ffmpeg-failed',
        message:
          "Mergelane couldn't convert the downloaded stream: FFmpeg finished without writing a file.",
        detail: 'FFmpeg exited with code 0 but the output is missing or empty.'
      })
      expect(await leftovers(dir)).toEqual([])
    })

    test('a finished file that cannot be moved into place is an output error', async () => {
      const dir = await scratch()
      const { tool } = await recorder(dir)
      await writeFile(join(dir, 'v.mp4'), 'v')
      // A non-empty folder where the output should go: rename() can't replace it.
      const output = join(dir, 'o.mp4')
      await mkdir(output)
      await writeFile(join(output, 'keep'), 'k')
      const error = await failure(
        remux({ ffmpeg: tool, input: join(dir, 'v.mp4'), output, container: 'mp4' })
      )
      expect(error).toBeInstanceOf(MuxError)
      expect(error).toMatchObject({
        code: 'output-failed',
        message: `Mergelane couldn't save o.mp4 in ${dir}.`
      })
      expect((error as MuxError).detail).toMatch(/^E[A-Z]+:/)
      expect(await leftovers(dir)).toEqual([])
      expect(await readFile(join(output, 'keep'), 'utf8')).toBe('k')
    })
  })

  test.describe('Mergelane’s own FFmpeg, the minimal LGPL build (ADR-0028)', () => {
    const missing = missingFfmpeg({ app: true })
    test.skip(!!missing, missing)

    /** What `ffmpeg -hide_banner <option>` prints. */
    async function show(option: string): Promise<string> {
      return (await run(appFfmpeg(), ['-hide_banner', option])).stdout
    }

    /** The entries of an `-encoders` or `-devices` list: the lines after its dashed line. */
    function entries(list: string): string[] {
      const lines = list.split('\n')
      return lines.slice(lines.findIndex((line) => /^ -+$/.test(line)) + 1).filter(Boolean)
    }

    /** The stderr of an FFmpeg run that must fail. */
    async function refusal(args: string[]): Promise<string> {
      const error = await failure(run(appFfmpeg(), ['-nostdin', '-hide_banner', ...args]))
      return (error as { stderr: string }).stderr
    }

    test('is licensed LGPL 2.1 or later, with no encoders, devices or network', async () => {
      const license = await show('-L')
      expect(license).toContain('GNU Lesser General Public\nLicense')
      expect(license).toContain('version 2.1 of the License, or (at your option) any later version')
      const buildconf = await show('-buildconf')
      expect(buildconf).not.toMatch(/--enable-(gpl|version3|nonfree)\b/)
      for (const option of [
        '--disable-everything',
        '--disable-autodetect',
        '--disable-network',
        '--disable-avdevice'
      ]) {
        expect(buildconf).toContain(option)
      }
      expect(entries(await show('-encoders'))).toEqual([])
      expect(entries(await show('-devices'))).toEqual([])
      // file for the media, pipe for -progress on stdout: nothing that reaches a network.
      expect(await show('-protocols')).toBe(
        'Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n  pipe\n'
      )
    })

    test('refuses network addresses without connecting anywhere', async () => {
      const dir = await scratch()
      let connections = 0
      const server = createServer((_request, response) => response.end())
      server.on('connection', () => connections++)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      try {
        for (const url of [
          `http://127.0.0.1:${port}/video.mp4`,
          `https://127.0.0.1:${port}/video.mp4`,
          `tcp://127.0.0.1:${port}`,
          `rtmp://127.0.0.1:${port}/live`
        ]) {
          const stderr = await refusal([
            '-i',
            url,
            '-c',
            'copy',
            '-f',
            'mp4',
            `file:${join(dir, 'o.mp4')}`
          ])
          expect(stderr, url).toContain('Protocol not found')
        }
      } finally {
        server.close()
      }
      expect(connections).toBe(0)
      expect(await readdir(dir)).toEqual([])
    })

    test('has no generated sources or capture devices to read from', async () => {
      const dir = await scratch()
      for (const [format, input] of [
        ['lavfi', 'testsrc'],
        ['avfoundation', '0:0']
      ]) {
        const stderr = await refusal([
          '-f',
          format,
          '-i',
          input,
          '-t',
          '1',
          `file:${join(dir, 'o.mkv')}`
        ])
        expect(stderr).toContain(`Unknown input format: '${format}'`)
      }
      expect(await readdir(dir)).toEqual([])
    })
  })

  test.describe('with a real FFmpeg', () => {
    test.skip(!!NEEDS_FFMPEG, NEEDS_FFMPEG)

    test('the app’s FFmpeg refuses to re-encode: it can only copy streams', async () => {
      const { h264, aac } = await media()
      const dir = await scratch()
      for (const [input, codec] of [
        [h264, ['-c:v', 'libx264']],
        [h264, ['-c:v', 'h264']],
        [aac, ['-c:a', 'aac']]
      ] as const) {
        const error = await failure(
          run(appFfmpeg(), [
            ...['-nostdin', '-hide_banner', '-i', `file:${input}`, ...codec],
            ...['-f', 'mp4', `file:${join(dir, 'o.mp4')}`]
          ])
        )
        expect((error as { stderr: string }).stderr).toContain(`Unknown encoder '${codec[1]}'`)
      }
      expect(await readdir(dir)).toEqual([])
    })

    test('joins H.264 and AAC into an MP4 with its index at the front', async () => {
      const { h264, aac } = await media()
      const dir = await scratch()
      const output = join(dir, 'joined.mp4')
      expect(
        await muxVideoAudio({
          ffmpeg: appFfmpeg(),
          video: h264,
          audio: aac,
          output,
          container: 'mp4'
        })
      ).toEqual({ output, container: 'mp4' })

      const found = await inspect(output)
      expect(found.format).toContain('mp4')
      expect(found.video).toEqual(['h264'])
      expect(found.audio).toEqual(['aac'])
      const boxes = await topLevelBoxes(output)
      expect(boxes).toContain('mdat')
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'))
      expect(await readdir(dir)).toEqual(['joined.mp4'])
    })

    test('joins VP9 and Opus into an MKV', async () => {
      const { vp9, opus } = await media()
      const dir = await scratch()
      const output = join(dir, 'joined.mkv')
      await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: vp9,
        audio: opus,
        output,
        container: 'mkv'
      })

      expect((await readFile(output)).subarray(0, 4)).toEqual(EBML_MAGIC)
      const found = await inspect(output)
      expect(found.format).toContain('matroska')
      expect(found.video).toEqual(['vp9'])
      expect(found.audio).toEqual(['opus'])
      expect(await readdir(dir)).toEqual(['joined.mkv'])
    })

    test("'auto' writes MP4 for codecs MP4 holds and MKV otherwise", async () => {
      const { h264, aac, vp8, opus } = await media()
      const dir = await scratch()

      const mp4 = await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: h264,
        audio: aac,
        output: join(dir, 'first.mkv'),
        container: 'auto',
        codecs: ['avc1.64000c', 'mp4a.40.2']
      })
      expect(mp4).toEqual({ output: join(dir, 'first.mp4'), container: 'mp4' })
      expect(await inspect(mp4.output)).toMatchObject({ video: ['h264'], audio: ['aac'] })
      expect(await topLevelBoxes(mp4.output)).toContain('moov')

      const mkv = await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: vp8,
        audio: opus,
        output: join(dir, 'second'),
        container: 'auto',
        codecs: ['vp8', 'opus']
      })
      expect(mkv).toEqual({ output: join(dir, 'second.mkv'), container: 'mkv' })
      expect(await inspect(mkv.output)).toMatchObject({ video: ['vp8'], audio: ['opus'] })

      const unknown = await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: h264,
        audio: aac,
        output: join(dir, 'third.mp4'),
        container: 'auto'
      })
      expect(unknown.output).toBe(join(dir, 'third.mkv'))
      expect(await inspect(unknown.output)).toMatchObject({
        format: expect.stringContaining('matroska'),
        video: ['h264'],
        audio: ['aac']
      })
    })

    test('without an audio track the video keeps its own audio, if any', async () => {
      const { muxed, h264 } = await media()
      const dir = await scratch()
      const withAudio = join(dir, 'with.mp4')
      await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: muxed,
        output: withAudio,
        container: 'mp4'
      })
      expect(await inspect(withAudio)).toMatchObject({ video: ['h264'], audio: ['aac'] })

      const silent = join(dir, 'silent.mkv')
      await muxVideoAudio({ ffmpeg: appFfmpeg(), video: h264, output: silent, container: 'mkv' })
      expect(await inspect(silent)).toMatchObject({ video: ['h264'], audio: [] })
    })

    test('reports progress up to the end', async () => {
      const { h264, aac } = await media()
      const dir = await scratch()
      const reports: MuxProgress[] = []
      await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: h264,
        audio: aac,
        output: join(dir, 'p.mp4'),
        container: 'mp4',
        duration: 2,
        onProgress: (report) => reports.push(report)
      })
      const last = reports.at(-1)
      expect(last).toMatchObject({ done: true, fraction: 1 })
      expect(last?.outTimeSeconds).toBeGreaterThan(1)
      expect(last?.outTimeSeconds).toBeLessThanOrEqual(2.5)
      expect(reports.filter((report) => report.done)).toHaveLength(1)

      const unknownLength: MuxProgress[] = []
      await muxVideoAudio({
        ffmpeg: appFfmpeg(),
        video: h264,
        audio: aac,
        output: join(dir, 'q.mp4'),
        container: 'mp4',
        onProgress: (report) => unknownLength.push(report)
      })
      expect(unknownLength.at(-1)).toMatchObject({ done: true, fraction: null })
    })

    test('rewraps an HLS transport stream into MP4, and an audio-only track into MKV', async () => {
      const { ts, aac } = await media()
      const dir = await scratch()
      const fromTs = await remux({
        ffmpeg: appFfmpeg(),
        input: ts,
        output: join(dir, 'stream.ts'),
        container: 'auto',
        codecs: ['avc1.64000c', 'mp4a.40.2']
      })
      expect(fromTs).toEqual({ output: join(dir, 'stream.mp4'), container: 'mp4' })
      expect(await inspect(fromTs.output)).toMatchObject({
        format: expect.stringContaining('mp4'),
        video: ['h264'],
        audio: ['aac']
      })

      const audioOnly = join(dir, 'audio.mka')
      await remux({ ffmpeg: appFfmpeg(), input: aac, output: audioOnly, container: 'mkv' })
      expect(await inspect(audioOnly)).toMatchObject({ video: [], audio: ['aac'] })
      expect((await readdir(dir)).sort()).toEqual(['audio.mka', 'stream.mp4'])
    })

    test('a corrupt input fails with FFmpeg’s words in detail only', async () => {
      const { aac } = await media()
      const dir = await scratch()
      const corrupt = join(dir, 'corrupt.mp4')
      await writeFile(corrupt, Buffer.alloc(64 * 1024, 0x5a))
      const error = await failure(
        muxVideoAudio({
          ffmpeg: appFfmpeg(),
          video: corrupt,
          audio: aac,
          output: join(dir, 'out.mp4'),
          container: 'mp4'
        })
      )
      expect(error).toBeInstanceOf(MuxError)
      const { code, message, detail } = error as MuxError
      expect(code).toBe('ffmpeg-failed')
      expect(message).toBe(
        "Mergelane couldn't combine the video and audio: FFmpeg reported an error. The downloaded tracks may be damaged, or use a format that MP4 can't hold."
      )
      expect(detail).toMatch(/^FFmpeg exited with code \d+\.\n/)
      expect(detail).toContain('corrupt.mp4')
      expect(message).not.toContain('corrupt.mp4')
      expect(await readdir(dir)).toEqual(['corrupt.mp4'])
    })

    test('MP4 refuses VP8, and the failure leaves nothing behind', async () => {
      const { vp8, opus } = await media()
      const dir = await scratch()
      const error = await failure(
        muxVideoAudio({
          ffmpeg: appFfmpeg(),
          video: vp8,
          audio: opus,
          output: join(dir, 'out.mp4'),
          container: 'mp4'
        })
      )
      expect(error).toMatchObject({ code: 'ffmpeg-failed' })
      expect((error as MuxError).detail).toContain('vp8')
      expect(await readdir(dir)).toEqual([])
    })

    test('a playlist posing as media is refused, not followed to other local files', async () => {
      const { h264 } = await media()
      const dir = await scratch()
      const playlist = join(dir, 'video.m3u8')
      await writeFile(
        playlist,
        `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:${h264}\n#EXT-X-ENDLIST\n`
      )
      // The app's FFmpeg has no HLS demuxer at all: it can't even read the playlist.
      const error = await failure(
        remux({
          ffmpeg: appFfmpeg(),
          input: playlist,
          output: join(dir, 'out.mp4'),
          container: 'mp4'
        })
      )
      expect(error).toMatchObject({ code: 'ffmpeg-failed' })
      expect((error as MuxError).detail).toContain('Invalid data found when processing input')
      expect(await readdir(dir)).toEqual(['video.m3u8'])
      // A full FFmpeg has one, and the module's demuxer whitelist refuses it there too.
      const full = await failure(
        remux({
          ffmpeg: fixtureFfmpeg(),
          input: playlist,
          output: join(dir, 'out.mp4'),
          container: 'mp4'
        })
      )
      expect(full).toMatchObject({ code: 'ffmpeg-failed' })
      expect((full as MuxError).detail).toContain('whitelist')
      expect(await readdir(dir)).toEqual(['video.m3u8'])
    })

    test('shell metacharacters in paths are just characters', async () => {
      const { h264, aac } = await media()
      const base = await scratch()
      const dir = join(
        base,
        `we ird 'single' "double" $HOME ; touch PWNED & | > \`touch PWNED2\` $(touch PWNED3)`
      )
      await mkdir(dir)
      const video = join(dir, '-y video:1.mp4')
      const audio = join(dir, "a'udio $(id).m4a")
      await writeFile(video, await readFile(h264))
      await writeFile(audio, await readFile(aac))
      const output = join(dir, 'out; rm -rf $HOME.mp4')

      await muxVideoAudio({ ffmpeg: appFfmpeg(), video, audio, output, container: 'mp4' })
      expect(await inspect(output)).toMatchObject({ video: ['h264'], audio: ['aac'] })
      for (const folder of [base, dir, process.cwd()]) {
        expect((await readdir(folder)).filter((name) => name.startsWith('PWNED'))).toEqual([])
      }
      expect((await readdir(dir)).sort()).toEqual(
        ['-y video:1.mp4', "a'udio $(id).m4a", 'out; rm -rf $HOME.mp4'].sort()
      )
    })
  })
})
