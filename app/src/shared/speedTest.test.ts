import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  downloadUrl,
  jitter,
  latencySample,
  liveRate,
  median,
  nextRequestBytes,
  pruneSpeedTests,
  sanitizeSpeedTestRun,
  sanitizeSpeedTests,
  serverTimeMs,
  speedTestServer,
  spreadTimeline,
  SPEED_TESTS_KEPT,
  SPEED_TESTS_MAX_AGE_MS,
  standouts,
  steadyRate,
  uploadUrl,
  WARM_UP_MS,
  type SpeedTestLinkResult,
  type SpeedTestRun
} from './speedTest'

const link = (overrides: Partial<SpeedTestLinkResult> = {}): SpeedTestLinkResult => ({
  networkId: 'en0',
  kind: 'wifi',
  name: 'Wi-Fi',
  status: 'done',
  latencySamples: 20,
  bytesDown: 1,
  bytesUp: 1,
  ...overrides
})

const run = (overrides: Partial<SpeedTestRun> = {}): SpeedTestRun => ({
  id: 'r1',
  scope: 'link',
  server: 'https://speed.cloudflare.com',
  startedAt: 1_000,
  finishedAt: 2_000,
  status: 'done',
  links: [link()],
  notes: [],
  ...overrides
})

describe('median', () => {
  it('is undefined for nothing, the middle for an odd count, the mean of the two middles for even', () => {
    expect(median([])).toBeUndefined()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('does not reorder its input', () => {
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('lies between the smallest and largest value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { minLength: 1 }),
        (xs) => {
          const m = median(xs)!
          expect(m).toBeGreaterThanOrEqual(Math.min(...xs))
          expect(m).toBeLessThanOrEqual(Math.max(...xs))
        }
      )
    )
  })
})

describe('jitter', () => {
  it('needs two samples', () => {
    expect(jitter([])).toBeUndefined()
    expect(jitter([10])).toBeUndefined()
  })

  it('is the mean absolute difference between consecutive samples', () => {
    expect(jitter([10, 12, 9, 9])).toBeCloseTo((2 + 3 + 0) / 3)
  })

  it('is 0 for a steady line and never negative', () => {
    expect(jitter([7, 7, 7])).toBe(0)
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e4, noNaN: true }), { minLength: 2 }),
        (xs) => {
          expect(jitter(xs)!).toBeGreaterThanOrEqual(0)
        }
      )
    )
  })
})

describe('serverTimeMs', () => {
  it('is 0 without a header, or without a duration', () => {
    expect(serverTimeMs(undefined)).toBe(0)
    expect(serverTimeMs('')).toBe(0)
    expect(serverTimeMs('miss, cache;desc="hit"')).toBe(0)
    expect(serverTimeMs('app;dur=abc')).toBe(0)
  })

  it('prefers Cloudflare’s request duration over earlier metrics', () => {
    expect(serverTimeMs('edge;dur=3, cfRequestDuration;dur=12.5')).toBe(12.5)
  })

  it('otherwise takes the first metric with a duration, quoted or not, across repeated headers', () => {
    expect(serverTimeMs('miss, db;dur=53, app;dur=47.2')).toBe(53)
    expect(serverTimeMs('db;desc="x";dur="8"')).toBe(8)
    expect(serverTimeMs(['miss', 'db; dur = 4'])).toBe(4)
  })
})

describe('latencySample', () => {
  it('takes the server’s time off the time to the first byte', () => {
    expect(latencySample(30, 4)).toBe(26)
  })

  it('ignores a server time that is not shorter than the whole wait', () => {
    expect(latencySample(30, 30)).toBe(30)
    expect(latencySample(30, 45)).toBe(30)
  })

  it('is never negative', () => {
    expect(latencySample(-1, 0)).toBe(0)
  })
})

describe('steadyRate', () => {
  it('needs two samples and some time past the warm-up', () => {
    expect(steadyRate([])).toBeUndefined()
    expect(steadyRate([{ at: 0, bytes: 0 }])).toBeUndefined()
    expect(
      steadyRate([
        { at: 0, bytes: 0 },
        { at: 0, bytes: 10 }
      ])
    ).toBeUndefined()
  })

  it('leaves out the warm-up', () => {
    // 1 MB/s while TCP ramps up for the first 2 s, then 10 MB/s.
    const samples = Array.from({ length: 101 }, (_, i) => {
      const at = i * 100
      const bytes = at <= WARM_UP_MS ? at * 1_000 : WARM_UP_MS * 1_000 + (at - WARM_UP_MS) * 10_000
      return { at, bytes }
    })
    expect(steadyRate(samples)).toBeCloseTo(10_000_000)
  })

  it('shortens the warm-up to a quarter of a short transfer', () => {
    // 2 s in all: the first 0.5 s is left out.
    const samples = [
      { at: 0, bytes: 0 },
      { at: 500, bytes: 100 },
      { at: 2_000, bytes: 1_600 }
    ]
    expect(steadyRate(samples)).toBeCloseTo(1_000)
  })

  it('is the plain rate for a constant speed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 3, max: 200 }), (rate, n) => {
        const samples = Array.from({ length: n }, (_, i) => ({
          at: i * 100,
          bytes: (rate * i) / 10
        }))
        expect(steadyRate(samples)!).toBeCloseTo(rate, 0)
      })
    )
  })
})

