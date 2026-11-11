// Layer B (Node only, no Electron): stream downloads below the download manager. What the probe
// makes of an HLS or DASH link, the adapter that hands DASH tracks to the HLS segment downloader,
// the staging folder, and StreamTransfer itself, run against real FFmpeg-made streams on a local
// server with a stand-in for the manager.

import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  NetworkInterfaceInfo,
  StreamDownloadState,
  StreamSegmentState
} from '../src/shared/types'
import { streamQualityLabel } from '../src/shared/streamQuality'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import { DashError, parseMpd, planRepresentation, type Mpd } from '../src/main/media/dash'
import {
  HlsHttpError,
  HlsLimitError,
  HlsLiveStreamError,
  HlsProtectedStreamError,
  HlsVariantNotFoundError,
  assertDownloadable,
  downloadHlsTrack,
  segmentRequests,
  type HlsFetch
} from '../src/main/media/hls'
import { TEMP_SUFFIX } from '../src/main/media/mux'
import type { NetworkMonitor } from '../src/main/network/interfaces'
import type { Limits } from '../src/main/network/limits'
import { reserveStagingFolder } from '../src/main/download/paths'
import { restoreStreamSegments, saveBlocks } from '../src/main/download/savedProgress'
import { Meters, type StreamTransferTarget, type TransferHost } from '../src/main/download/transfer'
import { StreamDestination } from '../src/main/download/stream/streamDestination'
import {
  dashTrackPlaylist,
  describeStream,
  fetchManifest,
  planStreamBlocks,
  planTracks,
  resolveStream,
  sameShape,
  streamContainer,
  streamFileName,
  streamProtocolOf,
  streamTitle,
  trackShape
} from '../src/main/download/stream/streamPlan'
import {
  StreamTransfer,
  freeOutputPath,
  sweepMuxLeftovers
} from '../src/main/download/stream/streamTransfer'
import {
  FFMPEG,
  NO_FFMPEG,
  PATHS,
  SECONDS,
  StreamServer,
  inspect,
  removeStreamMedia,
  streamMedia
} from './streamMedia'

let scratchRoot: Promise<string> | undefined
async function scratch(): Promise<string> {
  scratchRoot ??= mkdtemp(join(tmpdir(), 'mergelane-stream-'))
  return mkdtemp(join(await scratchRoot, 'case-'))
}

// Fully parallel, a worker can be handed more of this file's tests after its afterAll: what it
// removes is made again on demand.
test.afterAll(async () => {
  const root = scratchRoot
  scratchRoot = undefined
  if (root) await rm(await root, { recursive: true, force: true })
  await removeStreamMedia()
})

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* parts
}

/** A fetch answering from a table of URLs. */
function tableFetch(table: Record<string, string | Buffer | number>): HlsFetch {
  return async (url, init) => {
    const entry = table[url]
    if (entry === undefined || typeof entry === 'number') {
      return { status: typeof entry === 'number' ? entry : 404, body: chunks(), url }
    }
    let data = Buffer.from(entry)
    if (init.range) data = data.subarray(init.range.start, init.range.end + 1)
    return {
      status: init.range ? 206 : 200,
      url,
      headers: { 'content-length': String(data.length) },
      body: chunks(data)
    }
  }
}

// ---- What a link is ----------------------------------------------------------------------------

test.describe('stream links @smoke', () => {
  test('are known by their Content-Type first, then by their extension', () => {
    const at = (path: string): URL => new URL(`https://cdn.example.com${path}`)
    expect(streamProtocolOf('application/vnd.apple.mpegurl', at('/a'))).toBe('hls')
    expect(streamProtocolOf('Application/X-MpegURL; charset=utf-8', at('/a'))).toBe('hls')
    expect(streamProtocolOf('application/dash+xml', at('/a.m3u8'))).toBe('dash')
    expect(streamProtocolOf(undefined, at('/v/index.M3U8'))).toBe('hls')
    expect(streamProtocolOf('application/octet-stream', at('/v/manifest.mpd'))).toBe('dash')
    expect(streamProtocolOf('application/xml', at('/feed'))).toBeNull()
    // Plain M3U radio playlists stay files.
    expect(streamProtocolOf('audio/mpegurl', at('/radio.m3u'))).toBeNull()
    expect(streamProtocolOf('application/vnd.apple.mpegurl-extra', at('/a'))).toBeNull()
  })

  test('are named from their path, past generic manifest names', () => {
    const title = (path: string): string => streamTitle(new URL(`https://x.test${path}`))
    expect(title('/talks/keynote-2026/hls/master.m3u8')).toBe('keynote-2026')
    expect(title('/videos/My%20Talk.m3u8')).toBe('My Talk')
    expect(title('/clips/odd%E0%A4.mpd')).toBe('odd%E0%A4')
    expect(title('/dash/Manifest.mpd')).toBe('video')
    expect(title('/')).toBe('video')
    expect(streamFileName('Talk', 'mp4')).toBe('Talk.mp4')
    expect(streamFileName('Talk.MP4', 'mkv')).toBe('Talk.mkv')
    expect(streamFileName('my.talk', 'mkv')).toBe('my.talk.mkv')
    expect(streamFileName('  index.m3u8 ', 'mp4')).toBe('index.mp4')
    expect(streamFileName('  ', 'mp4')).toBe('video.mp4')
  })

  test('qualities are named by height, else by bit rate', () => {
    expect(streamQualityLabel({ height: 1080, bandwidth: 5e6 })).toBe('1080p')
    expect(streamQualityLabel({ height: 0, bandwidth: 2_500_000 })).toBe('2.5 Mbps')
    expect(streamQualityLabel({ bandwidth: 128_000 })).toBe('128 kbps')
    expect(streamQualityLabel({ bandwidth: 0 })).toBe('1 kbps')
  })
})

