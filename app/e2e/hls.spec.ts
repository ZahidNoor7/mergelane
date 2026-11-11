// Layer B (Node only, no Electron): the HLS module in src/main/media/hls against RFC 8216 examples
// and local HTTP servers serving generated segments.

import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HlsError,
  HlsHttpError,
  HlsLimitError,
  HlsLiveStreamError,
  HlsPlaylistError,
  HlsProtectedStreamError,
  HlsSegmentError,
  HlsUnsupportedError,
  HlsVariantNotFoundError,
  MAX_SEGMENTS,
  assertDownloadable,
  createNodeFetch,
  downloadHls,
  downloadHlsTrack,
  fetchPlaylist,
  listVariants,
  nodeFetch,
  parseAttributeList,
  parsePlaylist,
  resolveHls,
  scopeHeaders,
  segmentRequests,
  selectAudioRendition,
  selectVariant,
  trackIdentity,
  type HlsFetch,
  type HlsFetchResponse,
  type HlsProgress,
  type MasterPlaylist,
  type MediaPlaylist
} from '../src/main/media/hls'

// ---------------------------------------------------------------------------------------------
// Helpers

const BASE = 'https://media.example.com/path/index.m3u8'

function media(text: string, url = BASE): MediaPlaylist {
  const playlist = parsePlaylist(text, url)
  if (playlist.kind !== 'media') throw new Error('expected a media playlist')
  return playlist
}

function master(text: string, url = BASE): MasterPlaylist {
  const playlist = parsePlaylist(text, url)
  if (playlist.kind !== 'master') throw new Error('expected a master playlist')
  return playlist
}

/** A media playlist from URI lines, each given EXTINF:<duration>. */
function vod(uris: string[], options: { duration?: number; head?: string[] } = {}): string {
  return [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    ...(options.head ?? []),
    ...uris.flatMap((uri) => [`#EXTINF:${options.duration ?? 4},`, uri]),
    '#EXT-X-ENDLIST'
  ].join('\n')
}

function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** Deterministic bytes for segment `seed`. */
function bytes(seed: number, length: number): Buffer {
  const data = Buffer.alloc(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + seed * 97 + 7) % 256
  return data
}