describe('liveRate', () => {
  it('is 0 without two samples or time between them', () => {
    expect(liveRate([])).toBe(0)
    expect(liveRate([{ at: 5, bytes: 9 }])).toBe(0)
    expect(
      liveRate([
        { at: 5, bytes: 0 },
        { at: 5, bytes: 9 }
      ])
    ).toBe(0)
  })

  it('takes the last second only', () => {
    const samples = [
      { at: 0, bytes: 0 },
      { at: 1_000, bytes: 100 },
      { at: 2_000, bytes: 1_100 }
    ]
    expect(liveRate(samples)).toBe(1_000)
  })

  it('uses every sample while there is less than a second of them', () => {
    expect(
      liveRate([
        { at: 0, bytes: 0 },
        { at: 200, bytes: 50 },
        { at: 400, bytes: 200 }
      ])
    ).toBe(500)
  })
})

describe('standouts', () => {
  it('needs two finished networks with a download speed', () => {
    expect(standouts([])).toEqual({})
    expect(standouts([link({ downloadBytesPerSec: 5 })])).toEqual({})
    expect(
      standouts([
        link({ downloadBytesPerSec: 5 }),
        link({ networkId: 'en1', status: 'failed', downloadBytesPerSec: 9 })
      ])
    ).toEqual({})
    expect(standouts([link({ downloadBytesPerSec: 5 }), link({ networkId: 'en1' })])).toEqual({})
  })

  it('names the fastest, slowest and steadiest', () => {
    expect(
      standouts([
        link({ networkId: 'a', downloadBytesPerSec: 5, jitterMs: 9 }),
        link({ networkId: 'b', downloadBytesPerSec: 50, jitterMs: 2 }),
        link({ networkId: 'c', downloadBytesPerSec: 20 })
      ])
    ).toEqual({ fastest: 'b', slowest: 'a', steadiest: 'b' })
  })

  it('names no steadiest with fewer than two jitters, and no slowest when all are equal', () => {
    expect(
      standouts([
        link({ networkId: 'a', downloadBytesPerSec: 5, jitterMs: 1 }),
        link({ networkId: 'b', downloadBytesPerSec: 5 })
      ])
    ).toEqual({ fastest: 'a' })
  })
})