// ---- The DASH adapter --------------------------------------------------------------------------

const LIST_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000" width="64" height="48" codecs="avc1.4d401e">
        <SegmentList duration="2">
          <Initialization sourceURL="media.mp4" range="0-3"/>
          <SegmentURL media="media.mp4" mediaRange="4-9"/>
          <SegmentURL media="media.mp4" mediaRange="10-15"/>
          <SegmentURL media="tail.mp4"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

test.describe('DASH tracks as media playlists @smoke', () => {
  test('keep every request, range and order, for the HLS segment downloader', async () => {
    const mpd: Mpd = parseMpd(LIST_MPD, 'https://cdn.example.com/v/manifest.mpd')
    const plan = planRepresentation(mpd, mpd.adaptationSets[0].representations[0])
    const playlist = dashTrackPlaylist(plan, mpd)
    assertDownloadable(playlist)
    expect(playlist.duration).toBe(6)
    expect(playlist.segments.map((segment) => segment.duration)).toEqual([2, 2, 2])
    const requests = segmentRequests(playlist)
    expect(requests.map(({ kind, uri, range }) => ({ kind, uri, range }))).toEqual(
      plan.requests.map((request, index) => ({
        kind: index === 0 ? 'init' : 'media',
        uri: request.url,
        range: request.range
      }))
    )

    // Joined, the responses are the track: the init section, then each segment in order.
    const media = Buffer.from('IIIIaaaaaabbbbbb')
    const dir = await scratch()
    const result = await downloadHlsTrack({
      playlist,
      outputPath: join(dir, 'video.track'),
      fetch: tableFetch({
        'https://cdn.example.com/v/media.mp4': media,
        'https://cdn.example.com/v/tail.mp4': 'cc'
      }),
      retries: 0
    })
    expect(await readFile(result.outputPath, 'utf-8')).toBe('IIIIaaaaaabbbbbbcc')
  })

  test('without a duration, segments carry none', () => {
    const mpd = parseMpd(
      LIST_MPD.replace(' mediaPresentationDuration="PT6S"', '').replace(' duration="2"', ''),
      'https://cdn.example.com/v/manifest.mpd'
    )
    const playlist = dashTrackPlaylist(
      planRepresentation(mpd, mpd.adaptationSets[0].representations[0]),
      mpd
    )
    expect(playlist.duration).toBe(0)
    expect(playlist.targetDuration).toBe(0)
    expect(playlist.segments.every((segment) => segment.duration === 0)).toBe(true)
  })
})

// ---- Resolving and describing ------------------------------------------------------------------

