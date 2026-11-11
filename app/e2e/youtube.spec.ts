// Layer B (Node only, no Electron): YouTube videos below the download manager (ADR-0026). Which
// links are videos, running yt-dlp (a fake one: see youtubeFake.ts) with its safety flags, reading
// its JSON strictly, the loopback proxy that pins its questions to one network, the session that
// gives each network its own addresses, and StreamTransfer fetching a video with them from a
// local server that refuses addresses meant for another network.

import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkInterfaceInfo, StreamDownloadState } from '../src/shared/types'
import {
  YOUTUBE_CHANNEL,
  YOUTUBE_NOT_A_VIDEO,
  YOUTUBE_PLAYLIST,
  youtubeLink,
  youtubeWatchUrl
} from '../src/shared/youtube'
import { resolveToolPath, TOOL_PATH_ENV } from '../src/main/media/mux'
import {
  EXPIRY_MARGIN_MS,
  MAX_CHUNK_BYTES,
  MAX_REFRESHES,
  SAFETY_ARGS,
  SIGN_IN_MESSAGE,
  YoutubeError,
  YoutubeNetworkError,
  YoutubeSession,
  chooseFormats,
  formatIdOf,
  parseVideo,
  pickAudio,
  readFormat,
  runYtDlp,
  startLoopbackProxy,
  trackUri,
  youtubeChoices,
  youtubePlan,
  youtubeTrackPlaylist,
  youtubeVariants,
  ytDlpArgs,
  ytDlpFailure,
  type YoutubeFormat,
  type YoutubeVideo
} from '../src/main/media/youtube'
import { oneFamily } from '../src/main/network/routes'
import type { NetworkMonitor } from '../src/main/network/interfaces'
import type { Limits } from '../src/main/network/limits'
import { reserveStagingFolder } from '../src/main/download/paths'
import { Meters, type StreamTransferTarget, type TransferHost } from '../src/main/download/transfer'
import { StreamDestination } from '../src/main/download/stream/streamDestination'
import {
  planStreamBlocks,
  planTracks,
  resolveStream,
  streamContainer,
  streamFileName,
  trackShape
} from '../src/main/download/stream/streamPlan'
import { StreamTransfer } from '../src/main/download/stream/streamTransfer'
import {
  describeYoutube,
  extractYoutube,
  forgetDescribed,
  planYoutube,
  youtubeFamily,
  youtubePrograms,
  type YoutubeTools
} from '../src/main/download/stream/youtubeStream'
import { APP_FFMPEG, NEEDS_FFMPEG, NEEDS_FIXTURE_FFMPEG, inspect } from './streamMedia'
import {
  FORMAT_HEADERS,
  FakeYtDlp,
  YT_SECONDS,
  YoutubeServer,
  fakeDir,
  mediaSizes,
  removeYoutubeMedia,
  videoInfo,
  youtubeMedia
} from './youtubeFake'

/** Video ids the fake knows: 11 characters, as YouTube's. */
const ID = {
  ok: 'okokokokok1',
  signIn: 'signinsign1',
  hang: 'hanghanghan',
  loud: 'loudloudlou',
  garbage: 'garbagegarb',
  slow: 'slowslowslo'
}

const LAN = process.env.MERGELANE_E2E_LAN || null
/** The fake's chunk size in the transfer tests: the media is a few tens of kilobytes. */
const CHUNK = 4096

let scratchRoot: Promise<string> | undefined
async function scratch(): Promise<string> {
  scratchRoot ??= mkdtemp(join(tmpdir(), 'mergelane-yt-'))
  return mkdtemp(join(await scratchRoot, 'case-'))
}

test.afterAll(async () => {
  const root = scratchRoot
  scratchRoot = undefined
  if (root) await rm(await root, { recursive: true, force: true })
  await removeYoutubeMedia()
})

/** A format as readFormat gives it, with overrides. */
function format(overrides: Partial<YoutubeFormat> = {}): YoutubeFormat {
  return {
    id: '137',
    url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=2000000000',
    headers: {},
    size: 1000,
    chunkSize: MAX_CHUNK_BYTES,
    videoCodec: 'avc1.640028',
    height: 1080,
    width: 1920,
    fps: 30,
    bitrate: 4000,
    ...overrides
  }
}

/** yt-dlp's JSON for one format, valid unless overridden. */
function rawFormat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_id: '137',
    url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=2000000000&ip=1.2.3.4',
    protocol: 'https',
    ext: 'mp4',
    vcodec: 'avc1.640028',
    acodec: 'none',
    filesize: 123456,
    height: 1080,
    width: 1920,
    fps: 30,
    tbr: 4000,
    has_drm: false,
    http_headers: { 'User-Agent': 'UA', Accept: '*/*' },
    downloader_options: { http_chunk_size: 10485760 },
    ...overrides
  }
}

function rawVideo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _type: 'video',
    id: ID.ok,
    title: 'A video',
    extractor_key: 'Youtube',
    duration: 60,
    live_status: 'not_live',
    formats: [rawFormat()],
    ...overrides
  })
}

const errorOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected it to fail')
}