describe('speedTestServer', () => {
  it('keeps only the scheme and host', () => {
    expect(speedTestServer(' https://speed.cloudflare.com/x?y=1 ')).toBe(
      'https://speed.cloudflare.com'
    )
    expect(speedTestServer('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080')
  })

  it('refuses what isn’t an http(s) address, or carries credentials', () => {
    expect(speedTestServer(undefined)).toBeUndefined()
    expect(speedTestServer(42)).toBeUndefined()
    expect(speedTestServer('not a url')).toBeUndefined()
    expect(speedTestServer('ftp://example.com')).toBeUndefined()
    expect(speedTestServer('https://user:pw@example.com')).toBeUndefined()
  })
})

describe('request addresses and sizes', () => {
  it('asks for whole bytes, never fewer than none', () => {
    expect(downloadUrl('https://s.example', 1_000.7).href).toBe(
      'https://s.example/__down?bytes=1000'
    )
    expect(downloadUrl('https://s.example', -5).href).toBe('https://s.example/__down?bytes=0')
    expect(uploadUrl('http://127.0.0.1:9').href).toBe('http://127.0.0.1:9/__up')
  })

  it('doubles a quick request up to the most, keeps a slow one, starts at the least', () => {
    const limits = { min: 100, max: 1_000, target: 500 }
    expect(nextRequestBytes(0, 0, limits)).toBe(100)
    expect(nextRequestBytes(100, 100, limits)).toBe(200)
    expect(nextRequestBytes(800, 100, limits)).toBe(1_000)
    expect(nextRequestBytes(400, 900, limits)).toBe(400)
  })
})

describe('speed-tests.json', () => {
  it('reads nothing from what isn’t a file of runs', () => {
    expect(sanitizeSpeedTests(undefined, 0)).toEqual([])
    expect(sanitizeSpeedTests({ runs: 'x' }, 0)).toEqual([])
  })

  it('keeps a whole run as it was', () => {
    const whole = run({
      reason: 'x',
      links: [
        link({
          reason: 'y',
          latencyMs: 12,
          jitterMs: 1.5,
          downloadBytesPerSec: 9e6,
          uploadBytesPerSec: 2e6
        })
      ],
      combined: {
        downloadBytesPerSec: 1,
        uploadBytesPerSec: 2,
        latencyMs: 3,
        jitterMs: 4,
        share: { en0: 5 }
      },
      notes: ['downloads-paused', 'busy-network', 'sticky-sites-on', 'speed-limit']
    })
    expect(sanitizeSpeedTestRun(JSON.parse(JSON.stringify(whole)))).toEqual(whole)
  })

  it('drops runs it can’t read', () => {
    for (const bad of [
      null,
      [],
      { ...run(), id: '' },
      { ...run(), server: 3 },
      { ...run(), scope: 'everything' },
      { ...run(), status: 'maybe' },
      { ...run(), startedAt: -1 },
      { ...run(), finishedAt: 'later' }
    ]) {
      expect(sanitizeSpeedTestRun(bad)).toBeUndefined()
    }
  })

  it('drops networks and fields it can’t read, keeping the rest', () => {
    const read = sanitizeSpeedTestRun({
      ...run(),
      links: [
        link(),
        null,
        { ...link(), networkId: '' },
        { ...link(), name: 7 },
        { ...link(), kind: 'satellite' },
        { ...link(), status: 'great' },
        { ...link(), latencySamples: -2, bytesDown: 'x', bytesUp: Infinity, latencyMs: NaN }
      ],
      combined: { share: { en0: 5, en1: -1, en2: 'x' }, downloadBytesPerSec: -3 },
      notes: ['busy-network', 'busy-network', 'aliens']
    })!
    expect(read.links).toEqual([link(), link({ latencySamples: 0, bytesDown: 0, bytesUp: 0 })])
    expect(read.combined).toEqual({ share: { en0: 5 } })
    expect(read.notes).toEqual(['busy-network'])
  })

  it('reads a run without networks, notes or a readable total', () => {
    const read = sanitizeSpeedTestRun({ ...run(), links: 'x', notes: 'x', combined: 'x' })!
    expect(read.links).toEqual([])
    expect(read.notes).toEqual([])
    expect(read.combined).toBeUndefined()
    expect(sanitizeSpeedTestRun({ ...run(), combined: { share: 'x' } })!.combined).toEqual({
      share: {}
    })
  })

  it('keeps the newest runs first, at most SPEED_TESTS_KEPT and none too old', () => {
    const now = SPEED_TESTS_MAX_AGE_MS + 10_000
    const runs = Array.from({ length: SPEED_TESTS_KEPT + 5 }, (_, i) =>
      run({ id: `r${i}`, startedAt: now - i })
    )
    const old = run({ id: 'old', startedAt: now - SPEED_TESTS_MAX_AGE_MS - 1 })
    const kept = pruneSpeedTests([...runs].reverse().concat(old), now)
    expect(kept).toHaveLength(SPEED_TESTS_KEPT)
    expect(kept[0].id).toBe('r0')
    expect(kept.some((each) => each.id === 'old')).toBe(false)
    expect(
      sanitizeSpeedTests({ runs: [old, runs[1], runs[0]] }, now).map((each) => each.id)
    ).toEqual(['r0', 'r1'])
  })
})

describe('spreadTimeline', () => {
  it('spreads each answered request over the time it took, up to `until`', () => {
    const timeline = spreadTimeline(
      [
        { start: 0, end: 4_000, bytes: 400 },
        { start: 4_000, end: 6_000, bytes: 200 }
      ],
      [0, 1_000, 2_000, 5_000, 7_000],
      6_000
    )
    expect(timeline).toEqual([
      { at: 0, bytes: 0 },
      { at: 1_000, bytes: 100 },
      { at: 2_000, bytes: 200 },
      { at: 5_000, bytes: 500 },
      { at: 6_000, bytes: 600 }
    ])
    // 100 bytes a second throughout: what crossed during the warm-up isn't counted after it.
    expect(steadyRate(timeline)).toBeCloseTo(100)
  })

  it('counts a request that took no time when it is answered', () => {
    expect(spreadTimeline([{ start: 50, end: 50, bytes: 9 }], [0, 40], 60)).toEqual([
      { at: 0, bytes: 0 },
      { at: 40, bytes: 0 },
      { at: 60, bytes: 9 }
    ])
  })
})