test.describe('resolving streams @smoke', () => {
  test.skip(FFMPEG === null, NO_FFMPEG)
  let server: StreamServer
  test.beforeAll(async () => {
    server = await new StreamServer(await streamMedia()).start()
  })
  test.afterAll(async () => server.stop())

  test('HLS: the best variant and its audio group, or the one asked for', async () => {
    const best = await resolveStream(server.url(PATHS.master), 'hls', undefined)
    expect(best.tracks.map((track) => track.role)).toEqual(['video', 'audio'])
    expect(best.tracks[0].playlist.url).toContain('/v240/')
    expect(best.codecs).toEqual(['avc1.64000d', 'mp4a.40.2'])
    expect(best.quality).toBe('240p')
    expect(best.durationSeconds).toBeCloseTo(SECONDS, 0)
    expect(streamContainer(best)).toBe('mp4')

    const low = await resolveStream(server.url(PATHS.master), 'hls', 'v1')
    expect(low.tracks[0].playlist.url).toContain('/v120/')
    expect(low.quality).toBe('120p')

    // A media playlist: one track, nothing to choose, codecs unknown (so Matroska).
    const single = await resolveStream(server.url(PATHS.muxed), 'hls', undefined)
    expect(single.tracks.map((track) => track.role)).toEqual(['video'])
    expect(single.quality).toBeUndefined()
    expect(streamContainer(single)).toBe('mkv')

    expect(await rejection(resolveStream(server.url(PATHS.master), 'hls', 'v9'))).toBeInstanceOf(
      HlsVariantNotFoundError
    )
  })

  test('DASH: the best video and the audio, or the representation asked for', async () => {
    const best = await resolveStream(server.url(PATHS.mpd), 'dash', undefined)
    expect(best.tracks.map((track) => track.role)).toEqual(['video', 'audio'])
    expect(best.codecs).toEqual(['avc1.64000d', 'mp4a.40.2'])
    expect(best.quality).toBe('240p')
    expect(best.durationSeconds).toBe(SECONDS)
    const low = await resolveStream(server.url(PATHS.mpd), 'dash', '1')
    expect(low.quality).toBe('120p')
    expect(low.tracks[0].playlist.segments[0].uri).toContain('chunk-1-')
    const error = await rejection(resolveStream(server.url(PATHS.mpd), 'dash', '7'))
    expect(error).toBeInstanceOf(DashError)
    expect((error as DashError).code).toBe('no-match')

    // Audio alone is the main track, and one quality offers no choice.
    const mpd = await readFile(join(await streamMedia(), PATHS.mpd), 'utf-8')
    server.overrides.set('/dash/audio.mpd', {
      type: 'application/dash+xml',
      body: mpd.replace(/<AdaptationSet id="0"[\s\S]*?<\/AdaptationSet>/, '')
    })
    const audio = await resolveStream(server.url('/dash/audio.mpd'), 'dash', undefined)
    expect(audio.tracks.map((track) => track.role)).toEqual(['video'])
    expect(audio.codecs).toEqual(['mp4a.40.2'])
    expect(audio.quality).toBeUndefined()
    server.overrides.set('/dash/single.mpd', {
      type: 'application/dash+xml',
      body: mpd.replace(/<Representation id="1"[\s\S]*?<\/Representation>/, '')
    })
    const one = await resolveStream(server.url('/dash/single.mpd'), 'dash', undefined)
    expect(one.quality).toBeUndefined()
  })

  test('describes qualities best first, for the picker', async () => {
    const hls = await describeStream(
      'hls',
      server.url(PATHS.master),
      server.url(PATHS.master),
      'application/vnd.apple.mpegurl'
    )
    expect(hls).toMatchObject({
      kind: 'stream',
      supportsRanges: true,
      totalBytes: null,
      suggestedFileName: 'video',
      stream: { protocol: 'hls' }
    })
    expect(hls.stream.variants).toEqual([
      {
        id: 'v0',
        bandwidth: 400000,
        width: 320,
        height: 240,
        codecs: ['avc1.64000d', 'mp4a.40.2']
      },
      { id: 'v1', bandwidth: 150000, width: 160, height: 120, codecs: ['avc1.64000b', 'mp4a.40.2'] }
    ])
    expect(hls.stream.durationSeconds).toBeCloseTo(SECONDS, 0)

    const dash = await describeStream('dash', 'x', server.url(PATHS.mpd), null)
    expect(dash.stream.variants.map((variant) => [variant.id, variant.height])).toEqual([
      ['0', 240],
      ['1', 120]
    ])
    expect(dash.stream.variants[0].codecs).toEqual(['avc1.64000d'])
    expect(dash.suggestedFileName).toBe('video')

    // A media playlist offers no choice; one with no length says none.
    const single = await describeStream('hls', 'x', server.url(PATHS.muxed), null)
    expect(single.stream.variants).toEqual([])
  })

  test('refuses live, encrypted and protected streams with what to tell the user', async () => {
    const live = await rejection(describeStream('hls', 'x', server.url(PATHS.live), null))
    expect(live).toBeInstanceOf(HlsLiveStreamError)
    expect(live.message).toContain('live stream')
    const encrypted = await rejection(describeStream('hls', 'x', server.url(PATHS.encrypted), null))
    expect(encrypted).toBeInstanceOf(HlsProtectedStreamError)
    const liveDash = await rejection(describeStream('dash', 'x', server.url(PATHS.liveMpd), null))
    expect((liveDash as DashError).code).toBe('live')
    const drm = await rejection(describeStream('dash', 'x', server.url(PATHS.protectedMpd), null))
    expect((drm as DashError).code).toBe('protected')
    expect(drm.message).toContain('protected with DRM')
  })

  test('reads a manifest only when the server answers it, and only up to 10 MiB', async () => {
    const missing = await rejection(fetchManifest(server.url('/dash/none.mpd')))
    expect(missing).toBeInstanceOf(HlsHttpError)
    const huge: HlsFetch = async (url) => ({
      status: 200,
      url,
      body: (async function* () {
        for (let i = 0; i < 11; i++) yield new Uint8Array(1024 * 1024)
      })()
    })
    const tooBig = await rejection(fetchManifest('https://x.test/m.mpd', { fetch: huge }))
    expect(tooBig).toBeInstanceOf(HlsLimitError)
    expect(tooBig.message).toContain('DASH manifest is larger than 10 MiB')
    // A fetch that doesn't say where it ended up: the URL asked for.
    const plain = await fetchManifest('https://x.test/m.mpd', {
      fetch: async () => ({ status: 200, body: chunks(Buffer.from('ok')) })
    })
    expect(plain.url).toBe('https://x.test/m.mpd')
  })

  test('plans a block per request, track after track', async () => {
    const resolved = await resolveStream(server.url(PATHS.mpd), 'dash', undefined)
    const tracks = planTracks(resolved.tracks)
    // An init segment and 8 segments of video; one and 9 of audio.
    expect(trackShape(tracks)).toEqual([9, 10])
    expect(tracks[1].first).toBe(9)
    const blocks = planStreamBlocks(tracks)
    expect(blocks).toHaveLength(19)
    expect(blocks.every((block, index) => block.index === index && block.rangeEnd === null)).toBe(
      true
    )
    expect(sameShape(tracks, [9, 10])).toBe(true)
    expect(sameShape(tracks, [10, 9])).toBe(false)
    expect(sameShape(tracks, [19])).toBe(false)

    // Byte ranges are sized from the start.
    const mpd = parseMpd(LIST_MPD, 'https://cdn.example.com/v/manifest.mpd')
    const listed = planTracks([
      {
        role: 'video',
        playlist: dashTrackPlaylist(
          planRepresentation(mpd, mpd.adaptationSets[0].representations[0]),
          mpd
        )
      }
    ])
    expect(planStreamBlocks(listed).map((block) => block.rangeEnd)).toEqual([3, 5, 5, null])
  })
})