const syncErrorOf = (run: () => unknown): Error => {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected it to fail')
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---- Links ------------------------------------------------------------------------------------

test.describe('YouTube links @smoke', () => {
  test('a video’s link, in every form, becomes its watch page and nothing else', () => {
    const id = 'jNQXAC9IVRw'
    const watch = youtubeWatchUrl(id)
    expect(watch).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw')
    for (const link of [
      `https://www.youtube.com/watch?v=${id}&list=PL123&index=2&t=10s`,
      `http://youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}&feature=share`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=tracking`,
      `https://www.youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}?feature=share`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}?start=4`,
      `  https://WWW.YouTube.com/watch?v=${id}  `
    ]) {
      expect(youtubeLink(link), link).toEqual({ kind: 'video', id, url: watch })
    }
  })

  test('playlists, channels and other YouTube pages are refused in plain words', () => {
    const refused = (reason: string): unknown => ({ kind: 'refused', reason })
    expect(youtubeLink('https://www.youtube.com/playlist?list=PL123')).toEqual(
      refused(YOUTUBE_PLAYLIST)
    )
    for (const channel of [
      'https://www.youtube.com/@blender',
      'https://www.youtube.com/@blender/videos',
      'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg',
      'https://www.youtube.com/c/Blender',
      'https://www.youtube.com/user/blender'
    ]) {
      expect(youtubeLink(channel), channel).toEqual(refused(YOUTUBE_CHANNEL))
    }
    for (const page of [
      'https://www.youtube.com/',
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch/extra?v=jNQXAC9IVRw',
      'https://www.youtube.com/shorts/',
      'https://youtu.be/',
      'https://youtu.be/jNQXAC9IVRw/more',
      'https://www.youtube-nocookie.com/watch?v=jNQXAC9IVRw',
      'https://www.youtube.com/watch?v=jNQXAC9IV$w'
    ]) {
      expect(youtubeLink(page), page).toEqual(refused(YOUTUBE_NOT_A_VIDEO))
    }
  })

  test('other links are not YouTube’s', () => {
    for (const link of [
      'not a link',
      'magnet:?xt=urn:btih:abc',
      'ftp://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://evil-youtube.com/watch?v=jNQXAC9IVRw',
      'https://www.youtube.com.evil.test/watch?v=jNQXAC9IVRw',
      'https://rr1---sn-test.googlevideo.com/videoplayback?id=1',
      'https://example.com/youtube.com/watch?v=jNQXAC9IVRw'
    ]) {
      expect(youtubeLink(link), link).toBeNull()
    }
  })
})

// ---- yt-dlp's errors and JSON -------------------------------------------------------------------

test.describe('yt-dlp’s answers @smoke', () => {
  test('its errors become plain words; its own text is kept for the log', () => {
    const cases: [string, string][] = [
      [
        'ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate',
        'sign-in'
      ],
      ['ERROR: [youtube] x: Private video. Sign in if you’ve been granted access', 'sign-in'],
      ['ERROR: [youtube] x: Join this channel to get access to members-only content', 'sign-in'],
      ['ERROR: [youtube] x: This video requires payment to watch. Use --cookies', 'sign-in'],
      ['ERROR: [youtube] x: Sign in to confirm you’re not a bot', 'bot-check'],
      ['ERROR: [youtube] x: This video is DRM protected', 'drm'],
      ['ERROR: [youtube] x: The uploader has not made this video available in your country', 'geo'],
      ['ERROR: [youtube] x: Premieres in 3 hours', 'premiere'],
      ['ERROR: [youtube] x: This live event will begin in a few moments.', 'premiere'],
      [
        'ERROR: [youtube] x: Unable to download API page: HTTP Error 429: Too Many Requests',
        'rate-limited'
      ],
      [
        'ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader',
        'unavailable'
      ],
      ['ERROR: [youtube] x: Requested format is not available', 'no-formats'],
      ['ERROR: [youtube] x: Unable to download webpage: <urlopen error timed out>', 'network'],
      ['ERROR: Unable to download webpage: Tunnel connection failed: 502 Bad Gateway', 'network']
    ]
    for (const [stderr, code] of cases) {
      const error = ytDlpFailure(`WARNING: something\n${stderr}\n`)
      expect(error.code, stderr).toBe(code)
      expect(error.detail).toContain(stderr)
    }
    expect(ytDlpFailure('ERROR: [youtube] x: Sign in to confirm your age').message).toBe(
      SIGN_IN_MESSAGE
    )
    expect(SIGN_IN_MESSAGE).toBe(
      'This video needs a sign-in. Mergelane only downloads videos anyone can watch without signing in.'
    )
    // Unknown: yt-dlp's first error, shortened, after a plain lead-in.
    const unknown = ytDlpFailure(`ERROR: [youtube] abc: Something odd ${'x'.repeat(300)}`)
    expect(unknown.code).toBe('failed')
    expect(unknown.message.startsWith('yt-dlp couldn’t read this video: Something odd x')).toBe(
      true
    )
    expect(unknown.message.length).toBeLessThan(260)
    expect(ytDlpFailure('ERROR: weird failure').message).toBe(
      'yt-dlp couldn’t read this video: weird failure'
    )
    // Nothing that looks like an error at all.
    const silent = ytDlpFailure('Traceback (most recent call last):\n  boom')
    expect([silent.code, silent.message]).toEqual(['failed', 'yt-dlp couldn’t read this video.'])
  })

  test('a format is kept only if it is a plain file, without DRM, with a size, in codecs FFmpeg copies', () => {
    const kept = readFormat(
      rawFormat({
        available_at: 1_900_000_000,
        language_preference: 10,
        http_headers: {
          'User-Agent': 'UA',
          Cookie: 'never',
          Range: 'bytes=0-',
          Authorization: 'Bearer x',
          'Accept-Encoding': 'gzip'
        }
      })
    )
    expect(kept).toEqual({
      id: '137',
      url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=2000000000&ip=1.2.3.4',
      headers: { 'User-Agent': 'UA' },
      size: 123456,
      chunkSize: MAX_CHUNK_BYTES,
      videoCodec: 'avc1.640028',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 4000,
      languagePreference: 10,
      availableAt: 1_900_000_000_000,
      expiresAt: 2_000_000_000_000
    })
    // A smaller chunk is honoured; a bigger one isn't.
    expect(
      readFormat(rawFormat({ downloader_options: { http_chunk_size: 4096 } }))!.chunkSize
    ).toBe(4096)
    expect(
      readFormat(rawFormat({ downloader_options: { http_chunk_size: 50 << 20 } }))!.chunkSize
    ).toBe(MAX_CHUNK_BYTES)
    expect(readFormat(rawFormat({ downloader_options: undefined }))!.chunkSize).toBe(
      MAX_CHUNK_BYTES
    )
    // Sound only.
    expect(
      readFormat(
        rawFormat({ vcodec: 'none', acodec: 'opus', ext: 'webm', http_headers: undefined })
      )
    ).toMatchObject({ audioCodec: 'opus', headers: {} })
    // Loopback http (the tests' server) is fine.
    expect(readFormat(rawFormat({ url: 'http://127.0.0.1:1/x' }))).not.toBeNull()

    const dropped: Record<string, unknown>[] = [
      { has_drm: true },
      { has_drm: 'maybe' },
      { protocol: 'm3u8_native' },
      { protocol: 'http_dash_segments' },
      { protocol: 'mhtml', ext: 'mhtml', vcodec: 'none' },
      { filesize: null },
      { filesize: 0 },
      { filesize: 1.5 },
      { format_id: '../../x' },
      { format_id: 7 },
      { url: 'http://example.com/plain-http' },
      { url: 'file:///etc/passwd' },
      { url: 'not a url' },
      { url: 42 },
      { ext: '3gp' },
      { vcodec: 'mp4v.20.3' },
      { vcodec: 'none', acodec: 'vorbis' },
      { vcodec: 'none', acodec: 'none' },
      { vcodec: 12 },
      { format_note: '1080p, DAMAGED' },
      { format_note: '1080p, MISSING POT' },
      { format_note: 7 },
      { http_headers: 'User-Agent: x' },
      { http_headers: { 'Bad Header': 'x' } },
      { http_headers: { 'X-Ok': 'line\r\nInjected: yes' } },
      { http_headers: { 'X-Ok': 5 } }
    ]
    for (const overrides of dropped) {
      expect(readFormat(rawFormat(overrides)), JSON.stringify(overrides)).toBeNull()
    }
    expect(readFormat(null)).toBeNull()
    expect(readFormat([])).toBeNull()
  })

  test('only one video that has been broadcast is read; anything else says why', () => {
    const video = parseVideo(rawVideo({ title: '  A video  ' }))
    expect(video).toMatchObject({ id: ID.ok, title: 'A video', durationSeconds: 60 })
    expect(video.formats.map((entry) => entry.id)).toEqual(['137'])
    expect(parseVideo(rawVideo({ title: '   ', duration: null })).title).toBe(ID.ok)
    expect(parseVideo(rawVideo({ duration: null })).durationSeconds).toBeUndefined()
    expect(parseVideo(rawVideo({ _type: undefined })).id).toBe(ID.ok)

    const codeOf = (json: string): string =>
      (syncErrorOf(() => parseVideo(json)) as YoutubeError).code
    expect(codeOf('{ not json')).toBe('bad-answer')
    expect(codeOf('[]')).toBe('bad-answer')
    expect(codeOf(rawVideo({ _type: 'playlist' }))).toBe('bad-answer')
    expect(syncErrorOf(() => parseVideo(rawVideo({ _type: 'playlist' }))).message).toBe(
      'This isn’t one YouTube video. Mergelane downloads one video at a time.'
    )
    expect(codeOf(rawVideo({ id: 5 }))).toBe('bad-answer')
    expect(codeOf(rawVideo({ extractor_key: 'Generic' }))).toBe('bad-answer')
    expect(codeOf(rawVideo({ live_status: 'is_live' }))).toBe('live')
    expect(codeOf(rawVideo({ is_live: true }))).toBe('live')
    expect(codeOf(rawVideo({ live_status: 'is_upcoming' }))).toBe('premiere')
    expect(syncErrorOf(() => parseVideo(rawVideo({ live_status: 'post_live' }))).message).toBe(
      'This live stream has just ended and YouTube is still preparing it. Try again later.'
    )
    expect(codeOf(rawVideo({ formats: 'x' }))).toBe('no-formats')
    expect(codeOf(rawVideo({ formats: [rawFormat({ protocol: 'm3u8_native' })] }))).toBe(
      'no-formats'
    )
    // Everything left out for DRM: said so.
    expect(
      codeOf(rawVideo({ formats: [rawFormat({ has_drm: true }), rawFormat({ has_drm: 'maybe' })] }))
    ).toBe('drm')
    expect(new YoutubeError('drm').message).toBe(
      'This video is protected with DRM, which Mergelane doesn’t remove.'
    )
    expect(new YoutubeError('live').message).toContain('live stream that is still being broadcast')
  })

  test('qualities: one per height, best first, each with its sound and size', () => {
    const video: YoutubeVideo = {
      id: ID.ok,
      title: 'x',
      formats: [
        format({ id: '137', height: 1080, videoCodec: 'avc1.640028', bitrate: 4000, size: 4000 }),
        format({ id: '248', height: 1080, videoCodec: 'vp9', bitrate: 3000, size: 3000 }),
        format({ id: '399', height: 1080, videoCodec: 'av01.0.08M.08', bitrate: 2500, size: 2500 }),
        format({ id: '137-sr', height: 1080, videoCodec: 'avc1.640028', bitrate: 9000 }),
        format({ id: '313', height: 2160, videoCodec: 'vp9', bitrate: 15000, size: 15000 }),
        format({ id: '18', height: 360, audioCodec: 'mp4a.40.2', bitrate: 500, size: 500 }),
        format({ id: '134', height: 360, videoCodec: 'avc1.4d401e', bitrate: 400, size: 400 }),
        format({
          id: '140',
          videoCodec: undefined,
          audioCodec: 'mp4a.40.2',
          bitrate: 128,
          size: 128,
          height: undefined,
          width: undefined,
          fps: undefined
        }),
        format({
          id: '140-drc',
          videoCodec: undefined,
          audioCodec: 'mp4a.40.2',
          bitrate: 130,
          size: 130,
          height: undefined
        }),
        format({
          id: '251',
          videoCodec: undefined,
          audioCodec: 'opus',
          bitrate: 140,
          size: 140,
          height: undefined
        })
      ]
    }
    const choices = youtubeChoices(video)
    // 2160p has only VP9, so its sound is Opus; H.264 is paired with AAC; the 360p muxed
    // format loses to separate video; the AI-upscaled copy and the DRC sound are passed over.
    expect(choices.map((choice) => [choice.main.id, choice.audio?.id])).toEqual([
      ['313', '251'],
      ['137', '140'],
      ['134', '140']
    ])
    const variants = youtubeVariants(video)
    expect(variants[0]).toEqual({
      id: '313+251',
      bandwidth: 15_140_000,
      width: 1920,
      height: 2160,
      frameRate: 30,
      codecs: ['vp9', 'opus'],
      bytes: 15140
    })
    expect(variants.map((variant) => variant.id)).toEqual(['313+251', '137+140', '134+140'])

    expect(chooseFormats(video, undefined).main.id).toBe('313')
    expect(chooseFormats(video, '248+251')).toMatchObject({
      main: { id: '248' },
      audio: { id: '251' }
    })
    expect(chooseFormats(video, '18')).toEqual({ main: video.formats[5] })
    for (const gone of ['nope', '137+nope', '137+248', '137+140+251', 'nope+140']) {
      expect((syncErrorOf(() => chooseFormats(video, gone)) as YoutubeError).code, gone).toBe(
        'format-gone'
      )
    }
    expect(
      (syncErrorOf(() => chooseFormats({ ...video, formats: [] }, undefined)) as YoutubeError).code
    ).toBe('no-formats')

    // A video with its sound in it only, and one that is only sound.
    const muxed = { ...video, formats: [video.formats[5]] }
    expect(youtubeChoices(muxed)).toEqual([{ main: video.formats[5] }])
    const sound = { ...video, formats: video.formats.slice(7) }
    expect(youtubeChoices(sound).map((choice) => choice.main.id)).toEqual(['140'])
    expect(youtubeVariants(sound)[0]).toMatchObject({
      id: '140',
      codecs: ['mp4a.40.2'],
      bytes: 128
    })
  })

  test('sound: the original language first, then AAC beside H.264 and Opus beside the rest', () => {
    const aac = format({ id: '140', videoCodec: undefined, audioCodec: 'mp4a.40.2', bitrate: 128 })
    const opus = format({ id: '251', videoCodec: undefined, audioCodec: 'opus', bitrate: 160 })
    const dubbed = format({
      id: '251-1',
      videoCodec: undefined,
      audioCodec: 'opus',
      bitrate: 160,
      languagePreference: -1
    })
    const original = { ...aac, id: '140-0', languagePreference: 10 }
    const h264 = format({ videoCodec: 'avc1.640028' })
    const vp9 = format({ videoCodec: 'vp9' })
    expect(pickAudio(h264, [opus, aac])?.id).toBe('140')
    expect(pickAudio(vp9, [aac, opus])?.id).toBe('251')
    expect(pickAudio(vp9, [dubbed, original])?.id).toBe('140-0')
    expect(pickAudio(undefined, [opus, aac])?.id).toBe('140')
    expect(pickAudio(h264, [h264])).toBeUndefined()
    // All else equal, the first stays.
    expect(pickAudio(h264, [aac, { ...aac, id: '140b' }])?.id).toBe('140')
  })
})

// ---- Running yt-dlp ---------------------------------------------------------------------------

test.describe('running yt-dlp @smoke', () => {
  let fake: FakeYtDlp
  let server: YoutubeServer
  test.beforeAll(async () => {
    fake = new FakeYtDlp(await fakeDir())
    server = await new YoutubeServer(await youtubeMedia()).start()
    fake.serve(server)
    fake.set(ID.ok, { info: await videoInfo(ID.ok) })
    fake.set(ID.signIn, { stderr: 'ERROR: [youtube] signinsign1: Sign in to confirm your age' })
    fake.set(ID.hang, { hang: true })
    fake.set(ID.loud, { bytes: 4096 })
    fake.set(ID.garbage, { raw: '<html>not json</html>' })
  })
  test.afterAll(async () => {
    await server?.stop()
    if (fake) await rm(fake.dir, { recursive: true, force: true })
  })

  test('its arguments: the safety flags, our Deno, the proxy or none, then -- and the URL', () => {
    const args = ytDlpArgs({ deno: '/app/deno', url: youtubeWatchUrl(ID.ok) })
    expect(args).toEqual([
      ...SAFETY_ARGS,
      '--js-runtimes',
      'deno:/app/deno',
      '--proxy',
      '',
      '--socket-timeout',
      '20',
      '--dump-single-json',
      '--',
      'https://www.youtube.com/watch?v=okokokokok1'
    ])
    for (const flag of [
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-cache-dir',
      '--no-update',
      '--no-remote-components',
      '--no-js-runtimes',
      '--no-playlist'
    ]) {
      expect(SAFETY_ARGS).toContain(flag)
    }
    // --no-js-runtimes clears every runtime before ours is named.
    expect(args.indexOf('--no-js-runtimes')).toBeLessThan(args.indexOf('--js-runtimes'))
    expect(args[args.indexOf('--use-extractors') + 1]).toBe('youtube')
    for (const barred of [
      '--cookies',
      '--cookies-from-browser',
      '--extractor-args',
      '-U',
      '--update'
    ]) {
      expect(args, barred).not.toContain(barred)
    }
    expect(args.some((arg) => /po_token|pot/i.test(arg))).toBe(false)
    expect(ytDlpArgs({ deno: '/d', url: 'u', proxy: 'http://p' })).toContain('http://p')
  })

  test('runs as a program, never a shell, with a minimal environment of its own', async () => {
    fake.clearCalls()
    const marker = join(fake.dir, 'shell-ran')
    const url = `${youtubeWatchUrl(ID.ok)}&x=$(touch ${marker});touch ${marker}`
    const json = await runYtDlp({ ytDlp: fake.ytDlp, deno: fake.deno, url })
    expect(JSON.parse(json).id).toBe(ID.ok)
    const [call] = fake.calls(ID.ok)
    // The URL arrived as one argument, untouched, after --.
    expect(call.argv.at(-1)).toBe(url)
    expect(call.argv.at(-2)).toBe('--')
    expect(existsSync(marker)).toBe(false)
    // Nothing of ours or the user's: only these.
    // macOS adds __CF_USER_TEXT_ENCODING to every process; Node adds NODE_V8_COVERAGE to its
    // children's when it measures coverage, as the coverage runs of this suite do.
    const env = Object.keys(call.env).filter(
      (name) => name !== '__CF_USER_TEXT_ENCODING' && name !== 'NODE_V8_COVERAGE'
    )
    expect(env.sort()).toEqual(
      [
        'DENO_DIR',
        'DENO_NO_PROMPT',
        'DENO_NO_UPDATE_CHECK',
        'HOME',
        'LANG',
        'LC_ALL',
        'NO_COLOR',
        'PATH',
        'TMPDIR',
        'YTDLP_NO_PLUGINS'
      ].sort()
    )
    expect(call.env.PATH).toBe('/usr/bin:/bin')
    expect(call.env.YTDLP_NO_PLUGINS).toBe('1')
    expect(call.env.DENO_NO_UPDATE_CHECK).toBe('1')
    // HOME, TMPDIR and Deno's caches are in its own folder, gone once it is done.
    // (macOS's temporary folder is reached through /var, a link to /private/var.)
    const real = (path: string): string => path.replace(/^\/private\//, '/')
    for (const name of ['HOME', 'TMPDIR', 'DENO_DIR']) {
      expect(real(call.env[name]).startsWith(`${real(call.cwd)}/`), name).toBe(true)
    }
    expect(existsSync(call.cwd)).toBe(false)
  })

  test('its failures say what is wrong in plain words', async () => {
    const run = (
      url: string,
      more: Partial<Parameters<typeof runYtDlp>[0]> = {}
    ): Promise<string> => runYtDlp({ ytDlp: fake.ytDlp, deno: fake.deno, url, ...more })
    const signIn = (await errorOf(run(youtubeWatchUrl(ID.signIn)))) as YoutubeError
    expect([signIn.code, signIn.message]).toEqual(['sign-in', SIGN_IN_MESSAGE])
    expect(signIn.detail).toContain('Sign in to confirm your age')

    const loud = (await errorOf(
      run(youtubeWatchUrl(ID.loud), { maxOutputBytes: 1000 })
    )) as YoutubeError
    expect([loud.code, loud.message]).toEqual([
      'bad-answer',
      'yt-dlp’s answer about this video was larger than Mergelane will read.'
    ])
    expect(await run(youtubeWatchUrl(ID.garbage))).toBe('<html>not json</html>')

    const missing = (await errorOf(
      runYtDlp({ ytDlp: join(fake.dir, 'nope'), deno: fake.deno, url: 'u' })
    )) as YoutubeError
    expect(missing.message).toBe('Mergelane couldn’t start yt-dlp (ENOENT).')
    const relative = await errorOf(runYtDlp({ ytDlp: 'yt-dlp', deno: fake.deno, url: 'u' }))
    expect(relative).toBeInstanceOf(TypeError)
    expect((await errorOf(runYtDlp({ ytDlp: fake.ytDlp, deno: 'deno', url: 'u' }))).message).toBe(
      'deno must be an absolute path, got deno'
    )
    const stopped = new AbortController()
    stopped.abort(new Error('stopped before'))
    expect((await errorOf(run('u', { signal: stopped.signal }))).message).toBe('stopped before')
  })

  test('one that takes too long is killed, with everything it started', async () => {
    const timeout = (await errorOf(
      runYtDlp({
        ytDlp: fake.ytDlp,
        deno: fake.deno,
        url: youtubeWatchUrl(ID.hang),
        timeoutMs: 1500
      })
    )) as YoutubeError
    expect([timeout.code, timeout.message]).toEqual([
      'timeout',
      'YouTube took too long to answer. Try again.'
    ])
    const child = fake.childOf(ID.hang)
    await waitFor(() => !alive(child), 5000)

    // Stopping the download stops it the same way.
    const controller = new AbortController()
    const running = runYtDlp({
      ytDlp: fake.ytDlp,
      deno: fake.deno,
      url: youtubeWatchUrl(ID.hang),
      signal: controller.signal
    })
    await waitFor(() => fake.calls(ID.hang).length === 2)
    controller.abort(new Error('paused'))
    expect((await errorOf(running)).message).toBe('paused')
  })
})

// ---- The loopback proxy -----------------------------------------------------------------------

/** Sends `head` to the proxy and resolves with its first answer line, and the socket. */
function rawRequest(url: string, head: string): Promise<{ status: string; socket: Socket }> {
  const { port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1')
    let data = ''
    socket.on('error', reject)
    socket.on('data', function onData(chunk) {
      data += chunk
      if (!data.includes('\r\n\r\n')) return
      socket.off('data', onData)
      resolve({ status: data.split('\r\n')[0], socket })
    })
    socket.write(head)
  })
}

const authOf = (url: string): string => {
  const parsed = new URL(url)
  return `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}`
}

test.describe('the loopback proxy @smoke', () => {
  let echo: Server
  let echoPort: number
  test.beforeAll(async () => {
    echo = createServer((req, res) => res.end(`hello from ${req.url}`))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    echoPort = (echo.address() as AddressInfo).port
  })
  test.afterAll(async () => {
    echo.closeAllConnections()
    await new Promise((resolve) => echo.close(resolve))
  })

  test('tunnels only for its own credentials, only to host:port, through the network given', async () => {
    const dialled: string[] = []
    const proxy = await startLoopbackProxy(async (host, port) => {
      dialled.push(`${host}:${port}`)
      return connect(port, host)
    })
    try {
      expect(proxy.url).toMatch(/^http:\/\/mergelane:[0-9a-f]{32}@127\.0\.0\.1:\d+$/)
      const target = `127.0.0.1:${echoPort}`
      const ok = await rawRequest(
        proxy.url,
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`
      )
      expect(ok.status).toBe('HTTP/1.1 200 Connection Established')
      const body = await new Promise<string>((resolve) => {
        let text = ''
        ok.socket.on('data', (chunk) => (text += chunk))
        ok.socket.on('end', () => resolve(text))
        ok.socket.write(`GET /through HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      })
      expect(body).toContain('hello from /through')
      expect(dialled).toEqual([target])
      expect(proxy.tunnels).toEqual([target])

      for (const [head, status] of [
        [`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, '407'],
        [
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic bWVyZ2VsYW5lOndyb25n\r\n\r\n`,
          '407'
        ],
        [
          `CONNECT no-port HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`,
          '400'
        ],
        [
          `CONNECT a:99999 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`,
          '400'
        ],
        [
          `CONNECT u@a:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`,
          '400'
        ],
        [`GET http://${target}/ HTTP/1.1\r\nHost: ${target}\r\n\r\n`, '405']
      ] as const) {
        const answer = await rawRequest(proxy.url, head)
        expect(answer.status, head).toContain(` ${status} `)
        answer.socket.destroy()
      }
      expect(dialled).toEqual([target])
    } finally {
      await proxy.close()
    }
  })

  test('a connection the network can’t make is a 502; too many at once a 503; close ends them all', async () => {
    let held = 0
    const proxy = await startLoopbackProxy(async (host, port, signal) => {
      if (host === 'fail.test') throw new Error('no route')
      if (host === 'hold.test') {
        held++
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason))
        )
      }
      return connect(port, host)
    })
    const connectTo = (target: string): Promise<{ status: string; socket: Socket }> =>
      rawRequest(
        proxy.url,
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`
      )
    const failed = await connectTo('fail.test:443')
    expect(failed.status).toBe('HTTP/1.1 502 Bad Gateway')
    failed.socket.destroy()

    // 32 tunnels waiting on the network: the next is turned away.
    const sockets: Socket[] = []
    for (let i = 0; i < 32; i++) {
      const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1')
      socket.on('error', () => {})
      socket.write(
        `CONNECT hold.test:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${authOf(proxy.url)}\r\n\r\n`
      )
      sockets.push(socket)
    }
    await waitFor(() => held === 32)
    const busy = await connectTo(`127.0.0.1:${echoPort}`)
    expect(busy.status).toBe('HTTP/1.1 503 Service Unavailable')
    busy.socket.destroy()

    const open = connect(Number(new URL(proxy.url).port), '127.0.0.1')
    const closed = new Promise((resolve) => open.on('close', resolve))
    open.on('error', () => {})
    await proxy.close()
    await closed
    for (const socket of sockets) socket.destroy()
  })

  test('a connection through one network keeps to one address family', async () => {
    const resolve = oneFamily(() => 4)
    const addresses = await resolve('localhost')
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.every((address) => address.family === 4)).toBe(true)
    expect(youtubeFamily(undefined)).toBe(4)
    const v6only: NetworkInterfaceInfo = {
      id: 'x',
      device: 'x',
      displayName: 'x',
      kind: 'ethernet',
      addresses: [{ address: '::1', family: 6 }]
    }
    expect(youtubeFamily(v6only)).toBe(6)
    expect(
      youtubeFamily({
        ...v6only,
        addresses: [...v6only.addresses, { address: '10.0.0.2', family: 4 }]
      })
    ).toBe(4)
  })
})

// ---- Sessions ---------------------------------------------------------------------------------

/** A video as one network was told of it: its formats' addresses carry the network's id. */
function told(
  networkId: string,
  overrides: { expiresAt?: number; size?: number; availableAt?: number } = {}
): YoutubeVideo {
  const at = (id: string, more: Partial<YoutubeFormat> = {}): YoutubeFormat =>
    format({
      id,
      url: `https://media.test/${networkId}/${id}`,
      headers: { 'User-Agent': `client-${networkId}` },
      size: overrides.size ?? 2500,
      chunkSize: 1000,
      ...(overrides.expiresAt !== undefined && { expiresAt: overrides.expiresAt }),
      ...(overrides.availableAt !== undefined && { availableAt: overrides.availableAt }),
      ...more
    })
  return {
    id: ID.ok,
    title: 'A video',
    durationSeconds: 30,
    formats: [
      at('137', { height: 1080 }),
      at('140', { videoCodec: undefined, audioCodec: 'mp4a.40.2', height: undefined, bitrate: 128 })
    ]
  }
}