interface TestServer {
  origin: string
  /** Every request, in arrival order. */
  requests: { url: string; headers: IncomingMessage['headers'] }[]
  close: () => Promise<void>
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<TestServer> {
  const requests: TestServer['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** Sends `data`, honouring `Range: bytes=a-b` unless `ignoreRange`. */
function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  data: Buffer,
  ignoreRange = false
): void {
  const range = ignoreRange ? null : /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    const slice = data.subarray(start, end + 1)
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${data.length}`,
      'content-length': slice.length
    })
    res.end(slice)
    return
  }
  res.writeHead(200, { 'content-length': data.length })
  res.end(data)
}

function sendText(res: ServerResponse, text: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/vnd.apple.mpegurl' })
  res.end(text)
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mergelane-hls-'))
}

/** A fetch backed by a table of URL → response factory. */
function tableFetch(table: Record<string, () => HlsFetchResponse>): HlsFetch {
  return async (url) => {
    const make = table[url]
    if (!make) return { status: 404, body: iterate() }
    return make()
  }
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

async function* iterate(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

// ---------------------------------------------------------------------------------------------

test.describe('HLS module @smoke', () => {
  test.describe('parsing RFC 8216 examples', () => {
    test('§8.1 simple media playlist', () => {
      const playlist = media(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:10',
          '#EXT-X-VERSION:3',
          '#EXTINF:9.009,',
          'http://media.example.com/first.ts',
          '#EXTINF:9.009,',
          'http://media.example.com/second.ts',
          '#EXTINF:3.003,',
          'http://media.example.com/third.ts',
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      expect(playlist.version).toBe(3)
      expect(playlist.targetDuration).toBe(10)
      expect(playlist.mediaSequence).toBe(0)
      expect(playlist.endList).toBe(true)
      expect(playlist.segments.map((s) => [s.uri, s.duration, s.sequence])).toEqual([
        ['http://media.example.com/first.ts', 9.009, 0],
        ['http://media.example.com/second.ts', 9.009, 1],
        ['http://media.example.com/third.ts', 3.003, 2]
      ])
      expect(playlist.duration).toBeCloseTo(21.021, 6)
      expect(() => assertDownloadable(playlist)).not.toThrow()
    })

    test('§8.2 live media playlist: parsed, then refused as live', () => {
      const playlist = media(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:8',
          '#EXT-X-MEDIA-SEQUENCE:2680',
          '',
          '#EXTINF:7.975,',
          'https://priv.example.com/fileSequence2680.ts',
          '#EXTINF:7.941,',
          'https://priv.example.com/fileSequence2681.ts',
          '#EXTINF:7.975,',
          'https://priv.example.com/fileSequence2682.ts'
        ].join('\r\n')
      )
      expect(playlist.mediaSequence).toBe(2680)
      expect(playlist.segments.map((s) => s.sequence)).toEqual([2680, 2681, 2682])
      expect(playlist.endList).toBe(false)
      const error = thrown(() => assertDownloadable(playlist))
      expect(error).toBeInstanceOf(HlsLiveStreamError)
      expect((error as HlsError).code).toBe('live-stream')
      expect((error as Error).message).toMatch(/live stream/)
    })

    test('§8.3 encrypted media segments are refused, not decrypted', () => {
      const text = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA-SEQUENCE:7794',
        '#EXT-X-TARGETDURATION:15',
        '',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"',
        '',
        '#EXTINF:2.833,',
        'http://media.example.com/fileSequence52-A.ts',
        '#EXTINF:15.0,',
        'http://media.example.com/fileSequence52-B.ts',
        '#EXT-X-ENDLIST'
      ].join('\n')
      const error = thrown(() => parsePlaylist(text, BASE))
      expect(error).toBeInstanceOf(HlsProtectedStreamError)
      expect((error as HlsError).code).toBe('protected-stream')
      expect((error as Error).message).toBe(
        "This stream is protected (encrypted with AES-128). Mergelane doesn't download protected streams."
      )
    })

    test('§8.4 master playlist', () => {
      const playlist = master(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000',
          'http://example.com/low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2560000,AVERAGE-BANDWIDTH=2000000',
          'http://example.com/mid.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=7680000,AVERAGE-BANDWIDTH=6000000',
          'http://example.com/hi.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5"',
          'http://example.com/audio-only.m3u8'
        ].join('\n')
      )
      expect(playlist.variants.map((v) => [v.id, v.uri, v.bandwidth, v.averageBandwidth])).toEqual([
        ['v0', 'http://example.com/low.m3u8', 1280000, 1000000],
        ['v1', 'http://example.com/mid.m3u8', 2560000, 2000000],
        ['v2', 'http://example.com/hi.m3u8', 7680000, 6000000],
        ['v3', 'http://example.com/audio-only.m3u8', 65000, undefined]
      ])
      expect(playlist.variants[3].codecs).toEqual(['mp4a.40.5'])
      expect(selectVariant(playlist).variant.uri).toBe('http://example.com/hi.m3u8')
    })

    test('§8.5 master playlist with I-frames: relative URIs, I-frame streams skipped', () => {
      const playlist = master(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
          'low/audio-video.m3u8',
          '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="low/iframe.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=2560000',
          'mid/audio-video.m3u8',
          '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=150000,URI="mid/iframe.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=7680000',
          'hi/audio-video.m3u8',
          '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=550000,URI="hi/iframe.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5"',
          'audio-only.m3u8'
        ].join('\n'),
        'https://cdn.example.com/show/master.m3u8'
      )
      expect(playlist.variants.map((v) => v.uri)).toEqual([
        'https://cdn.example.com/show/low/audio-video.m3u8',
        'https://cdn.example.com/show/mid/audio-video.m3u8',
        'https://cdn.example.com/show/hi/audio-video.m3u8',
        'https://cdn.example.com/show/audio-only.m3u8'
      ])
    })

    const alternativeAudio = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="main/english-audio.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="de",URI="main/german-audio.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Commentary",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="en",URI="commentary/audio-only.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="...",AUDIO="aac"',
      'low/video-only.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000,CODECS="...",AUDIO="aac"',
      'mid/video-only.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=7680000,CODECS="...",AUDIO="aac"',
      'hi/video-only.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5",AUDIO="aac"',
      'main/english-audio.m3u8'
    ].join('\n')

    test('§8.6 master playlist with alternative audio: default rendition chosen', () => {
      const playlist = master(alternativeAudio, 'https://example.com/master.m3u8')
      expect(playlist.renditions.map((r) => [r.name, r.language, r.default, r.autoselect])).toEqual(
        [
          ['English', 'en', true, true],
          ['Deutsch', 'de', false, true],
          ['Commentary', 'en', false, false]
        ]
      )
      const selected = selectVariant(playlist)
      expect(selected.variant.uri).toBe('https://example.com/hi/video-only.m3u8')
      expect(selected.audio?.uri).toBe('https://example.com/main/english-audio.m3u8')
      expect(selected.audio?.groupId).toBe('aac')
    })

    test('§8.7 master playlist with alternative video renditions', () => {
      const playlist = master(
        [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="low",NAME="Main",DEFAULT=YES,URI="low/main/audio-video.m3u8"',
          '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="low",NAME="Centerfield",DEFAULT=NO,URI="low/centerfield/audio-video.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="...",VIDEO="low"',
          'low/main/audio-video.m3u8'
        ].join('\n'),
        'https://example.com/master.m3u8'
      )
      expect(playlist.renditions.map((r) => [r.type, r.name, r.default, r.autoselect])).toEqual([
        ['VIDEO', 'Main', true, true],
        ['VIDEO', 'Centerfield', false, false]
      ])
      expect(playlist.variants[0].videoGroup).toBe('low')
      // No AUDIO attribute: the audio is inside the video renditions.
      expect(selectVariant(playlist).audio).toBeUndefined()
    })

    test('§8.9 CHARACTERISTICS with commas inside the quoted string', () => {
      const attributes = parseAttributeList(
        'TYPE=SUBTITLES,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.easy-to-read",NAME="English"'
      )
      expect(attributes.get('CHARACTERISTICS')).toBe(
        'public.accessibility.transcribes-spoken-dialog,public.easy-to-read'
      )
      expect(attributes.get('NAME')).toBe('English')
    })
  })

  test.describe('attribute lists (§4.2)', () => {
    test('quoted strings keep commas and equals signs; other values are as written', () => {
      const attributes = parseAttributeList(
        'BANDWIDTH=1280000,CODECS="mp4a.40.2,avc1.4d401e",RESOLUTION=1280x720,URI="a.m3u8?x=1&y=2",IV=0x9c7db8778570d05c3177c349fd9236aa,NAME=""'
      )
      expect([...attributes.entries()]).toEqual([
        ['BANDWIDTH', '1280000'],
        ['CODECS', 'mp4a.40.2,avc1.4d401e'],
        ['RESOLUTION', '1280x720'],
        ['URI', 'a.m3u8?x=1&y=2'],
        ['IV', '0x9c7db8778570d05c3177c349fd9236aa'],
        ['NAME', '']
      ])
    })

    test('tolerates spaces between pairs and a trailing comma', () => {
      const attributes = parseAttributeList('A=1, B="two, three" ,C=4,')
      expect([...attributes.entries()]).toEqual([
        ['A', '1'],
        ['B', 'two, three'],
        ['C', '4']
      ])
      expect(parseAttributeList('').size).toBe(0)
    })

    test('refuses malformed lists', () => {
      const cases: [string, RegExp][] = [
        ['A=1,A=2', /appears twice/],
        ['lower=1', /not a valid attribute name/],
        ['A="unclosed', /unclosed quote/],
        ['A=1,B', /has no value/],
        ['A="x"y', /unexpected text after attribute A/]
      ]
      for (const [input, message] of cases) {
        const error = thrown(() => parseAttributeList(input, 7))
        expect(error, input).toBeInstanceOf(HlsPlaylistError)
        expect((error as Error).message, input).toMatch(message)
        expect((error as HlsPlaylistError).line, input).toBe(7)
      }
    })

    test('a duplicated attribute inside a playlist fails the parse', () => {
      const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2\nv.m3u8'
      const error = thrown(() => parsePlaylist(text, BASE))
      expect(error).toBeInstanceOf(HlsPlaylistError)
      expect((error as Error).message).toMatch(/line 2/)
    })
  })

  test.describe('URIs (§4.1)', () => {
    test('relative URIs resolve against the playlist URL', () => {
      const playlist = media(
        vod(
          [
            'seg1.ts',
            '../other/seg2.ts',
            '/root/seg3.ts',
            '//cdn2.example.com/seg4.ts',
            'https://abs.example.com/seg5.ts',
            'seg6.ts?token=abc'
          ],
          { head: ['#EXT-X-MAP:URI="init.mp4"'] }
        ),
        'https://cdn.example.com/a/b/index.m3u8?sig=1'
      )
      expect(playlist.segments.map((s) => s.uri)).toEqual([
        'https://cdn.example.com/a/b/seg1.ts',
        'https://cdn.example.com/a/other/seg2.ts',
        'https://cdn.example.com/root/seg3.ts',
        'https://cdn2.example.com/seg4.ts',
        'https://abs.example.com/seg5.ts',
        'https://cdn.example.com/a/b/seg6.ts?token=abc'
      ])
      expect(playlist.segments[0].init?.uri).toBe('https://cdn.example.com/a/b/init.mp4')
    })

    test('non-HTTP URIs and invalid URLs are refused', () => {
      expect(thrown(() => parsePlaylist(vod(['file:///etc/passwd']), BASE))).toBeInstanceOf(
        HlsUnsupportedError
      )
      expect(thrown(() => parsePlaylist(vod(['http://[broken']), BASE))).toBeInstanceOf(
        HlsPlaylistError
      )
      expect(thrown(() => parsePlaylist(vod(['a.ts']), 'not a url'))).toBeInstanceOf(
        HlsPlaylistError
      )
    })
  })

  test.describe('byte ranges and init sections', () => {
    test('EXT-X-BYTERANGE with and without offsets (§4.3.2.2)', () => {
      const playlist = media(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:4',
          '#EXT-X-TARGETDURATION:10',
          '#EXTINF:10,',
          '#EXT-X-BYTERANGE:75232@0',
          'segment.ts',
          '#EXT-X-BYTERANGE:82112',
          '#EXTINF:10,',
          'segment.ts',
          '#EXTINF:10,',
          '#EXT-X-BYTERANGE:69864@500000',
          'segment.ts',
          '#EXTINF:10,',
          'whole.ts',
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      expect(playlist.segments.map((s) => s.byteRange)).toEqual([
        { offset: 0, length: 75232 },
        { offset: 75232, length: 82112 },
        { offset: 500000, length: 69864 },
        undefined
      ])
      expect(segmentRequests(playlist).map((r) => r.range)).toEqual([
        { start: 0, end: 75231 },
        { start: 75232, end: 157343 },
        { start: 500000, end: 569863 },
        undefined
      ])
    })

    test('an offset-less range needs a previous range of the same resource', () => {
      const first = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:1,', '#EXT-X-BYTERANGE:10']
      expect(thrown(() => parsePlaylist([...first, 'a.ts'].join('\n'), BASE))).toBeInstanceOf(
        HlsPlaylistError
      )
      const other = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:1,',
        '#EXT-X-BYTERANGE:10@0',
        'a.ts',
        '#EXTINF:1,',
        '#EXT-X-BYTERANGE:10',
        'b.ts'
      ]
      const error = thrown(() => parsePlaylist(other.join('\n'), BASE))
      expect((error as Error).message).toMatch(/§4\.3\.2\.2.*line 8/)
      for (const bad of ['abc', '0@10', '5@x']) {
        const text = [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:10',
          '#EXTINF:1,',
          `#EXT-X-BYTERANGE:${bad}`
        ]
        expect(
          thrown(() => parsePlaylist([...text, 'a.ts'].join('\n'), BASE)),
          bad
        ).toBeInstanceOf(HlsPlaylistError)
      }
    })

    test('EXT-X-MAP initialization sections (§4.3.2.5)', () => {
      const playlist = media(
        vod(['a.m4s', 'b.m4s'], {
          head: ['#EXT-X-VERSION:6', '#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"']
        })
      )
      expect(playlist.segments.map((s) => s.init)).toEqual([
        { uri: 'https://media.example.com/path/main.mp4', byteRange: { offset: 0, length: 720 } },
        { uri: 'https://media.example.com/path/main.mp4', byteRange: { offset: 0, length: 720 } }
      ])
      expect(segmentRequests(playlist).map((r) => [r.kind, r.index, r.range])).toEqual([
        ['init', 0, { start: 0, end: 719 }],
        ['media', 1, undefined],
        ['media', 2, undefined]
      ])
      expect(
        thrown(() => parsePlaylist(vod(['a.m4s'], { head: ['#EXT-X-MAP:BYTERANGE="1@0"'] }), BASE))
      ).toBeInstanceOf(HlsPlaylistError)
      const noOffset = thrown(() =>
        parsePlaylist(vod(['a.m4s'], { head: ['#EXT-X-MAP:URI="i.mp4",BYTERANGE="720"'] }), BASE)
      )
      expect((noOffset as Error).message).toMatch(/BYTERANGE has no offset/)
    })

    test('a repeated identical EXT-X-MAP is fine; a changing one is unsupported', () => {
      const repeated = media(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:10',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4,',
          'a.m4s',
          '#EXT-X-DISCONTINUITY',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4,',
          'b.m4s',
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      expect(repeated.segments.map((s) => s.discontinuity)).toEqual([false, true])
      expect(() => assertDownloadable(repeated)).not.toThrow()

      const changing = media(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:10',
          '#EXT-X-MAP:URI="init-a.mp4"',
          '#EXTINF:4,',
          'a.m4s',
          '#EXT-X-MAP:URI="init-b.mp4"',
          '#EXTINF:4,',
          'b.m4s',
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      expect(thrown(() => assertDownloadable(changing))).toBeInstanceOf(HlsUnsupportedError)
    })
  })

  test.describe('playlist structure', () => {
    test('the header, BOM, comments, titles and unknown tags', () => {
      const playlist = media(
        '﻿#EXTM3U\n# a comment\n#EXT-X-TARGETDURATION:10\n#EXT-X-UNKNOWN-TAG:FOO=1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:5,Intro\na.ts\n#EXTINF:6\nb.ts\n#EXT-X-ENDLIST\n'
      )
      expect(playlist.playlistType).toBe('VOD')
      expect(playlist.segments.map((s) => [s.duration, s.title])).toEqual([
        [5, 'Intro'],
        [6, undefined]
      ])
      expect(media(vod(['a.ts'], { head: ['#EXT-X-PLAYLIST-TYPE:EVENT'] })).playlistType).toBe(
        'EVENT'
      )
      // §6.3.1: an unrecognised enumerated-string value means the tag is ignored.
      expect(media(vod(['a.ts'], { head: ['#EXT-X-PLAYLIST-TYPE:LIVE'] })).playlistType).toBe(
        undefined
      )
      expect(thrown(() => parsePlaylist('', BASE))).toBeInstanceOf(HlsPlaylistError)
      expect((thrown(() => parsePlaylist('<html></html>', BASE)) as Error).message).toMatch(
        /does not start with #EXTM3U/
      )
    })

    test('invalid media playlists fail to parse', () => {
      const cases: [string, RegExp][] = [
        ['#EXTM3U\n#EXT-X-TARGETDURATION:10\na.ts', /no #EXTINF/],
        ['#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:4,\na.ts\n#EXTINF:4,', /segment tags/],
        ['#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', /TARGETDURATION is missing/],
        ['#EXTM3U\n#EXT-X-TARGETDURATION:x\n#EXTINF:4,\na.ts', /not a whole number/],
        ['#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:-1,\na.ts', /not a number/],
        [
          '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-TARGETDURATION:10\n#EXTINF:4,\na.ts',
          /appears twice/
        ],
        ['#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1', /appears twice/],
        [
          '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:4,\na.ts\n#EXT-X-MEDIA-SEQUENCE:5',
          /MEDIA-SEQUENCE comes after/
        ],
        [
          '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8',
          /mixes master playlist and media playlist tags/
        ]
      ]
      for (const [text, message] of cases) {
        const error = thrown(() => parsePlaylist(text, BASE))
        expect(error, text).toBeInstanceOf(HlsPlaylistError)
        expect((error as HlsError).code, text).toBe('invalid-playlist')
        expect((error as Error).message, text).toMatch(message)
      }
    })

    test('invalid master playlists fail to parse', () => {
      const cases: [string, RegExp][] = [
        ['#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1x1\nv.m3u8', /no BANDWIDTH/],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv.m3u8', /line 2/],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1', /no URI line after it/],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\nloose.m3u8', /does not follow/],
        ['#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x"', /lists no streams/],
        ['#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv', /NAME/],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=wide\nv.m3u8', /WIDTHxHEIGHT/],
        ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,FRAME-RATE=fast\nv.m3u8', /not a number/]
      ]
      for (const [text, message] of cases) {
        const error = thrown(() => parsePlaylist(text, BASE))
        expect(error, text).toBeInstanceOf(HlsPlaylistError)
        expect((error as Error).message, text).toMatch(message)
      }
    })

    test('master attributes: resolution, frame rate, groups, HDCP, renditions', () => {
      const playlist = master(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:4',
          '#EXT-X-INDEPENDENT-SEGMENTS',
          '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Example"',
          '#EXT-X-SESSION-KEY:METHOD=NONE',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",CHANNELS="2",URI="a.m3u8"',
          '#EXT-X-MEDIA:TYPE=FUTURE,GROUP-ID="x",NAME="ignored"',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Odd",DEFAULT=MAYBE',
          '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="s.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028, mp4a.40.2",AUDIO="aud",SUBTITLES="subs",HDCP-LEVEL=NONE',
          'v1080.m3u8'
        ].join('\n')
      )
      expect(playlist.version).toBe(4)
      expect(playlist.variants[0]).toEqual({
        id: 'v0',
        uri: 'https://media.example.com/path/v1080.m3u8',
        bandwidth: 5000000,
        codecs: ['avc1.640028', 'mp4a.40.2'],
        resolution: { width: 1920, height: 1080 },
        frameRate: 29.97,
        audioGroup: 'aud',
        subtitlesGroup: 'subs',
        hdcpLevel: 'NONE'
      })
      expect(playlist.renditions.map((r) => [r.type, r.name, r.channels])).toEqual([
        ['AUDIO', 'Main', '2'],
        ['SUBTITLES', 'English', undefined]
      ])
    })

    test('I-frame-only and empty playlists cannot be downloaded', () => {
      const iframes = media(vod(['a.ts'], { head: ['#EXT-X-I-FRAMES-ONLY'] }))
      expect(iframes.iFramesOnly).toBe(true)
      expect(thrown(() => assertDownloadable(iframes))).toBeInstanceOf(HlsUnsupportedError)
      const empty = media('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-ENDLIST')
      expect(thrown(() => assertDownloadable(empty))).toBeInstanceOf(HlsPlaylistError)
    })
  })

  test.describe('refusals', () => {
    test('any EXT-X-KEY method other than NONE is refused (§4.3.2.4, §6.3.6)', () => {
      expect(() => media(vod(['a.ts'], { head: ['#EXT-X-KEY:METHOD=NONE'] }))).not.toThrow()
      const keys = [
        [
          'METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"',
          /SAMPLE-AES/
        ],
        ['METHOD=AES-128,URI="k",KEYFORMAT="unknown.format"', /AES-128/],
        ['METHOD=SOMETHING-NEW,URI="k"', /SOMETHING-NEW/],
        ['URI="k"', /unnamed method/]
      ] as const
      for (const [attributes, message] of keys) {
        const error = thrown(() =>
          parsePlaylist(vod(['a.ts'], { head: [`#EXT-X-KEY:${attributes}`] }), BASE)
        )
        expect(error, attributes).toBeInstanceOf(HlsProtectedStreamError)
        expect((error as Error).message, attributes).toMatch(message)
        expect((error as Error).message).toMatch(/Mergelane doesn't download protected streams/)
      }
    })

    test('a key that only applies after the segments is still refused', () => {
      const text = vod(['a.ts']).replace(
        '#EXT-X-ENDLIST',
        '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXT-X-ENDLIST'
      )
      expect(thrown(() => parsePlaylist(text, BASE))).toBeInstanceOf(HlsProtectedStreamError)
    })

    test('EXT-X-SESSION-KEY in a master playlist is refused (§4.3.4.5)', () => {
      const text =
        '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8'
      expect(thrown(() => parsePlaylist(text, BASE))).toBeInstanceOf(HlsProtectedStreamError)
    })

    test(`more than ${MAX_SEGMENTS} segments are refused`, () => {
      const uris = (count: number): string[] => Array.from({ length: count }, (_, i) => `s${i}.ts`)
      expect(media(vod(uris(MAX_SEGMENTS))).segments).toHaveLength(MAX_SEGMENTS)
      const error = thrown(() => parsePlaylist(vod(uris(MAX_SEGMENTS + 1)), BASE))
      expect(error).toBeInstanceOf(HlsLimitError)
      expect((error as HlsLimitError).limit).toBe('segments')
      expect((error as Error).message).toMatch(/more than 20,000 segments/)
    })

    test('error messages hide query strings and name the status', () => {
      const error = new HlsHttpError(503, 'https://cdn.example.com/a/seg.ts?token=secret')
      expect(error.message).toBe('The server answered HTTP 503 for cdn.example.com/a/seg.ts.')
      expect(error.transient).toBe(true)
      expect(new HlsHttpError(429, 'x').transient).toBe(true)
      expect(new HlsHttpError(408, 'x').transient).toBe(true)
      expect(new HlsHttpError(404, 'x').transient).toBe(false)
      expect(new HlsHttpError(404, 'not a url').message).toMatch(/for the server/)
      const segment = new HlsSegmentError(2, 'https://a.example/s.ts?sig=1', 'boom')
      expect(segment.message).toBe(
        'Part 3 of the stream could not be downloaded from a.example/s.ts: boom'
      )
      expect(segment.name).toBe('HlsSegmentError')
    })
  })

  test.describe('variant selection', () => {
    const ladder = master(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="First",URI="a1-first.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Auto",AUTOSELECT=YES,URI="a1-auto.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a2",NAME="Only",URI="a2.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a3",NAME="Muxed",DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
        '360.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="a2"',
        '720-low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="a3"',
        '720-high.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="missing"',
        '1080.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,HDCP-LEVEL=TYPE-0',
        '2160.m3u8'
      ].join('\n'),
      'https://example.com/master.m3u8'
    )

    test('lists variants for a picker, best first, without HDCP-only ones', () => {
      expect(listVariants(ladder)).toEqual([
        {
          id: 'v3',
          bandwidth: 6000000,
          resolution: { width: 1920, height: 1080 },
          separateAudio: false
        },
        {
          id: 'v2',
          bandwidth: 3000000,
          resolution: { width: 1280, height: 720 },
          separateAudio: false
        },
        {
          id: 'v1',
          bandwidth: 2500000,
          resolution: { width: 1280, height: 720 },
          separateAudio: true
        },
        {
          id: 'v0',
          bandwidth: 800000,
          resolution: { width: 640, height: 360 },
          separateAudio: true
        }
      ])
    })

    test('defaults to the highest bandwidth that needs no HDCP', () => {
      const { variant, audio } = selectVariant(ladder)
      expect(variant.id).toBe('v3')
      // The AUDIO group names no EXT-X-MEDIA tag.
      expect(audio).toBeUndefined()
    })

    test('by id, including an unknown id', () => {
      expect(selectVariant(ladder, { id: 'v0' }).variant.uri).toBe('https://example.com/360.m3u8')
      const error = thrown(() => selectVariant(ladder, { id: 'v9' }))
      expect(error).toBeInstanceOf(HlsVariantNotFoundError)
      expect((error as HlsVariantNotFoundError).variantId).toBe('v9')
      // The HDCP-only variant exists but can't be picked.
      expect(thrown(() => selectVariant(ladder, { id: 'v4' }))).toBeInstanceOf(
        HlsVariantNotFoundError
      )
    })

    test('by height: exact (best bandwidth), else below, else above', () => {
      expect(selectVariant(ladder, { height: 720 }).variant.id).toBe('v2')
      expect(selectVariant(ladder, { height: 900 }).variant.id).toBe('v2')
      expect(selectVariant(ladder, { height: 1440 }).variant.id).toBe('v3')
      expect(selectVariant(ladder, { height: 240 }).variant.id).toBe('v0')
      const unsized = master(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb'
      )
      expect(selectVariant(unsized, { height: 720 }).variant.id).toBe('v1')
    })

    test('audio: DEFAULT, else AUTOSELECT, else the first; none without a group', () => {
      expect(selectAudioRendition(ladder, ladder.variants[0])?.name).toBe('Auto')
      expect(selectAudioRendition(ladder, ladder.variants[1])?.name).toBe('Only')
      const muxed = selectVariant(ladder, { id: 'v2' }).audio
      expect(muxed?.name).toBe('Muxed')
      expect(muxed?.uri).toBeUndefined()
      expect(selectAudioRendition(ladder, ladder.variants[4])).toBeUndefined()
    })

    test('a stream where every variant needs HDCP is refused', () => {
      const protectedOnly = master(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,HDCP-LEVEL=TYPE-0\nv.m3u8'
      )
      const error = thrown(() => selectVariant(protectedOnly))
      expect(error).toBeInstanceOf(HlsProtectedStreamError)
      expect((error as Error).message).toMatch(/HDCP/)
      expect(thrown(() => listVariants(protectedOnly))).toBeInstanceOf(HlsProtectedStreamError)
    })
  })

  test.describe('resolving playlists over HTTP', () => {
    test('master → variant and audio rendition, relative to the final URL after a redirect', async () => {
      const server = await startServer((req, res) => {
        switch (req.url) {
          case '/start.m3u8':
            res.writeHead(302, { location: '/hls/master.m3u8' })
            return res.end()
          case '/hls/master.m3u8':
            return sendText(
              res,
              [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,AUDIO="aac"',
                'video/low.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1920x1080,AUDIO="aac"',
                'video/high.m3u8'
              ].join('\n')
            )
          case '/hls/video/high.m3u8':
          case '/hls/video/low.m3u8':
            return sendText(res, vod(['v0.ts', 'v1.ts']))
          case '/hls/audio/en.m3u8':
            return sendText(res, vod(['a0.aac']))
          default:
            return sendText(res, 'missing', 404)
        }
      })
      try {
        const resolved = await resolveHls(`${server.origin}/start.m3u8`)
        expect(resolved.source).toBe(`${server.origin}/start.m3u8`)
        expect(resolved.variant?.id).toBe('v1')
        expect(resolved.variants.map((v) => v.id)).toEqual(['v1', 'v0'])
        expect(resolved.video.segments.map((s) => s.uri)).toEqual([
          `${server.origin}/hls/video/v0.ts`,
          `${server.origin}/hls/video/v1.ts`
        ])
        expect(resolved.audioRendition?.name).toBe('English')
        expect(resolved.audio?.segments[0].uri).toBe(`${server.origin}/hls/audio/a0.aac`)

        const low = await resolveHls(`${server.origin}/start.m3u8`, { variant: { height: 360 } })
        expect(low.video.url).toBe(`${server.origin}/hls/video/low.m3u8`)

        const direct = await resolveHls(`${server.origin}/hls/video/low.m3u8`)
        expect(direct.variants).toEqual([])
        expect(direct.master).toBeUndefined()
        expect(direct.audio).toBeUndefined()
      } finally {
        await server.close()
      }
    })

    test('live and encrypted media playlists are refused before any segment is fetched', async () => {
      const server = await startServer((req, res) => {
        if (req.url === '/live.m3u8')
          return sendText(res, vod(['a.ts']).replace('#EXT-X-ENDLIST', ''))
        if (req.url === '/master.m3u8') {
          return sendText(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlocked.m3u8')
        }
        if (req.url === '/locked.m3u8') {
          return sendText(res, vod(['a.ts'], { head: ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'] }))
        }
        sendText(res, 'nope', 404)
      })
      try {
        expect(await rejection(resolveHls(`${server.origin}/live.m3u8`))).toBeInstanceOf(
          HlsLiveStreamError
        )
        expect(await rejection(resolveHls(`${server.origin}/master.m3u8`))).toBeInstanceOf(
          HlsProtectedStreamError
        )
        const missing = await rejection(resolveHls(`${server.origin}/gone.m3u8`))
        expect(missing).toBeInstanceOf(HlsHttpError)
        expect((missing as HlsHttpError).status).toBe(404)
        expect(server.requests.map((r) => r.url)).toEqual([
          '/live.m3u8',
          '/master.m3u8',
          '/locked.m3u8',
          '/gone.m3u8'
        ])
      } finally {
        await server.close()
      }
    })

    test('masters nested more than 3 deep are refused', async () => {
      // m0 → m1 → … are masters; m<depth> is the media playlist.
      const levels = (depth: number): HlsFetch => {
        const table: Record<string, () => HlsFetchResponse> = {}
        for (let i = 0; i < depth; i++) {
          const text = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nm${i + 1}.m3u8`
          table[`https://x.test/m${i}.m3u8`] = () => ({
            status: 200,
            body: iterate(Buffer.from(text))
          })
        }
        table[`https://x.test/m${depth}.m3u8`] = () => ({
          status: 200,
          body: iterate(Buffer.from(vod(['s.ts'])))
        })
        return tableFetch(table)
      }
      const ok = await resolveHls('https://x.test/m0.m3u8', {
        fetch: levels(3),
        variant: { height: 720 }
      })
      expect(ok.video.url).toBe('https://x.test/m3.m3u8')
      expect(ok.variant?.uri).toBe('https://x.test/m1.m3u8')
      const error = await rejection(resolveHls('https://x.test/m0.m3u8', { fetch: levels(4) }))
      expect(error).toBeInstanceOf(HlsLimitError)
      expect((error as HlsLimitError).limit).toBe('nesting')
    })

    test('an audio-only variant that is also the audio rendition is one track (§8.6)', async () => {
      const fetch = tableFetch({
        'https://example.com/master.m3u8': () => ({
          status: 200,
          body: iterate(Buffer.from(alternativeAudioText()))
        }),
        'https://example.com/main/english-audio.m3u8': () => ({
          status: 200,
          body: iterate(Buffer.from(vod(['en.aac'])))
        })
      })
      const resolved = await resolveHls('https://example.com/master.m3u8', {
        fetch,
        variant: { id: 'v3' }
      })
      expect(resolved.video.url).toBe('https://example.com/main/english-audio.m3u8')
      expect(resolved.audio).toBeUndefined()
      expect(resolved.audioRendition).toBeUndefined()
    })

    test('an audio rendition that points at a master playlist is invalid', async () => {
      const fetch = tableFetch({
        'https://x.test/master.m3u8': () => ({
          status: 200,
          body: iterate(
            Buffer.from(
              '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="n",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nvideo.m3u8'
            )
          )
        }),
        'https://x.test/video.m3u8': () => ({
          status: 200,
          body: iterate(Buffer.from(vod(['v.ts'])))
        }),
        'https://x.test/audio.m3u8': () => ({
          status: 200,
          body: iterate(Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8'))
        })
      })
      const error = await rejection(resolveHls('https://x.test/master.m3u8', { fetch }))
      expect(error).toBeInstanceOf(HlsPlaylistError)
      expect((error as Error).message).toMatch(/audio rendition points at a master/)
    })

    test('playlist bodies: streams, size limit, UTF-8, discarded error bodies', async () => {
      const text = vod(['a.ts'])
      const fromStream = await fetchPlaylist('https://x.test/p.m3u8', {
        fetch: async () => ({
          status: 200,
          body: streamOf(Buffer.from(text.slice(0, 10)), Buffer.from(text.slice(10))),
          url: 'https://y.test/final.m3u8'
        })
      })
      expect(fromStream).toEqual({ text, url: 'https://y.test/final.m3u8' })

      const megabyte = new Uint8Array(1024 * 1024)
      const huge = await rejection(
        fetchPlaylist('https://x.test/p.m3u8', {
          fetch: async () => ({
            status: 200,
            body: (async function* () {
              for (let i = 0; i < 11; i++) yield megabyte
            })()
          })
        })
      )
      expect(huge).toBeInstanceOf(HlsLimitError)
      expect((huge as HlsLimitError).limit).toBe('playlist-size')

      const binary = await rejection(
        fetchPlaylist('https://x.test/p.m3u8', {
          fetch: async () => ({ status: 200, body: iterate(new Uint8Array([0x23, 0xff, 0xfe])) })
        })
      )
      expect((binary as Error).message).toMatch(/not UTF-8/)

      let cancelled = false
      const errorStream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        }
      })
      const failed = await rejection(
        fetchPlaylist('https://x.test/p.m3u8', {
          fetch: async () => ({ status: 500, body: errorStream })
        })
      )
      expect((failed as HlsHttpError).status).toBe(500)
      expect(cancelled).toBe(true)

      const brokenBody: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
          return: async () => {
            throw new Error('already gone')
          }
        })
      }
      const gone = await rejection(
        fetchPlaylist('https://x.test/p.m3u8', {
          fetch: async () => ({ status: 410, body: brokenBody })
        })
      )
      expect((gone as HlsHttpError).status).toBe(410)
    })
  })

  test.describe('HTTP client', () => {
    test('scopeHeaders drops credentials across origins, case-insensitively', () => {
      const headers = {
        Cookie: 'session=1',
        authorization: 'Bearer t',
        ORIGIN: 'https://page.example',
        Referer: 'https://page.example/watch',
        'User-Agent': 'Mergelane'
      }
      expect(scopeHeaders(headers, 'https://a.test/x', 'https://a.test/y')).toEqual(headers)
      expect(scopeHeaders(headers, 'https://a.test/x', 'https://b.test/y')).toEqual({
        Referer: 'https://page.example/watch',
        'User-Agent': 'Mergelane'
      })
      expect(scopeHeaders(headers, 'https://a.test/x', 'http://a.test/y')).not.toHaveProperty(
        'Cookie'
      )
      expect(scopeHeaders(headers, 'not a url', 'https://a.test/y')).not.toHaveProperty('Cookie')
    })

    test('follows redirects up to the limit, refuses other schemes, times out', async () => {
      const server = await startServer((req, res) => {
        const hop = /^\/hop\/(\d+)$/.exec(req.url ?? '')
        if (hop) {
          const left = Number(hop[1])
          res.writeHead(left % 2 ? 307 : 301, { location: left ? `/hop/${left - 1}` : '/final' })
          return res.end()
        }
        if (req.url === '/final') return sendText(res, 'done')
        if (req.url === '/silent') return // never answers
        sendText(res, 'nope', 404)
      })
      try {
        const ten = await nodeFetch(`${server.origin}/hop/9`, { headers: {} })
        expect(ten.status).toBe(200)
        expect(ten.url).toBe(`${server.origin}/final`)
        expect(ten.headers?.['content-type']).toBe('application/vnd.apple.mpegurl')
        let body = ''
        for await (const chunk of ten.body as AsyncIterable<Uint8Array>) body += Buffer.from(chunk)
        expect(body).toBe('done')

        const eleven = await rejection(nodeFetch(`${server.origin}/hop/10`, { headers: {} }))
        expect(eleven).toBeInstanceOf(HlsLimitError)
        expect((eleven as HlsLimitError).limit).toBe('redirects')

        const short = createNodeFetch({ maxRedirects: 1 })
        expect(await rejection(short(`${server.origin}/hop/2`, { headers: {} }))).toBeInstanceOf(
          HlsLimitError
        )

        expect(
          await rejection(nodeFetch('ftp://example.com/a.ts', { headers: {} }))
        ).toBeInstanceOf(HlsUnsupportedError)

        const impatient = createNodeFetch({ timeoutMs: 150 })
        const timeout = await rejection(impatient(`${server.origin}/silent`, { headers: {} }))
        expect((timeout as Error).message).toBe('The server stopped responding.')
      } finally {
        await server.close()
      }
    })
  })

  test.describe('downloading', () => {
    interface GeneratedTrack {
      playlist: string
      /** What the saved file must contain. */
      expected: Buffer
      /** The bytes served at `path`, if it is one of the track's. */
      body: (path: string) => Buffer | undefined
    }

    /** A generated track: `playlist` lists `count` segments seg<i>.ts (after init.mp4 when
     * `init`), segment i being `size + i` bytes. */
    function generatedTrack(count: number, size: number, init = false): GeneratedTrack {
      const segments = Array.from({ length: count }, (_, i) => bytes(i + 1, size + i))
      const initData = bytes(0, 100)
      const playlist = vod(
        segments.map((_, i) => `seg${i}.ts`),
        { head: init ? ['#EXT-X-MAP:URI="init.mp4"'] : [] }
      )
      const expected = Buffer.concat(init ? [initData, ...segments] : segments)
      const body = (path: string): Buffer | undefined => {
        if (path === '/init.mp4' && init) return initData
        const match = /^\/seg(\d+)\.ts$/.exec(path)
        return match ? segments[Number(match[1])] : undefined
      }
      return { playlist, expected, body }
    }

    test('saves init + segments as one file, with progress', async () => {
      const track = generatedTrack(6, 2000, true)
      const server = await startServer((req, res) => {
        if (req.url === '/track.m3u8') return sendText(res, track.playlist)
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const resolved = await resolveHls(`${server.origin}/track.m3u8`)
        const progress: HlsProgress[] = []
        const outputPath = join(dir, 'video.ts')
        const result = await downloadHlsTrack({
          playlist: resolved.video,
          outputPath,
          onProgress: (p) => progress.push(p)
        })
        expect(await readFile(outputPath)).toEqual(track.expected)
        expect(result).toEqual({
          outputPath,
          bytes: track.expected.length,
          segments: 7,
          resumedSegments: 0,
          identity: trackIdentity(segmentRequests(resolved.video))
        })
        expect(progress[0]).toEqual({
          bytesDone: 0,
          bytesTotalEstimate: null,
          segmentsDone: 0,
          segmentsTotal: 7
        })
        expect(progress.at(-1)).toEqual({
          bytesDone: track.expected.length,
          bytesTotalEstimate: track.expected.length,
          segmentsDone: 7,
          segmentsTotal: 7
        })
        // Once a segment has finished, the total is estimated from its bytes per second.
        expect(
          progress.some(
            (p) => p.segmentsDone > 0 && p.segmentsDone < 7 && p.bytesTotalEstimate !== null
          )
        ).toBe(true)
        // The init section was fetched once, and the work directory is gone.
        expect(server.requests.filter((r) => r.url === '/init.mp4')).toHaveLength(1)
        expect(await readdir(dir)).toEqual(['video.ts'])
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('byte ranges, including an init range, from servers that do and do not honour Range', async () => {
      const resource = bytes(42, 3000)
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MAP:URI="media.mp4",BYTERANGE="200@0"',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000@200',
        'media.mp4',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:800',
        'media.mp4',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000@2000',
        'media.mp4',
        '#EXT-X-ENDLIST'
      ].join('\n')
      for (const ignoreRange of [false, true]) {
        const server = await startServer((req, res) => {
          if (req.url === '/media.mp4') return sendBytes(req, res, resource, ignoreRange)
          sendText(res, 'missing', 404)
        })
        const dir = await scratch()
        try {
          const progress: HlsProgress[] = []
          const outputPath = join(dir, 'out.mp4')
          await downloadHlsTrack({
            playlist: media(playlist, `${server.origin}/index.m3u8`),
            outputPath,
            concurrency: 2,
            onProgress: (p) => progress.push(p)
          })
          expect(await readFile(outputPath), `ignoreRange=${ignoreRange}`).toEqual(resource)
          expect(server.requests.map((r) => r.headers.range)).toEqual(
            expect.arrayContaining([
              'bytes=0-199',
              'bytes=200-1199',
              'bytes=1200-1999',
              'bytes=2000-2999'
            ])
          )
          // Every size is known from the ranges, so the estimate is exact from the start.
          expect(progress.every((p) => p.bytesTotalEstimate === 3000)).toBe(true)
        } finally {
          await server.close()
          await rm(dir, { recursive: true, force: true })
        }
      }
    })

    test('respects the concurrency limit (configured and default)', async () => {
      const track = generatedTrack(12, 500)
      let active = 0
      let peak = 0
      const server = await startServer((req, res) => {
        const data = track.body(req.url ?? '')
        if (!data) return sendText(res, 'missing', 404)
        active++
        peak = Math.max(peak, active)
        let ended = false
        const end = (): void => {
          if (!ended) active--
          ended = true
        }
        res.on('finish', end)
        res.on('close', end)
        setTimeout(() => sendBytes(req, res, data), 40)
      })
      const dir = await scratch()
      try {
        const playlist = media(track.playlist, `${server.origin}/track.m3u8`)
        await downloadHlsTrack({ playlist, outputPath: join(dir, 'three.ts'), concurrency: 3 })
        expect(peak).toBe(3)
        peak = 0
        await downloadHlsTrack({ playlist, outputPath: join(dir, 'default.ts') })
        expect(peak).toBe(4)
        expect(await readFile(join(dir, 'default.ts'))).toEqual(track.expected)
        expect(await readFile(join(dir, 'three.ts'))).toEqual(track.expected)
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('a segment that fails twice then succeeds is retried with backoff', async () => {
      const track = generatedTrack(5, 700)
      let failures = 0
      const server = await startServer((req, res) => {
        if (req.url === '/seg2.ts' && failures < 2) {
          failures++
          return sendText(res, 'busy', failures === 1 ? 503 : 429)
        }
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const outputPath = join(dir, 'out.ts')
        const started = Date.now()
        await downloadHlsTrack({
          playlist: media(track.playlist, `${server.origin}/track.m3u8`),
          outputPath,
          retryDelayMs: 50
        })
        expect(await readFile(outputPath)).toEqual(track.expected)
        expect(server.requests.filter((r) => r.url === '/seg2.ts')).toHaveLength(3)
        // Backoff: 50 ms, then 100 ms.
        expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('a permanent error or exhausted retries fail the track; finished parts stay', async () => {
      const track = generatedTrack(4, 300)
      const server = await startServer((req, res) => {
        const flaky = req.headers['x-mode'] === 'flaky'
        if (req.url === '/seg3.ts' && !flaky) return sendText(res, 'gone', 404)
        if (req.url === '/seg2.ts' && flaky) return sendText(res, 'x', 502)
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const playlist = media(track.playlist, `${server.origin}/track.m3u8`)
        const outputPath = join(dir, 'out.ts')
        const error = await rejection(
          downloadHlsTrack({ playlist, outputPath, concurrency: 1, retryDelayMs: 1 })
        )
        expect(error).toBeInstanceOf(HlsSegmentError)
        expect((error as HlsSegmentError).index).toBe(3)
        expect(((error as HlsSegmentError).cause as HlsHttpError).status).toBe(404)
        expect(server.requests.filter((r) => r.url === '/seg3.ts')).toHaveLength(1)
        const record = JSON.parse(
          await readFile(join(`${outputPath}.hls-parts`, 'resume.json'), 'utf-8')
        )
        expect(Object.keys(record.done).sort()).toEqual(['0', '1', '2'])
        await expect(readFile(outputPath)).rejects.toThrow()

        const flaky = await rejection(
          downloadHlsTrack({
            playlist,
            outputPath: join(dir, 'flaky.ts'),
            headers: { 'x-mode': 'flaky' },
            retries: 2,
            retryDelayMs: 1
          })
        )
        expect(flaky).toBeInstanceOf(HlsSegmentError)
        expect((flaky as HlsSegmentError).index).toBe(2)
        expect(
          server.requests.filter((r) => r.url === '/seg2.ts' && r.headers['x-mode'])
        ).toHaveLength(3)
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('abort stops the download; a restart resumes, skipping finished segments', async () => {
      const track = generatedTrack(12, 4000)
      const server = await startServer((req, res) => {
        if (req.url === '/track.m3u8') return sendText(res, track.playlist)
        const data = track.body(req.url ?? '')
        if (!data) return sendText(res, 'missing', 404)
        setTimeout(() => sendBytes(req, res, data), 30)
      })
      const dir = await scratch()
      try {
        const playlist = media(track.playlist, `${server.origin}/track.m3u8`)
        const outputPath = join(dir, 'out.ts')
        const controller = new AbortController()
        const aborted = await rejection(
          downloadHlsTrack({
            playlist,
            outputPath,
            concurrency: 2,
            signal: controller.signal,
            onProgress: (p) => {
              if (p.segmentsDone >= 3) controller.abort()
            }
          })
        )
        expect((aborted as Error).name).toBe('AbortError')
        const workDirectory = `${outputPath}.hls-parts`
        const record = JSON.parse(await readFile(join(workDirectory, 'resume.json'), 'utf-8'))
        const done = Object.keys(record.done).map(Number)
        expect(done.length).toBeGreaterThanOrEqual(3)
        expect(done.length).toBeLessThan(12)
        expect(record.identity).toBe(trackIdentity(segmentRequests(playlist)))
        // Interrupted segments leave no temporary files behind.
        expect((await readdir(workDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

        const before = server.requests.length
        const result = await downloadHlsTrack({ playlist, outputPath })
        expect(result.resumedSegments).toBe(done.length)
        expect(await readFile(outputPath)).toEqual(track.expected)
        const again = server.requests.slice(before).map((r) => r.url)
        expect(again).toHaveLength(12 - done.length)
        for (const index of done) expect(again).not.toContain(`/seg${index}.ts`)
        expect(await readdir(dir)).toEqual(['out.ts'])
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('an already-aborted signal and bad options reject before any request', async () => {
      const playlist = media(vod(['a.ts']))
      const dir = await scratch()
      try {
        const outputPath = join(dir, 'out.ts')
        const controller = new AbortController()
        controller.abort()
        expect(
          (
            (await rejection(
              downloadHlsTrack({ playlist, outputPath, signal: controller.signal })
            )) as Error
          ).name
        ).toBe('AbortError')
        expect(
          await rejection(downloadHlsTrack({ playlist, outputPath, concurrency: 0 }))
        ).toBeInstanceOf(RangeError)
        expect(
          await rejection(downloadHlsTrack({ playlist, outputPath, retries: -1 }))
        ).toBeInstanceOf(RangeError)
        const live = media(vod(['a.ts']).replace('#EXT-X-ENDLIST', ''))
        expect(await rejection(downloadHlsTrack({ playlist: live, outputPath }))).toBeInstanceOf(
          HlsLiveStreamError
        )
        expect(await readdir(dir)).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('an abort during a retry wait rejects with the abort reason', async () => {
      const dir = await scratch()
      try {
        const controller = new AbortController()
        const fetch: HlsFetch = async () => {
          setTimeout(() => controller.abort(new Error('user cancelled')), 20)
          return { status: 503, body: iterate() }
        }
        const error = await rejection(
          downloadHlsTrack({
            playlist: media(vod(['a.ts'])),
            outputPath: join(dir, 'out.ts'),
            fetch,
            retryDelayMs: 10_000,
            signal: controller.signal
          })
        )
        expect((error as Error).message).toBe('user cancelled')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('a changed playlist or a corrupt record starts over; stale parts are discarded', async () => {
      const dir = await scratch()
      const served: string[] = []
      // Each segment's body is its own URL.
      const fetch: HlsFetch = async (url) => {
        served.push(url)
        return { status: 200, body: iterate(Buffer.from(url)) }
      }
      const a = 'https://media.example.com/path/a.ts'
      const b = 'https://media.example.com/path/b.ts'
      try {
        const outputPath = join(dir, 'out.ts')
        const workDirectory = join(dir, 'work')
        const playlist = media(vod(['a.ts', 'b.ts']))
        // A record for another playlist, a part of it, and a file that isn't this module's.
        await mkdir(workDirectory)
        await writeFile(
          join(workDirectory, 'resume.json'),
          JSON.stringify({ version: 1, identity: 'other', segments: 2, done: { 0: 3 } })
        )
        await writeFile(join(workDirectory, '00000.part'), 'old')
        await writeFile(join(workDirectory, 'notes.txt'), 'keep me')
        const result = await downloadHlsTrack({ playlist, outputPath, workDirectory, fetch })
        expect(result.resumedSegments).toBe(0)
        expect(served).toEqual([a, b])
        expect((await readFile(outputPath)).toString()).toBe(a + b)
        // Only this module's files are removed; the unrelated file and its directory survive.
        expect(await readdir(workDirectory)).toEqual(['notes.txt'])

        // A corrupt record.
        await writeFile(join(workDirectory, 'resume.json'), '{ not json')
        await writeFile(join(workDirectory, '00000.part'), 'stale')
        served.length = 0
        const fresh = await downloadHlsTrack({ playlist, outputPath, workDirectory, fetch })
        expect(fresh.resumedSegments).toBe(0)
        expect(served).toEqual([a, b])
        expect((await readFile(outputPath)).toString()).toBe(a + b)

        // A part whose size doesn't match the record, and bogus indexes, are not trusted.
        await writeFile(
          join(workDirectory, 'resume.json'),
          JSON.stringify({
            version: 1,
            identity: trackIdentity(segmentRequests(playlist)),
            segments: 2,
            done: { 0: 999, 1: b.length, 7: 1, x: 1 }
          })
        )
        await writeFile(join(workDirectory, '00000.part'), 'short')
        await writeFile(join(workDirectory, '00001.part'), b)
        served.length = 0
        const partial = await downloadHlsTrack({ playlist, outputPath, workDirectory, fetch })
        expect(partial.resumedSegments).toBe(1)
        expect(served).toEqual([a])
        expect((await readFile(outputPath)).toString()).toBe(a + b)

        // A record of another format version.
        await writeFile(join(workDirectory, 'resume.json'), JSON.stringify({ version: 2 }))
        served.length = 0
        await downloadHlsTrack({ playlist, outputPath, workDirectory, fetch })
        expect(served).toEqual([a, b])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('short, long and mis-ranged bodies are retried; stream bodies work', async () => {
      const dir = await scratch()
      try {
        const attempts: Record<string, number> = {}
        const fetch: HlsFetch = async (url, init) => {
          const name = url.slice(url.lastIndexOf('/') + 1)
          const attempt = (attempts[name] = (attempts[name] ?? 0) + 1)
          if (name === 'short.ts' && attempt === 1) {
            return {
              status: 200,
              headers: { 'content-length': '10' },
              body: iterate(Buffer.from('12345'))
            }
          }
          if (name === 'long.ts' && attempt === 1) {
            return {
              status: 200,
              headers: { 'content-length': '3' },
              body: iterate(Buffer.from('abcdef'))
            }
          }
          if (name === 'range.ts') {
            const start = attempt === 1 ? 5 : (init.range?.start ?? 0)
            return {
              status: 206,
              headers: { 'content-range': `bytes ${start}-${start + 3}/100` },
              body: streamOf(Buffer.from('RANG'))
            }
          }
          if (name === 'short.ts') {
            return {
              status: 200,
              headers: { 'content-length': '10' },
              body: streamOf(Buffer.from('1234567890'))
            }
          }
          if (name === 'long.ts') return { status: 200, body: streamOf(Buffer.from('abc')) }
          return { status: 404, body: streamOf() }
        }
        const playlist = media(
          [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:4',
            '#EXTINF:4,',
            'short.ts',
            '#EXTINF:4,',
            'long.ts',
            '#EXTINF:4,',
            '#EXT-X-BYTERANGE:4@0',
            'range.ts',
            '#EXT-X-ENDLIST'
          ].join('\n')
        )
        const outputPath = join(dir, 'out.ts')
        await downloadHlsTrack({ playlist, outputPath, fetch, retryDelayMs: 1, concurrency: 1 })
        expect((await readFile(outputPath)).toString()).toBe('1234567890abcRANG')
        expect(attempts).toEqual({ 'short.ts': 2, 'long.ts': 2, 'range.ts': 2 })

        const missing = await rejection(
          downloadHlsTrack({
            playlist: media(vod(['nothing.ts'])),
            outputPath: join(dir, 'missing.ts'),
            fetch
          })
        )
        expect(((missing as HlsSegmentError).cause as HlsHttpError).status).toBe(404)
        // A 206 to a request without a range is not the content asked for.
        const partialAnswer = await rejection(
          downloadHlsTrack({
            playlist: media(vod(['range.ts'])),
            outputPath: join(dir, 'partial.ts'),
            fetch,
            retries: 0
          })
        )
        expect(((partialAnswer as HlsSegmentError).cause as HlsHttpError).status).toBe(206)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('redirected segments are followed', async () => {
      const track = generatedTrack(3, 900)
      const server = await startServer((req, res) => {
        const redirect = /^\/r\/(\d+)\/seg(\d+)\.ts$/.exec(req.url ?? '')
        if (redirect) {
          const left = Number(redirect[1])
          res.writeHead(left === 0 ? 308 : 302, {
            location: left === 0 ? `/seg${redirect[2]}.ts` : `/r/${left - 1}/seg${redirect[2]}.ts`
          })
          return res.end()
        }
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const playlist = media(
          vod(['r/3/seg0.ts', 'seg1.ts', 'r/0/seg2.ts']),
          `${server.origin}/track.m3u8`
        )
        const outputPath = join(dir, 'out.ts')
        await downloadHlsTrack({ playlist, outputPath })
        expect(await readFile(outputPath)).toEqual(track.expected)

        const loop = await rejection(
          downloadHlsTrack({
            playlist: media(vod(['r/20/seg0.ts']), `${server.origin}/track.m3u8`),
            outputPath: join(dir, 'loop.ts')
          })
        )
        expect(loop).toBeInstanceOf(HlsSegmentError)
        expect((loop as HlsSegmentError).cause).toBeInstanceOf(HlsLimitError)
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('credentials stay on their origin, also across redirects', async () => {
      const track = generatedTrack(3, 400)
      const other = await startServer((req, res) => {
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const home = await startServer((req, res) => {
        if (req.url === '/track.m3u8') {
          return sendText(res, vod(['seg0.ts', `${other.origin}/seg1.ts`, 'jump/seg2.ts']))
        }
        if (req.url === '/jump/seg2.ts') {
          res.writeHead(302, { location: `${other.origin}/seg2.ts` })
          return res.end()
        }
        const data = track.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const headers = {
          Cookie: 'session=secret',
          Authorization: 'Bearer secret',
          Origin: 'https://page.example',
          Referer: 'https://page.example/watch'
        }
        const resolved = await resolveHls(`${home.origin}/track.m3u8`, { headers })
        const result = await downloadHls(resolved, { videoPath: join(dir, 'out.ts'), headers })
        expect(result.audio).toBeUndefined()
        expect(await readFile(join(dir, 'out.ts'))).toEqual(track.expected)

        for (const request of home.requests) {
          expect(request.headers.cookie, request.url).toBe('session=secret')
          expect(request.headers.authorization, request.url).toBe('Bearer secret')
        }
        expect(other.requests.map((r) => r.url).sort()).toEqual(['/seg1.ts', '/seg2.ts'])
        for (const request of other.requests) {
          expect(request.headers.cookie, request.url).toBeUndefined()
          expect(request.headers.authorization, request.url).toBeUndefined()
          expect(request.headers.origin, request.url).toBeUndefined()
          expect(request.headers.referer, request.url).toBe('https://page.example/watch')
        }
      } finally {
        await home.close()
        await other.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('downloadHls saves the video and the separate audio track', async () => {
      const video = generatedTrack(4, 600, true)
      const audioSegments = [bytes(70, 300), bytes(71, 310)]
      const server = await startServer((req, res) => {
        if (req.url === '/master.m3u8') {
          return sendText(
            res,
            '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",AUTOSELECT=YES,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\ntrack.m3u8'
          )
        }
        if (req.url === '/track.m3u8') return sendText(res, video.playlist)
        if (req.url === '/audio/index.m3u8') return sendText(res, vod(['a0.aac', 'a1.aac']))
        const audio = /^\/audio\/a(\d)\.aac$/.exec(req.url ?? '')
        if (audio) return sendBytes(req, res, audioSegments[Number(audio[1])])
        const data = video.body(req.url ?? '')
        if (data) return sendBytes(req, res, data)
        sendText(res, 'missing', 404)
      })
      const dir = await scratch()
      try {
        const resolved = await resolveHls(`${server.origin}/master.m3u8`)
        expect(
          await rejection(downloadHls(resolved, { videoPath: join(dir, 'v.mp4') }))
        ).toBeInstanceOf(TypeError)
        const tracks = new Set<string>()
        const result = await downloadHls(resolved, {
          videoPath: join(dir, 'v.mp4'),
          audioPath: join(dir, 'a.aac'),
          onProgress: (track) => tracks.add(track)
        })
        expect(await readFile(join(dir, 'v.mp4'))).toEqual(video.expected)
        expect(await readFile(join(dir, 'a.aac'))).toEqual(Buffer.concat(audioSegments))
        expect(result.audio?.segments).toBe(2)
        expect([...tracks].sort()).toEqual(['audio', 'video'])
        expect((await readdir(dir)).sort()).toEqual(['a.aac', 'v.mp4'])
      } finally {
        await server.close()
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('the track identity depends on URLs and ranges', () => {
      const plain = segmentRequests(media(vod(['a.ts', 'b.ts'])))
      const same = segmentRequests(media(vod(['a.ts', 'b.ts'])))
      const reordered = segmentRequests(media(vod(['b.ts', 'a.ts'])))
      const ranged = segmentRequests(
        media(
          '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:5@0\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST'
        )
      )
      expect(trackIdentity(plain)).toMatch(/^[0-9a-f]{64}$/)
      expect(trackIdentity(plain)).toBe(trackIdentity(same))
      expect(trackIdentity(plain)).not.toBe(trackIdentity(reordered))
      expect(trackIdentity(plain)).not.toBe(trackIdentity(ranged))
    })
  })
})

function alternativeAudioText(): string {
  return [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="main/english-audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="...",AUDIO="aac"',
    'low/video-only.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,CODECS="...",AUDIO="aac"',
    'mid/video-only.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=7680000,CODECS="...",AUDIO="aac"',
    'hi/video-only.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5",AUDIO="aac"',
    'main/english-audio.m3u8'
  ].join('\n')
}