// ---- Saving progress, and the staging folder ---------------------------------------------------

test.describe('stream download state @smoke', () => {
  test('restores whole segments only, from the sizes saved for them', () => {
    const saved = saveBlocks([
      {
        kind: 'stream',
        index: 0,
        rangeStart: 0,
        rangeEnd: 9,
        status: 'completed',
        bytesDownloaded: 10,
        bytesByInterface: { a: 4, b: 6 }
      },
      {
        kind: 'stream',
        index: 1,
        rangeStart: 0,
        rangeEnd: null,
        status: 'downloading',
        bytesDownloaded: 3,
        bytesByInterface: { a: 3 }
      },
      {
        kind: 'stream',
        index: 2,
        rangeStart: 0,
        rangeEnd: -1,
        status: 'completed',
        bytesDownloaded: 0,
        bytesByInterface: {}
      }
    ])
    const blocks = restoreStreamSegments({ totalBlocks: 3 }, saved, [10, null, 0])!
    expect(blocks.map((block) => [block.status, block.bytesDownloaded])).toEqual([
      ['completed', 10],
      ['pending', 0],
      ['completed', 0]
    ])
    expect(blocks[0].bytesByInterface).toEqual({ a: 4, b: 6 })
    expect(blocks[1].bytesByInterface).toEqual({})
    // Sizes that don't fit the download: nothing to restore.
    expect(restoreStreamSegments({ totalBlocks: 2 }, saved, [10, null, 0])).toBeUndefined()
    expect(restoreStreamSegments({ totalBlocks: 1 }, saved, ['10'])).toBeUndefined()
    expect(restoreStreamSegments({ totalBlocks: 1 }, saved, undefined)).toBeUndefined()
    // A column that doesn't fit is dropped, not trusted.
    const odd = restoreStreamSegments(
      { totalBlocks: 1 },
      { progress: { a: [1, 2], b: 'x' } as never, complete: false },
      [5]
    )!
    expect(odd[0]).toMatchObject({ status: 'pending', bytesDownloaded: 0 })
    expect(
      restoreStreamSegments({ totalBlocks: 1 }, { progress: null as never, complete: true }, [null])
    ).toHaveLength(1)
  })

  test('updates carry a stream download’s changed segments', () => {
    const state = {
      id: 'd',
      kind: 'stream',
      totalBlocks: 2
    } as unknown as Omit<StreamDownloadState, 'blocks'>
    const block = (index: number, status: 'pending' | 'completed'): StreamSegmentState => ({
      kind: 'stream' as const,
      index,
      rangeStart: 0,
      rangeEnd: null,
      status,
      bytesDownloaded: 0,
      bytesByInterface: {}
    })
    const first = applyDownloadUpdate(null, {
      seq: 1,
      state,
      blocks: [block(0, 'pending'), block(1, 'pending')]
    })
    expect(first?.kind).toBe('stream')
    const next = applyDownloadUpdate(first, { seq: 2, state, blocks: [block(1, 'completed')] })
    expect(next?.kind === 'stream' && next.blocks.map((b) => b.status)).toEqual([
      'pending',
      'completed'
    ])
    // A partial update without a snapshot to land on is no update.
    expect(applyDownloadUpdate(null, { seq: 3, state, blocks: [block(1, 'pending')] })).toBeNull()
  })

  test('the staging folder claims the name, holds the tracks and goes when done', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'Talk.mp4'), 'mine')
    const path = await reserveStagingFolder(dir, 'Talk.mp4')
    expect(path).toBe(join(dir, 'Talk (1).mp4'))
    expect((await stat(`${path}.mergelane`)).isDirectory()).toBe(true)
    // Claimed: the next one goes on.
    expect(await reserveStagingFolder(dir, 'Talk.mp4')).toBe(join(dir, 'Talk (2).mp4'))

    let reported = 42
    const file = new StreamDestination(`${path}.mergelane`, () => reported)
    expect(file.trackPath('video')).toBe(join(`${path}.mergelane`, 'video.track'))
    expect(file.workDirectory('audio')).toBe(join(`${path}.mergelane`, 'audio.parts'))
    expect(await file.size()).toBe(42)
    reported = 7
    expect(await file.size()).toBe(7)
    await file.sync()
    expect((await rejection(file.publish(path, 0, async () => {}))).message).toContain(
      'haven’t been joined'
    )
    await writeFile(path, 'video')
    file.output = path
    const attempts: string[] = []
    expect(
      await file.publish('ignored', 0, async (candidate) => void attempts.push(candidate))
    ).toBe(path)
    expect(attempts).toEqual([path])
    // Discarding takes the folder and a joined file the download didn't publish.
    await file.discard()
    expect(existsSync(`${path}.mergelane`)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(file.output).toBeNull()
    expect(existsSync(join(dir, 'Talk.mp4'))).toBe(true)
    await expect(file.size()).rejects.toThrow()

    // Only a `.mergelane` folder is ever removed, and only a folder counts as one.
    const notOurs = new StreamDestination(join(dir, 'Talk.mp4'), () => 1)
    await notOurs.discardLeftover()
    expect(existsSync(join(dir, 'Talk.mp4'))).toBe(true)
    await expect(notOurs.size()).rejects.toThrow('is not a folder')
  })

  test('stale FFmpeg leftovers are swept, and a taken name is passed over', async () => {
    const dir = await scratch()
    const stale = `Talk.mp4.0123abcd${TEMP_SUFFIX}`
    await writeFile(join(dir, stale), '')
    await writeFile(join(dir, `notes${TEMP_SUFFIX}`), '')
    await writeFile(join(dir, 'Talk.mp4'), '')
    await sweepMuxLeftovers(dir)
    expect((await readdir(dir)).sort()).toEqual(['Talk.mp4', `notes${TEMP_SUFFIX}`])
    await sweepMuxLeftovers(join(dir, 'missing'))

    expect(await freeOutputPath(join(dir, 'New.mp4'), join(dir, 'New.mp4'))).toBe(
      join(dir, 'New.mp4')
    )
    expect(await freeOutputPath(join(dir, 'Talk.mp4'), join(dir, 'Talk.mp4'))).toBe(
      join(dir, 'Talk (1).mp4')
    )
    await mkdir(join(dir, 'Talk (1).mp4.mergelane'))
    expect(await freeOutputPath(join(dir, 'Talk.mp4'), join(dir, 'Other.mp4'))).toBe(
      join(dir, 'Talk (2).mp4')
    )
    // Its own staging folder doesn't count against it.
    expect(await freeOutputPath(join(dir, 'Talk (1).mp4'), join(dir, 'Talk (1).mp4'))).toBe(
      join(dir, 'Talk (1).mp4')
    )
  })
})