interface Script {
  /** What each asking over a network gives, in turn; the last repeats. */
  answers: Record<string, (YoutubeVideo | Error)[]>
  asked: string[]
}

function sessionWith(
  script: Script,
  options: { variantId?: string; now?: () => number } = {}
): { session: YoutubeSession; controller: AbortController } {
  const controller = new AbortController()
  const session = new YoutubeSession({
    variantId: options.variantId ?? '137+140',
    signal: controller.signal,
    ...(options.now && { now: options.now }),
    extract: async (networkId) => {
      script.asked.push(networkId)
      const answers = script.answers[networkId] ?? [new YoutubeError('network')]
      const count = script.asked.filter((id) => id === networkId).length
      const answer = answers[Math.min(count, answers.length) - 1]
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (answer instanceof Error) throw answer
      return answer
    }
  })
  return { session, controller }
}

const uri137 = trackUri(ID.ok, '137')
const uri140 = trackUri(ID.ok, '140')

test.describe('YouTube sessions @smoke', () => {
  test('tracks are listed under addresses of our own, cut into chunk-sized ranges', () => {
    expect(uri137).toBe('mergelane-youtube://okokokokok1/137')
    expect(formatIdOf(uri137)).toBe('137')
    for (const other of [
      'https://x/137',
      'mergelane-youtube://x',
      'mergelane-youtube://x/',
      'mergelane-youtube://a/b/c'
    ]) {
      expect(formatIdOf(other), other).toBeNull()
    }
    const playlist = youtubeTrackPlaylist(
      ID.ok,
      format({ id: '137', size: 2500, chunkSize: 1000 }),
      30
    )
    expect(playlist).toMatchObject({
      url: uri137,
      endList: true,
      playlistType: 'VOD',
      duration: 30,
      targetDuration: 10
    })
    expect(playlist.segments.map((segment) => [segment.uri, segment.byteRange])).toEqual([
      [uri137, { offset: 0, length: 1000 }],
      [uri137, { offset: 1000, length: 1000 }],
      [uri137, { offset: 2000, length: 500 }]
    ])
    expect(playlist.segments.every((segment) => segment.duration === 10)).toBe(true)
    const unknownLength = youtubeTrackPlaylist(ID.ok, format({ size: 10, chunkSize: 10 }))
    expect([unknownLength.duration, unknownLength.segments[0].duration]).toEqual([0, 0])

    const plan = youtubePlan(told('a'), undefined)
    expect(plan.variantId).toBe('137+140')
    expect(plan.codecs).toEqual(['avc1.640028', 'mp4a.40.2'])
    expect(plan.quality).toBe('1080p')
    expect(plan.tracks.map((track) => [track.role, track.playlist.segments.length])).toEqual([
      ['video', 3],
      ['audio', 3]
    ])
    const sound = youtubePlan({ ...told('a'), formats: [told('a').formats[1]] }, '140')
    expect([sound.variantId, sound.tracks.length, sound.quality]).toEqual(['140', 1, '128 kbps'])
  })

  test('every network asks at once; each fetches with its own addresses; one that fails sits out', async () => {
    const script: Script = {
      answers: { a: [told('a')], b: [told('b')], c: [new YoutubeError('bot-check')] },
      asked: []
    }
    const { session } = sessionWith(script)
    const plan = await session.start(['a', 'b', 'c'])
    expect(plan.variantId).toBe('137+140')
    expect(session.start(['x'])).toBe(session.start(['y']))
    const signal = new AbortController().signal
    expect(await session.target('a', uri137, signal)).toEqual({
      url: 'https://media.test/a/137',
      headers: { 'User-Agent': 'client-a' },
      generation: 1
    })
    expect((await session.target('b', uri140, signal)).url).toBe('https://media.test/b/140')
    const out = await errorOf(session.target('c', uri137, signal))
    expect(out).toBeInstanceOf(YoutubeNetworkError)
    expect(out.message).toBe(new YoutubeError('bot-check').message)
    expect((out as YoutubeNetworkError).networkId).toBe('c')
    expect([...session.failures.keys()]).toEqual(['c'])
    expect(script.asked.sort()).toEqual(['a', 'b', 'c'])
    // A network switched on later asks then.
    script.answers.d = [told('d')]
    expect((await session.target('d', uri137, signal)).url).toBe('https://media.test/d/137')
    // Not a track of this download, or not ours at all.
    expect(await errorOf(session.target('a', trackUri(ID.ok, '999'), signal))).toBeInstanceOf(
      TypeError
    )
    expect(await errorOf(session.target('a', 'https://x/y', signal))).toBeInstanceOf(TypeError)
  })

  test('the plan fails only when every network does, with the first one’s reason', async () => {
    const { session } = sessionWith({
      answers: { a: [new YoutubeError('sign-in')], b: [new Error('spawn failed')] },
      asked: []
    })
    const failed = (await errorOf(session.start(['a', 'b']))) as YoutubeError
    expect([failed.code, failed.message]).toEqual(['sign-in', SIGN_IN_MESSAGE])
    const odd = sessionWith({ answers: { a: [new Error('spawn failed')] }, asked: [] }).session
    expect((await errorOf(odd.start(['a']))).message).toBe(
      'yt-dlp couldn’t read this video: spawn failed'
    )
    expect((await errorOf(sessionWith({ answers: {}, asked: [] }).session.start([]))).message).toBe(
      'No network is on for this download.'
    )
    expect(
      (
        await errorOf(
          sessionWith({ answers: {}, asked: [] }).session.target(
            'a',
            uri137,
            new AbortController().signal
          )
        )
      ).message
    ).toBe('The session hasn’t started')
    // A quality that isn't offered any more.
    const gone = sessionWith(
      { answers: { a: [told('a')] }, asked: [] },
      { variantId: '22+140' }
    ).session
    expect(((await errorOf(gone.start(['a']))) as YoutubeError).code).toBe('format-gone')
  })

  test('a network given another version of the video sits out', async () => {
    const { session } = sessionWith({
      answers: { a: [told('a')], b: [told('b', { size: 9999 })] },
      asked: []
    })
    await session.start(['a', 'b'])
    const out = await errorOf(session.target('b', uri137, new AbortController().signal))
    expect(out.message).toBe(
      'YouTube gave this network a different version of the video, so it sits this one out.'
    )
  })

  test('refused, a network asks again; refused again and again, it sits out until it comes back', async () => {
    const script: Script = { answers: { a: [told('a')] }, asked: [] }
    const { session } = sessionWith(script)
    await session.start(['a'])
    const signal = new AbortController().signal
    let target = await session.target('a', uri137, signal)
    // An older asking's refusal changes nothing.
    session.refused('a', target.generation - 1)
    expect((await session.target('a', uri137, signal)).generation).toBe(target.generation)
    for (let refresh = 1; refresh <= MAX_REFRESHES; refresh++) {
      session.refused('a', target.generation)
      target = await session.target('a', uri137, signal)
      expect(target.generation).toBe(1 + refresh)
    }
    expect(script.asked).toEqual(['a', 'a', 'a'])
    session.refused('a', target.generation)
    const out = await errorOf(session.target('a', uri137, signal))
    expect(out.message).toBe(
      'YouTube kept refusing this network’s requests (HTTP 403), so it sits this download out.'
    )
    // Back: it asks afresh.
    session.retry('a')
    session.retry('never-out')
    expect((await session.target('a', uri137, signal)).generation).toBe(MAX_REFRESHES + 2)

    // Getting through starts the count over.
    session.refused('a', MAX_REFRESHES + 2)
    target = await session.target('a', uri137, signal)
    session.delivered('a')
    for (let refresh = 1; refresh <= MAX_REFRESHES; refresh++) {
      session.refused('a', target.generation)
      target = await session.target('a', uri137, signal)
    }
    expect(target.url).toBe('https://media.test/a/137')
  })

  test('addresses about to expire are asked for again before they are used, once', async () => {
    let now = 1_000_000
    const soon = now + EXPIRY_MARGIN_MS - 1
    const script: Script = {
      answers: { a: [told('a', { expiresAt: soon }), told('a', { expiresAt: soon })] },
      asked: []
    }
    const { session } = sessionWith(script, { now: () => now })
    await session.start(['a'])
    const signal = new AbortController().signal
    // The first answer is about to expire: asked again. The second too: used all the same.
    expect((await session.target('a', uri137, signal)).generation).toBe(2)
    expect((await session.target('a', uri140, signal)).generation).toBe(2)
    expect(script.asked).toEqual(['a', 'a'])
    now += 1
    expect((await session.target('a', uri137, signal)).generation).toBe(2)
  })

  test('YouTube’s wait before a video (an ad’s length) is waited out', async () => {
    const script: Script = {
      answers: { a: [told('a', { availableAt: Date.now() + 300 })] },
      asked: []
    }
    const { session } = sessionWith(script)
    await session.start(['a'])
    const started = Date.now()
    await session.target('a', uri137, new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  test('a request stopped while its network asks stops at once', async () => {
    const controller = new AbortController()
    let finish: (video: YoutubeVideo) => void = () => {}
    let asked = 0
    const session = new YoutubeSession({
      variantId: undefined,
      signal: controller.signal,
      extract: (networkId) => {
        asked++
        if (asked === 1) return Promise.resolve(told(networkId))
        return new Promise((resolve) => (finish = resolve))
      }
    })
    await session.start(['a'])
    const request = new AbortController()
    const waiting = session.target('b', uri137, request.signal)
    await waitFor(() => asked === 2)
    request.abort(new Error('paused'))
    expect((await errorOf(waiting)).message).toBe('paused')
    finish(told('b'))
    expect((await session.target('b', uri137, new AbortController().signal)).url).toBe(
      'https://media.test/b/137'
    )
    // Stopped whole, the run's failures aren't counted against the network.
    controller.abort(new Error('stopped'))
    expect(await errorOf(session.target('a', uri137, controller.signal))).toHaveProperty(
      'message',
      'stopped'
    )
  })
})

// ---- yt-dlp and Deno, the probe and the plan ----------------------------------------------------

const missingTool = (name: string) => async () => ({
  path: null,
  source: 'override' as const,
  candidate: `/nowhere/${name}`,
  reason: `${name} was not found at /nowhere/${name}.`
})

test.describe('YouTube in the probe and the plan @smoke', () => {
  test.skip(!!NEEDS_FIXTURE_FFMPEG, NEEDS_FIXTURE_FFMPEG)
  let fake: FakeYtDlp
  let server: YoutubeServer
  let tools: YoutubeTools
  test.beforeAll(async () => {
    fake = new FakeYtDlp(await fakeDir())
    server = await new YoutubeServer(await youtubeMedia()).start()
    fake.serve(server)
    fake.set(ID.ok, { info: await videoInfo(ID.ok, { title: 'Test card' }) })
    tools = {
      ytDlp: async () => ({ path: fake.ytDlp, source: 'override' }),
      deno: async () => ({ path: fake.deno, source: 'override' })
    }
  })
  test.afterAll(async () => {
    await server?.stop()
    if (fake) await rm(fake.dir, { recursive: true, force: true })
  })

  test('without yt-dlp or Deno, it says which is missing and where it looked', async () => {
    expect(await youtubePrograms(tools)).toEqual({ ytDlp: fake.ytDlp, deno: fake.deno })
    expect(
      (await errorOf(youtubePrograms({ ...tools, ytDlp: missingTool('yt-dlp') }))).message
    ).toBe(
      'Mergelane needs yt-dlp to download from YouTube, and couldn’t find it. yt-dlp was not found at /nowhere/yt-dlp.'
    )
    expect((await errorOf(youtubePrograms({ ...tools, deno: missingTool('Deno') }))).message).toBe(
      'Mergelane needs Deno to download from YouTube, and couldn’t find it. Deno was not found at /nowhere/Deno.'
    )
    // Deno is found the way yt-dlp and FFmpeg are (see resolveToolPath).
    expect(TOOL_PATH_ENV.deno).toBe('MERGELANE_DENO_PATH')
    expect(
      await resolveToolPath('deno', {
        isPackaged: true,
        resourcesPath: fake.dir,
        appRoot: '/nowhere'
      })
    ).toEqual({ path: join(fake.dir, 'deno'), source: 'packaged' })
    const missing = await resolveToolPath('deno', {
      isPackaged: false,
      resourcesPath: '',
      appRoot: '/nowhere',
      env: {}
    })
    expect(missing.path).toBeNull()
    expect(missing.path === null && missing.reason).toBe(
      'Deno was not found at /nowhere/resources/bin/deno. Run "npm run fetch:media-tools" in app/ to download it.'
    )
  })

  test('New download is shown the qualities, best first, each with its size', async () => {
    forgetDescribed()
    fake.clearCalls()
    const sizes = await mediaSizes()
    const probe = await describeYoutube(`https://youtu.be/${ID.ok}`, youtubeWatchUrl(ID.ok), tools)
    expect(probe).toEqual({
      kind: 'stream',
      requestedUrl: `https://youtu.be/${ID.ok}`,
      finalUrl: youtubeWatchUrl(ID.ok),
      supportsRanges: true,
      totalBytes: null,
      suggestedFileName: 'Test card',
      contentType: null,
      etag: null,
      lastModified: null,
      stream: {
        protocol: 'youtube',
        durationSeconds: YT_SECONDS,
        variants: [
          {
            id: '133+140',
            bandwidth: 264_000,
            width: 320,
            height: 240,
            frameRate: 15,
            codecs: ['avc1.64000d', 'mp4a.40.2'],
            bytes: sizes['v240.mp4'] + sizes['a.m4a']
          },
          {
            id: '160+140',
            bandwidth: 154_000,
            width: 160,
            height: 120,
            frameRate: 15,
            codecs: ['avc1.64000b', 'mp4a.40.2'],
            bytes: sizes['v120.mp4'] + sizes['a.m4a']
          }
        ]
      }
    })
    // Starting it right after doesn't ask yt-dlp again; later, or for another, it does.
    expect(fake.calls(ID.ok)).toHaveLength(1)
    const plan = await planYoutube(youtubeWatchUrl(ID.ok), '160+140', tools)
    expect([plan.variantId, plan.quality]).toEqual(['160+140', '120p'])
    expect(fake.calls(ID.ok)).toHaveLength(1)
    forgetDescribed()
    expect((await planYoutube(youtubeWatchUrl(ID.ok), undefined, tools)).variantId).toBe('133+140')
    expect(fake.calls(ID.ok)).toHaveLength(2)

    fake.set('nothingleft', { info: { ...(await videoInfo('nothingleft')), formats: [] } })
    expect(
      (await errorOf(describeYoutube('x', youtubeWatchUrl('nothingleft'), tools))).message
    ).toBe(new YoutubeError('no-formats').message)
  })

  test('asked through a network, yt-dlp’s questions go through the proxy pinned to it', async () => {
    fake.clearCalls()
    const dialled: string[] = []
    const video = await extractYoutube(youtubeWatchUrl(ID.ok), tools, {
      dial: async (host, port) => {
        dialled.push(`${host}:${port}`)
        return connect(port, host)
      }
    })
    expect(video.formats.map((entry) => entry.id)).toEqual(['160', '133', '140'])
    const [call] = fake.calls(ID.ok)
    const proxy = call.argv[call.argv.indexOf('--proxy') + 1]
    expect(proxy).toMatch(/^http:\/\/mergelane:[0-9a-f]{32}@127\.0\.0\.1:\d+$/)
    expect(dialled).toEqual([new URL(server.base).host])
    // Its addresses were "signed" for the address the network asked from.
    expect(new URL(video.formats[0].url).searchParams.get('ip')).toBe('127.0.0.1')
    expect(video.formats[0].headers).toEqual(FORMAT_HEADERS)
  })
})

// ---- The stream transfer ------------------------------------------------------------------------

const loopback = (id: string, address = '127.0.0.1'): NetworkInterfaceInfo => ({
  id,
  device: 'lo0',
  displayName: id,
  kind: 'ethernet',
  addresses: [{ address, family: address.includes(':') ? 6 : 4 }]
})

interface Harness {
  transfer: StreamTransfer
  target: StreamTransferTarget
  state: StreamDownloadState
  dir: string
  failures: string[]
  run: () => Promise<void>
  pause: () => Promise<void>
  resume: () => void
}

async function harness(options: {
  fake: FakeYtDlp
  tools: YoutubeTools
  id?: string
  variantId?: string
  interfaces?: NetworkInterfaceInfo[]
  /** Networks listed for the download that the computer doesn't have (any more). */
  gone?: string[]
}): Promise<Harness> {
  const dir = await scratch()
  const url = youtubeWatchUrl(options.id ?? ID.ok)
  forgetDescribed()
  const plan = await planYoutube(url, options.variantId, options.tools)
  const resolved = {
    protocol: 'youtube' as const,
    tracks: plan.tracks,
    codecs: plan.codecs,
    quality: plan.quality
  }
  const tracks = planTracks(resolved.tracks)
  const blocks = planStreamBlocks(tracks)
  const destinationPath = await reserveStagingFolder(
    dir,
    streamFileName('Test card', streamContainer(resolved))
  )
  const interfaces = options.interfaces ?? [loopback('a')]
  const listed = [...interfaces, ...(options.gone ?? []).map((id) => loopback(id))]
  const state: StreamDownloadState = {
    id: 'yt',
    kind: 'stream',
    protocol: 'youtube',
    quality: plan.quality,
    url,
    fileName: 'Test card.mp4',
    destinationPath,
    totalBytes: plan.choice.main.size + (plan.choice.audio?.size ?? 0),
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    status: 'downloading',
    networks: listed.map((iface) => ({
      transfer: 'http',
      id: iface.id,
      label: iface.id,
      kind: iface.kind,
      enabled: true,
      status: 'on',
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      retries: 0
    })),
    streams: [],
    peakStreams: 0,
    blocks,
    totalBlocks: blocks.length,
    trackSegments: trackShape(tracks),
    codecs: plan.codecs,
    durationSeconds: YT_SECONDS,
    startedAt: Date.now()
  }
  const target: StreamTransferTarget = {
    state,
    requestPayload: {
      kind: 'stream',
      url,
      protocol: 'youtube',
      variantId: plan.variantId,
      destinationDir: dir,
      suggestedFileName: 'Test card',
      totalBytes: 0,
      supportsRanges: true,
      interfaceIds: listed.map((iface) => iface.id),
      etag: null,
      lastModified: null
    },
    stop: new AbortController(),
    file: new StreamDestination(`${destinationPath}.mergelane`, () => state.totalBytes),
    blocks,
    meters: new Meters()
  }
  const failures: string[] = []
  const fail = (message: string): void => {
    if (state.status !== 'downloading') return
    failures.push(message)
    state.status = 'error'
    target.stop.abort()
    transfer.abort()
  }
  const host: TransferHost = {
    networks: {
      find: (id: string) => interfaces.find((iface) => iface.id === id)
    } as unknown as NetworkMonitor,
    limits: { take: () => 0 } as unknown as Limits,
    downloadsOn: () => 1,
    reconcile: () => transfer.reconcile(),
    failDownload: (message) => fail(message),
    // As the manager does: every network failed fails the download with the first one's reason.
    failNetwork: (network, message) => {
      network.status = 'failed'
      network.error = message
      if (state.networks.every((entry) => entry.status === 'failed')) {
        fail(state.networks[0].error ?? message)
      }
    },
    scheduleUpdate: () => {},
    getProxyForInterface: () => undefined
  }
  const transfer: StreamTransfer = new StreamTransfer(target, host, {
    ffmpeg: async () =>
      APP_FFMPEG
        ? { path: APP_FFMPEG, source: 'override' }
        : { path: null, source: 'override', candidate: '', reason: NEEDS_FFMPEG },
    timeoutMs: 3000,
    connectTimeoutMs: 2000,
    streamsPerNetwork: 2,
    retryDelayMs: 10,
    youtube: options.tools
  })
  return {
    transfer,
    target,
    state,
    dir,
    failures,
    run: async () => {
      transfer.reconcile()
      for (;;) {
        const running = [...transfer.running()]
        if (running.length === 0) break
        await Promise.all(running)
      }
    },
    pause: async () => {
      state.status = 'paused'
      target.stop.abort()
      transfer.reset()
      transfer.abort()
      await Promise.all(transfer.running())
    },
    resume: () => {
      state.status = 'downloading'
      target.stop = new AbortController()
      transfer.reset()
    }
  }
}

/** The byte range a request asked for, as [start, end]. */
const rangeOf = (range: string | undefined): [number, number] => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
  if (!match) throw new Error(`Not a closed range: ${range}`)
  return [Number(match[1]), Number(match[2])]
}

test.describe('YouTube downloads in the stream transfer @smoke', () => {
  test.skip(!!NEEDS_FFMPEG, NEEDS_FFMPEG)
  let fake: FakeYtDlp
  let server: YoutubeServer
  let tools: YoutubeTools
  test.beforeEach(async () => {
    fake = new FakeYtDlp(await fakeDir())
    server = await new YoutubeServer(await youtubeMedia()).start()
    fake.serve(server)
    fake.set(ID.ok, { info: await videoInfo(ID.ok, { chunk: CHUNK }) })
    tools = {
      ytDlp: async () => ({ path: fake.ytDlp, source: 'override' }),
      deno: async () => ({ path: fake.deno, source: 'override' })
    }
  })
  test.afterEach(async () => {
    await server.stop()
    await rm(fake.dir, { recursive: true, force: true })
  })

  test('fetches the quality picked in ranges no bigger than yt-dlp’s chunk, then joins it', async () => {
    const h = await harness({ fake, tools, variantId: '133+140' })
    fake.clearCalls()
    await h.run()
    expect(h.failures).toEqual([])
    const media = await inspect(h.target.file.output!)
    expect([media.video, media.audio, media.size]).toEqual([['h264'], ['aac'], '320x240'])
    expect(media.duration).toBeGreaterThan(YT_SECONDS - 1)
    expect(h.target.file.output!.endsWith('Test card.mp4')).toBe(true)

    const sizes = await mediaSizes()
    const served = server.served()
    expect(new Set(served.map((entry) => entry.file))).toEqual(new Set(['v240.mp4', 'a.m4a']))
    for (const entry of served) {
      const [start, end] = rangeOf(entry.range)
      expect(end - start + 1).toBeLessThanOrEqual(CHUNK)
      // The format's own headers, never the browser's.
      expect(entry.userAgent).toBe(FORMAT_HEADERS['User-Agent'])
    }
    for (const file of ['v240.mp4', 'a.m4a']) {
      const bytes = served
        .filter((entry) => entry.file === file)
        .reduce((sum, entry) => sum + rangeOf(entry.range)[1] - rangeOf(entry.range)[0] + 1, 0)
      expect(bytes, file).toBe(sizes[file])
    }
    expect(h.state.bytesDownloaded).toBe(sizes['v240.mp4'] + sizes['a.m4a'])
    expect(h.state.totalBytes).toBe(h.state.bytesDownloaded)
    // Asked once, through the proxy pinned to the network.
    const calls = fake.calls(ID.ok)
    expect(calls).toHaveLength(1)
    expect(calls[0].argv[calls[0].argv.indexOf('--proxy') + 1]).toMatch(/^http:\/\/mergelane:/)
    expect(server.log.filter((entry) => entry.status === 403)).toEqual([])
  })

  test('two networks: each asks for its own addresses and fetches with them', async () => {
    test.skip(!LAN, 'needs a LAN address to act as the second network')
    const h = await harness({ fake, tools, interfaces: [loopback('a'), loopback('b', LAN!)] })
    fake.clearCalls()
    await h.run()
    expect(h.failures).toEqual([])
    const served = server.served()
    expect(new Set(served.map((entry) => entry.from))).toEqual(new Set(['127.0.0.1', LAN]))
    // Every request came from the address its URL was signed for: none was refused.
    expect(served.every((entry) => entry.ip === entry.from)).toBe(true)
    expect(server.log.some((entry) => entry.status === 403)).toBe(false)
    expect(fake.calls(ID.ok)).toHaveLength(2)
    expect(h.state.networks.every((network) => network.bytesDownloaded > 0)).toBe(true)
  })

  test('a network yt-dlp can’t ask through sits out, saying why; the others carry on', async () => {
    // "gone": listed for the download, but the computer doesn't have it, so its proxy can't dial.
    const h = await harness({ fake, tools, gone: ['b'] })
    await h.run()
    expect(h.failures).toEqual([])
    const b = h.state.networks.find((network) => network.id === 'b')!
    expect(b.status).toBe('failed')
    expect(b.error).toBe(new YoutubeError('network').message)
    expect(b.bytesDownloaded).toBe(0)
    expect(server.served().every((entry) => entry.from === '127.0.0.1')).toBe(true)
  })

  test('refused (403), the network asks again and the download goes on', async () => {
    const h = await harness({ fake, tools })
    // YouTube stops honouring the transfer's addresses (its second run; the plan's was the first)
    // after a few requests.
    let honoured = 0
    server.refuse = (entry) => entry.gen === 2 && ++honoured > 3
    await h.run()
    expect(h.failures).toEqual([])
    expect(server.log.filter((entry) => entry.status === 403).length).toBeGreaterThan(0)
    expect(fake.calls(ID.ok).length).toBeGreaterThanOrEqual(3)
    expect(server.served().some((entry) => entry.gen === 3)).toBe(true)
    expect((await inspect(h.target.file.output!)).audio).toEqual(['aac'])
  })

  test('refused for good, the download fails, naming the part', async () => {
    server.refuse = () => true
    const h = await harness({ fake, tools })
    await h.run()
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]).toMatch(
      /^(YouTube didn’t send part \d+ of this video \(HTTP 403\)\. Try again later\.|YouTube kept refusing this network’s requests \(HTTP 403\), so it sits this download out\.)$/
    )
  })

  test('addresses that are about to expire are asked for again before they are used', async () => {
    // Its runs: the plan's, then the transfer's (expiring within the margin), then a fresh one.
    fake.set(ID.ok, {
      info: await videoInfo(ID.ok, { chunk: CHUNK }),
      expireIn: [21_600, 30, 21_600]
    })
    const h = await harness({ fake, tools })
    await h.run()
    expect(h.failures).toEqual([])
    expect(fake.calls(ID.ok)).toHaveLength(3)
    // Nothing was asked for with the expiring ones.
    expect(server.log.every((entry) => entry.gen === 3)).toBe(true)
  })

  test('paused, it keeps its finished parts; resumed, it asks again and fetches only the rest', async () => {
    server.hold = (entry) => rangeOf(entry.range)[0] >= 2 * CHUNK
    const h = await harness({ fake, tools, variantId: '133+140' })
    fake.clearCalls()
    h.transfer.reconcile()
    await waitFor(() => server.log.filter((entry) => entry.held).length >= 4)
    await waitFor(() => h.state.blocks.filter((block) => block.status === 'completed').length >= 4)
    await h.pause()
    const done = h.state.blocks.filter((block) => block.status === 'completed').length
    const resumedAt = Date.now()
    server.release()
    h.resume()
    await h.run()
    expect(h.failures).toEqual([])
    // Asked afresh for the resumed run: its addresses are never kept.
    expect(fake.calls(ID.ok)).toHaveLength(2)
    const again = server
      .served()
      .filter((entry) => entry.at >= resumedAt && rangeOf(entry.range)[0] < 2 * CHUNK)
    expect(again).toEqual([])
    expect(done).toBeGreaterThan(0)
    expect((await inspect(h.target.file.output!)).video).toEqual(['h264'])
  })

  test('a video every network is refused fails with what yt-dlp said, in plain words', async () => {
    const h = await harness({ fake, tools })
    fake.set(ID.ok, { stderr: 'ERROR: [youtube] okokokokok1: Sign in to confirm your age' })
    await h.run()
    expect(h.failures).toEqual([SIGN_IN_MESSAGE])
    expect(server.served()).toEqual([])
  })

  test('without yt-dlp it fails at once, saying so, before asking anything', async () => {
    const h = await harness({ fake, tools })
    fake.clearCalls()
    ;(h.transfer as unknown as { options: { youtube: YoutubeTools } }).options.youtube = {
      ...tools,
      ytDlp: missingTool('yt-dlp')
    }
    await h.run()
    expect(h.failures).toEqual([
      'Mergelane needs yt-dlp to download from YouTube, and couldn’t find it. yt-dlp was not found at /nowhere/yt-dlp.'
    ])
    ;(h.transfer as unknown as { options: { youtube?: YoutubeTools } }).options.youtube = undefined
    h.resume()
    await h.run()
    expect(h.failures.at(-1)).toBe('This build of Mergelane can’t download from YouTube.')
    expect(fake.calls()).toEqual([])
  })

  test('a network switched back on asks again, though it sat out', async () => {
    test.skip(!LAN, 'needs a LAN address to act as the second network')
    fake.set(ID.ok, {
      info: await videoInfo(ID.ok, { chunk: CHUNK }),
      failFrom: { [LAN!]: 'ERROR: [youtube] okokokokok1: Sign in to confirm you’re not a bot' }
    })
    server.hold = (entry) => entry.from === '127.0.0.1' && rangeOf(entry.range)[0] >= 2 * CHUNK
    const h = await harness({ fake, tools, interfaces: [loopback('a'), loopback('b', LAN!)] })
    h.transfer.reconcile()
    const b = h.state.networks.find((network) => network.id === 'b')!
    await waitFor(() => b.status === 'failed')
    expect(b.error).toBe(new YoutubeError('bot-check').message)
    // The bot check is over; the user switches it off and on.
    fake.set(ID.ok, { info: await videoInfo(ID.ok, { chunk: CHUNK }) })
    b.status = 'on'
    b.error = undefined
    h.transfer.wake(
      (id) => id === 'b',
      () => false
    )
    await waitFor(() => server.served().some((entry) => entry.from === LAN))
    server.release()
    await h.run()
    expect(h.failures).toEqual([])
  })

  test('with no network on, it waits to ask YouTube until one is', async () => {
    const h = await harness({ fake, tools })
    fake.clearCalls()
    const [a] = h.state.networks
    a.status = 'off'
    h.transfer.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fake.calls(ID.ok)).toEqual([])
    a.status = 'on'
    // What the manager's reconcile does once a network comes back.
    h.transfer.reconcile()
    await h.run()
    expect(h.failures).toEqual([])
    expect(fake.calls(ID.ok)).toHaveLength(1)
  })

  test('a YouTube video is never read as a manifest', async () => {
    expect(
      (await errorOf(resolveStream(youtubeWatchUrl(ID.ok), 'youtube', undefined))).message
    ).toBe('A YouTube video has no manifest to read')
  })
})