// ---- The transfer ------------------------------------------------------------------------------

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
  failures: { message: string; discard?: boolean }[]
  /** Runs the transfer until its work is done, as the manager's run waits on it. */
  run: () => Promise<void>
  /** What the manager's pause does to it. */
  pause: () => Promise<void>
  /** What the manager's begin does before the next run. */
  resume: () => void
}

interface HarnessOptions {
  url: string
  protocol: 'hls' | 'dash'
  variantId?: string
  interfaces?: NetworkInterfaceInfo[]
  ffmpeg?: string | null
  take?: (networkId: string, bytes: number) => number
  timeoutMs?: number
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const dir = await scratch()
  const resolved = await resolveStream(options.url, options.protocol, options.variantId)
  const tracks = planTracks(resolved.tracks)
  const blocks = planStreamBlocks(tracks)
  const destinationPath = await reserveStagingFolder(
    dir,
    streamFileName('Talk', streamContainer(resolved))
  )
  const interfaces = options.interfaces ?? [loopback('a')]
  const state: StreamDownloadState = {
    id: 'stream',
    kind: 'stream',
    protocol: options.protocol,
    quality: resolved.quality,
    url: options.url,
    fileName: 'Talk.mp4',
    destinationPath,
    totalBytes: 0,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    status: 'downloading',
    networks: interfaces.map((iface) => ({
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
    codecs: resolved.codecs,
    durationSeconds: resolved.durationSeconds,
    startedAt: Date.now()
  }
  const target: StreamTransferTarget = {
    state,
    requestPayload: {
      kind: 'stream',
      url: options.url,
      protocol: options.protocol,
      variantId: options.variantId,
      destinationDir: dir,
      suggestedFileName: 'Talk',
      totalBytes: 0,
      supportsRanges: true,
      interfaceIds: interfaces.map((iface) => iface.id),
      etag: null,
      lastModified: null,
      browser: { cookies: [], userAgent: 'MergelaneTest/1', referer: 'https://page.test/' }
    },
    stop: new AbortController(),
    file: new StreamDestination(`${destinationPath}.mergelane`, () => state.totalBytes),
    blocks,
    meters: new Meters()
  }
  const failures: Harness['failures'] = []
  const host: TransferHost = {
    networks: {
      find: (id: string) => interfaces.find((iface) => iface.id === id)
    } as unknown as NetworkMonitor,
    limits: { take: options.take ?? (() => 0) } as unknown as Limits,
    downloadsOn: () => 1,
    reconcile: () => transfer.reconcile(),
    failDownload: (message, discard) => {
      if (state.status !== 'downloading') return
      failures.push({ message, discard })
      state.status = 'error'
      target.stop.abort()
      transfer.abort()
    },
    failNetwork: (network, message) => {
      network.status = 'failed'
      network.error = message
    },
    scheduleUpdate: () => {},
    getProxyForInterface: () => undefined
  }
  const ffmpeg = options.ffmpeg === undefined ? FFMPEG : options.ffmpeg
  const transfer: StreamTransfer = new StreamTransfer(target, host, {
    ffmpeg: async () =>
      ffmpeg
        ? { path: ffmpeg, source: 'override' }
        : {
            path: null,
            source: 'override',
            candidate: '/nowhere/ffmpeg',
            reason: 'FFmpeg was not found at /nowhere/ffmpeg (set by MERGELANE_FFMPEG_PATH).'
          },
    timeoutMs: options.timeoutMs ?? 3000,
    connectTimeoutMs: 2000,
    streamsPerNetwork: 2,
    retryDelayMs: 10
  })
  return {
    transfer,
    target,
    state,
    dir,
    failures,
    run: async () => {
      transfer.reconcile()
      // As the manager's run does: wait on its work, whatever else comes and goes.
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

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The segment's index in its playlist, from `seg003.ts`. */
const segmentIndex = (path: string): number => Number(/seg(\d+)\.ts$/.exec(path)?.[1] ?? -1)

test.describe('the stream transfer @smoke', () => {
  test.skip(FFMPEG === null, NO_FFMPEG)
  let server: StreamServer
  test.beforeEach(async () => {
    server = await new StreamServer(await streamMedia()).start()
  })
  test.afterEach(async () => server.stop())

  test('fetches an HLS stream over two networks and joins video and audio', async () => {
    const h = await harness({
      url: server.url(PATHS.master),
      protocol: 'hls',
      interfaces: [loopback('a'), loopback('b')]
    })
    await h.run()
    expect(h.failures).toEqual([])
    const output = h.target.file.output!
    expect(output).toBe(h.state.destinationPath)
    expect(output.endsWith('Talk.mp4')).toBe(true)
    const media = await inspect(output)
    expect(media.video).toEqual(['h264'])
    expect(media.audio).toEqual(['aac'])
    expect(media.size).toBe('320x240')
    expect(media.duration).toBeGreaterThan(SECONDS - 1)
    // Every segment in, attributed to the networks that fetched it: both did.
    expect(h.state.blocks.every((block) => block.status === 'completed')).toBe(true)
    expect(h.state.networks.map((network) => network.bytesDownloaded > 0)).toEqual([true, true])
    expect(h.state.totalBytes).toBe(h.state.bytesDownloaded)
    expect(h.state.muxing).toBeUndefined()
    expect(h.state.streams.every((stream) => stream.status === 'completed')).toBe(true)
    expect(h.state.peakStreams).toBeGreaterThan(1)
    // Only the chosen variant's segments.
    expect(server.segments().every((entry) => !entry.path.includes('/v120/'))).toBe(true)
    // Published where FFmpeg put it; the staging folder goes after.
    expect(await h.target.file.publish(output, 0, async () => {})).toBe(output)
    await h.target.file.discardLeftover()
    expect(await readdir(h.dir)).toEqual(['Talk.mp4'])
  })

  test('fetches the DASH representation asked for', async () => {
    const h = await harness({ url: server.url(PATHS.mpd), protocol: 'dash', variantId: '1' })
    await h.run()
    expect(h.failures).toEqual([])
    const media = await inspect(h.target.file.output!)
    expect([media.video, media.audio, media.size]).toEqual([['h264'], ['aac'], '160x120'])
    const paths = server.segments().map((entry) => entry.path)
    expect(paths.some((path) => /\/(init|chunk)-0[-.]/.test(path))).toBe(false)
    expect(paths.filter((path) => /\/(init|chunk)-1[-.]/.test(path))).toHaveLength(9)
  })

  test('rewraps a stream of one track, in Matroska when its codecs are unknown', async () => {
    const h = await harness({
      url: server.url(PATHS.muxed),
      protocol: 'hls',
      take: (_id, bytes) => (bytes > 0 ? 1 : 0)
    })
    await h.run()
    expect(h.failures).toEqual([])
    expect(h.target.file.output!.endsWith('Talk.mkv')).toBe(true)
    const media = await inspect(h.target.file.output!)
    expect(media.format).toContain('matroska')
    expect([media.video.length, media.audio.length]).toEqual([1, 1])
  })

  test('without FFmpeg it fails at once, saying so, before fetching anything', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls', ffmpeg: null })
    const before = server.log.length
    await h.run()
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0].message).toContain('Mergelane needs FFmpeg')
    expect(h.failures[0].message).toContain('/nowhere/ffmpeg')
    expect(server.log.length).toBe(before)
  })

  test('paused, it keeps its finished segments: resumed, it fetches only the rest', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls' })
    server.hold = (path) => segmentIndex(path) >= 3
    h.transfer.reconcile()
    // Two requests per track (two per network, one network) held: segments 0–2 are saved.
    await waitFor(() => server.log.filter((entry) => entry.held && !entry.endedAt).length === 4)
    await h.pause()
    expect(h.failures).toEqual([])
    expect(h.state.streams.every((stream) => stream.status === 'paused')).toBe(true)
    // What was in flight starts over; what was in stays in.
    expect(h.state.blocks.filter((block) => block.status === 'completed')).toHaveLength(6)
    expect(h.state.blocks.some((block) => block.status === 'downloading')).toBe(false)

    const resumedAt = Date.now()
    server.release()
    h.resume()
    await h.run()
    expect(h.failures).toEqual([])
    const again = server
      .segments()
      .filter((entry) => entry.at >= resumedAt && segmentIndex(entry.path) < 3)
    expect(again).toEqual([])
    expect((await inspect(h.target.file.output!)).audio).toEqual(['aac'])
  })

  test('joined but not published, a run finishes without fetching again', async () => {
    const h = await harness({ url: server.url(PATHS.muxed), protocol: 'hls' })
    await h.run()
    const output = h.target.file.output!
    for (const block of h.state.blocks) block.status = 'pending'
    h.state.status = 'downloading'
    const before = server.log.length
    await h.run()
    expect(server.log.length).toBe(before)
    expect(h.target.file.output).toBe(output)
    expect(h.state.blocks.every((block) => block.status === 'completed')).toBe(true)
  })

  test('with every track saved, it only joins them', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls' })
    await h.run()
    const first = h.target.file.output!
    // As after a pause mid-join: the tracks are there, the file isn't.
    await rm(first)
    h.target.file.output = null
    const before = server.log.length
    h.state.status = 'downloading'
    await h.run()
    expect(server.log.length).toBe(before)
    expect(h.target.file.output).toBe(first)
  })

  test('a track saved by an earlier run isn’t fetched again', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls' })
    await mkdir(h.target.file.path, { recursive: true })
    await writeFile(h.target.file.trackPath('video'), 'x')
    await h.run()
    expect(server.segments().some((entry) => entry.path.includes('/v240/'))).toBe(false)
    // That fake track can't be joined: FFmpeg says so, and the download fails resumable.
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0].message).toContain('Mergelane couldn')
    expect(h.failures[0].discard).toBeUndefined()
  })

  test('a stream that changed since the download started can’t be resumed', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls' })
    const media = await readFile(join(await streamMedia(), 'hls/v240/index.m3u8'), 'utf-8')
    server.overrides.set('/hls/v240/index.m3u8', {
      type: 'application/vnd.apple.mpegurl',
      body: media.replace(/#EXTINF:[^\n]*\nseg007\.ts\n/, '')
    })
    await h.run()
    expect(h.failures).toEqual([
      {
        message: 'This video changed on the server since its download started. Start it again.',
        discard: true
      }
    ])
  })

  test('a segment the server refuses fails the download with its part number', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls' })
    server.overrides.set('/hls/audio/seg002.ts', { status: 404 })
    await h.run()
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0].message).toMatch(/^Part 3 of the stream could not be downloaded/)
    expect(h.state.networks[0].retries).toBeGreaterThan(0)
    expect(h.state.blocks.some((block) => block.status === 'downloading')).toBe(false)
  })

  test('a segment that goes silent is dropped and tried again', async () => {
    const h = await harness({ url: server.url(PATHS.master), protocol: 'hls', timeoutMs: 300 })
    server.overrides.set('/hls/audio/seg001.ts', {
      type: 'video/mp2t',
      headers: { 'content-length': '1000' },
      stallAfter: 'x'
    })
    await h.run()
    expect(h.failures[0].message).toContain('The server stopped sending.')
    expect(server.log.filter((entry) => entry.path === '/hls/audio/seg001.ts')).toHaveLength(4)
  })

  test('FFmpeg failing fails the download with its message', async () => {
    const dir = await scratch()
    const fake = join(dir, 'ffmpeg')
    await writeFile(fake, '#!/bin/sh\necho "broken" >&2\nexit 1\n', { mode: 0o755 })
    const h = await harness({ url: server.url(PATHS.muxed), protocol: 'hls', ffmpeg: fake })
    await h.run()
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0].message).toContain('FFmpeg reported an error')
    expect(h.target.file.output).toBeNull()
  })

  test('follows redirects, and stops at too many or at another scheme', async () => {
    server.overrides.set('/moved.m3u8', {
      status: 302,
      headers: { location: PATHS.muxed }
    })
    const moved = await harness({ url: server.url('/moved.m3u8'), protocol: 'hls' })
    await moved.run()
    expect(moved.failures).toEqual([])

    const loop = await harness({ url: server.url('/moved.m3u8'), protocol: 'hls' })
    server.overrides.set('/moved.m3u8', { status: 302, headers: { location: '/moved.m3u8' } })
    await loop.run()
    expect(loop.failures[0].message).toContain('redirected more than 10 times')

    const ftp = await harness({ url: server.url(PATHS.muxed), protocol: 'hls' })
    server.overrides.set(PATHS.muxed, { status: 301, headers: { location: 'ftp://x.test/a' } })
    await ftp.run()
    expect(ftp.failures[0].message).toContain('only http and https')
  })

  test('a network that can’t reach the server is set aside; the others carry on', async () => {
    // The master's playlists go over both in turn: the one sent over v6 goes again over a.
    const h = await harness({
      url: server.url(PATHS.master),
      protocol: 'hls',
      interfaces: [loopback('a'), loopback('v6', '::1')]
    })
    await h.run()
    expect(h.failures).toEqual([])
    const [a, v6] = h.state.networks
    expect(a.bytesDownloaded).toBeGreaterThan(0)
    expect(v6.status).toBe('failed')
    expect(v6.error).toContain('No selected network has an address compatible')
  })

  test('waits for a network, and goes once one is on', async () => {
    const h = await harness({ url: server.url(PATHS.muxed), protocol: 'hls' })
    h.state.networks[0].status = 'offline'
    const before = server.log.length
    h.transfer.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.log).toHaveLength(before)
    h.state.networks[0].status = 'on'
    // A network coming back, a wake, the computer waking: each looks again.
    h.transfer.wake(
      () => true,
      () => false
    )
    h.transfer.systemResumed()
    h.transfer.tick()
    await h.run()
    expect(h.failures).toEqual([])
    expect(h.target.file.output).not.toBeNull()
  })

  test('stopped while waiting for a network, it stops at once', async () => {
    const h = await harness({ url: server.url(PATHS.muxed), protocol: 'hls' })
    h.state.networks[0].status = 'off'
    h.transfer.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.pause()
    expect(h.failures).toEqual([])
    expect([...h.transfer.running()]).toEqual([])
  })
})