// Signed addresses are never written to disk: the segment downloader's resume record keeps only a
// hash of the track's own addresses.
test.describe('what a YouTube download keeps on disk @smoke', () => {
  test.skip(!!NEEDS_FIXTURE_FFMPEG, NEEDS_FIXTURE_FFMPEG)
  test('its parts and resume record hold no signed address', async () => {
    const fake = new FakeYtDlp(await fakeDir())
    const server = await new YoutubeServer(await youtubeMedia()).start()
    try {
      fake.serve(server)
      fake.set(ID.ok, { info: await videoInfo(ID.ok, { chunk: CHUNK }) })
      const tools: YoutubeTools = {
        ytDlp: async () => ({ path: fake.ytDlp, source: 'override' }),
        deno: async () => ({ path: fake.deno, source: 'override' })
      }
      server.hold = (entry) => rangeOf(entry.range)[0] >= CHUNK
      const h = await harness({ fake, tools })
      h.transfer.reconcile()
      await waitFor(() => server.log.filter((entry) => entry.held).length >= 2)
      await waitFor(() => h.state.blocks.some((block) => block.status === 'completed'))
      await h.pause()
      const staging = `${h.state.destinationPath}.mergelane`
      const texts: string[] = []
      for (const folder of await readdir(staging)) {
        const path = join(staging, folder)
        for (const name of await readdir(path).catch(() => [])) {
          if (name.endsWith('.json')) texts.push(await readFile(join(path, name), 'utf8'))
        }
      }
      expect(texts.length).toBeGreaterThan(0)
      for (const text of texts) {
        expect(text).not.toContain('videoplayback')
        expect(text).not.toContain('sig=')
        expect(text).not.toContain('127.0.0.1')
      }
      server.release()
    } finally {
      await server.stop()
      await rm(fake.dir, { recursive: true, force: true })
    }
  })
})
