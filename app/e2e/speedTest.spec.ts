import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StreamConnection } from '../src/main/network/routes'
import { SpeedTestHistory } from '../src/main/speedTest/history'
import {
  DirectConnection,
  measureLatency,
  measureTransfer,
  type Connection
} from '../src/main/speedTest/measure'
import {
  SpeedTester,
  SYSTEM_LANE,
  type LinkTraffic,
  type SpeedTestDeps,
  type SystemMergeState
} from '../src/main/speedTest/runner'
import { steadyRate, type SpeedTestLive, type SpeedTestRun } from '../src/shared/speedTest'
import type { NetworkInterfaceInfo } from '../src/shared/types'
import { LAN_ADDRESS } from './fixtures'
import { SpeedServer } from './speedServer'

// The speed test (docs/DECISIONS.md ADR-0064), measured for real against a local stand-in for
// Cloudflare's speed test (speedServer.ts), on the suite's two test networks: a (loopback) and b
// (this Mac's LAN address). The server paces each network to its own speed, so a result can be
// checked against the speed it was given — and against a shared limit, which shows that the
// combined test measures what arrived rather than adding the networks' speeds up.

const MB = 1024 * 1024

function network(id: string, address: string): NetworkInterfaceInfo {
  return {
    id,
    device: id,
    displayName: `${id} name`,
    kind: 'ethernet',
    addresses: [{ address, family: 4 }]
  }
}

const A = network('a', '127.0.0.1')
const B = LAN_ADDRESS ? network('b', LAN_ADDRESS) : undefined

/** Within `share` of `expected`. */
function near(actual: number | undefined, expected: number, share: number): void {
  expect(actual).toBeDefined()
  expect(actual!).toBeGreaterThan(expected * (1 - share))
  expect(actual!).toBeLessThan(expected * (1 + share))
}

const pinned = (iface: () => NetworkInterfaceInfo | undefined): StreamConnection =>
  new StreamConnection(iface, { timeoutMs: 3_000 })

interface Harness {
  tester: SpeedTester
  runs: SpeedTestRun[]
  saved: SpeedTestRun[]
  lives: Array<SpeedTestLive | null>
  counted: Record<string, number>
  resumed: string[][]
  present: Map<string, NetworkInterfaceInfo>
  finished: Promise<SpeedTestRun>
}

function harness(
  server: SpeedServer,
  overrides: Partial<SpeedTestDeps> = {},
  networks: NetworkInterfaceInfo[] = [A, ...(B ? [B] : [])]
): Harness {
  const present = new Map(networks.map((each) => [each.id, each]))
  const runs: SpeedTestRun[] = []
  const saved: SpeedTestRun[] = []
  const lives: Array<SpeedTestLive | null> = []
  const counted: Record<string, number> = {}
  const resumed: string[][] = []
  let finish: (run: SpeedTestRun) => void = () => {}
  const finished = new Promise<SpeedTestRun>((resolve) => (finish = resolve))
  const tester = new SpeedTester({
    find: (id) => present.get(id),
    limitReached: () => false,
    countUsage: (id, bytes) => (counted[id] = (counted[id] ?? 0) + bytes),
    server: () => server.url,
    connect: (id) => (id === null ? new DirectConnection(3_000) : pinned(() => present.get(id))),
    pauseDownloads: async () => [],
    resumeDownloads: (ids) => void resumed.push(ids),
    systemMerge: async () => null,
    traffic: async () => null,
    save: async (run) => void saved.push(run),
    onLive: (live) => void lives.push(live),
    onFinished: (run) => {
      runs.push(run)
      finish(run)
    },
    timing: {
      latencySamples: 5,
      downloadMs: 3_000,
      uploadMs: 3_000,
      downloadStreams: 3,
      uploadStreams: 2,
      stallMs: 2_000,
      trafficMs: 100
    },
    ...overrides
  })
  return { tester, runs, saved, lives, counted, resumed, present, finished }
}

let server: SpeedServer
test.afterEach(async () => {
  await server?.stop()
})

test.describe('measuring @smoke', () => {
  test('latency is the median time to the first byte, less the server’s own time', async () => {
    server = await new SpeedServer({ delayMs: { '127.0.0.1': 40 }, serverTimingMs: 15 }).start()
    const connection = pinned(() => A)
    try {
      const samples = await measureLatency(connection, {
        server: server.url,
        samples: 6,
        signal: new AbortController().signal
      })
      expect(samples).toHaveLength(6)
      // 40 ms of waiting, of which the server says 15 were its own.
      for (const sample of samples) {
        expect(sample).toBeGreaterThan(20)
        expect(sample).toBeLessThan(60)
      }
      // The connection was opened before the first sample, which isn't counted.
      expect(server.requests).toHaveLength(7)
    } finally {
      connection.close()
    }
  })

  test('latency stops when cancelled, and fails on an error reply', async () => {
    server = await new SpeedServer({ delayMs: { '127.0.0.1': 30 } }).start()
    const connection = pinned(() => A)
    const controller = new AbortController()
    const taking = measureLatency(connection, {
      server: server.url,
      samples: 50,
      signal: controller.signal,
      onSample: () => controller.abort()
    })
    await expect(taking).rejects.toThrow()
    server.options.failFrom = { '127.0.0.1': 503 }
    await expect(
      measureLatency(connection, {
        server: server.url,
        samples: 2,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('The test server answered 503')
    connection.close()
  })

  test('download speed matches the network’s speed, and every byte is counted', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': 2 * MB } }).start()
    const connection = pinned(() => A)
    const counted: number[] = []
    const ticks: number[] = []
    try {
      const result = await measureTransfer({
        direction: 'download',
        server: server.url,
        lanes: [{ id: 'a', connection, present: () => true }],
        streams: 3,
        durationMs: 3_000,
        capBytes: 100 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal,
        onBytes: (_lane, bytes) => counted.push(bytes),
        onTick: (bytesPerSec) => ticks.push(bytesPerSec)
      })
      near(steadyRate(result.samples), 2 * MB, 0.25)
      expect(result.lanes.a.error).toBeUndefined()
      // Every byte that arrived counts for the data limit, those after the deadline too; the
      // measured ones stop at the deadline. Neither is more than the server sent.
      const counts = counted.reduce((sum, each) => sum + each, 0)
      expect(counts).toBeGreaterThanOrEqual(result.lanes.a.bytes)
      expect(counts).toBeLessThanOrEqual(server.sent['127.0.0.1'])
      expect(ticks.length).toBeGreaterThan(10)
      near(ticks.at(-1), 2 * MB, 0.4)
    } finally {
      connection.close()
    }
  })

  test('upload speed matches the network’s speed', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': 2 * MB } }).start()
    const connection = pinned(() => A)
    try {
      const result = await measureTransfer({
        direction: 'upload',
        server: server.url,
        lanes: [{ id: 'a', connection, present: () => true }],
        streams: 2,
        durationMs: 4_000,
        capBytes: 100 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal
      })
      near(steadyRate(result.samples), 2 * MB, 0.3)
      expect(result.lanes.a.error).toBeUndefined()
      expect(server.requests.every((each) => each.method === 'POST')).toBe(true)
    } finally {
      connection.close()
    }
  })

  test('upload speed on a slow uplink is not overstated by requests answered late', async () => {
    // 64 kB/s shared by four connections: each request takes seconds, and straddles the warm-up.
    server = await new SpeedServer({ rates: { '127.0.0.1': 64 * 1024 } }).start()
    // The app's own request timeout: a body handed to the system waits seconds for its answer.
    const connection = new StreamConnection(() => A, { timeoutMs: 15_000 })
    try {
      const result = await measureTransfer({
        direction: 'upload',
        server: server.url,
        lanes: [{ id: 'a', connection, present: () => true }],
        streams: 4,
        durationMs: 6_000,
        capBytes: 100 * MB,
        stallMs: 5_000,
        signal: new AbortController().signal
      })
      expect(result.lanes.a.error).toBeUndefined()
      near(steadyRate(result.samples), 64 * 1024, 0.3)
    } finally {
      connection.close()
    }
  })

  test('a network that reaches its data limit during a transfer stops there', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': 2 * MB } }).start()
    const connection = pinned(() => A)
    let used = 0
    try {
      const result = await measureTransfer({
        direction: 'download',
        server: server.url,
        lanes: [{ id: 'a', connection, present: () => true, limitReached: () => used >= MB }],
        streams: 2,
        durationMs: 5_000,
        capBytes: 100 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal,
        onBytes: (_lane, bytes) => (used += bytes)
      })
      expect(result.lanes.a.error).toBe('Its data limit was reached')
      // Stopped within a tick of the limit: at 2 MB/s, about 200 kB over at most.
      expect(used).toBeLessThan(1.5 * MB)
    } finally {
      connection.close()
    }
  })

  test('a transfer ends at the data cap', async () => {
    server = await new SpeedServer().start()
    const connection = pinned(() => A)
    try {
      const started = Date.now()
      const result = await measureTransfer({
        direction: 'download',
        server: server.url,
        lanes: [{ id: 'a', connection, present: () => true }],
        streams: 2,
        durationMs: 20_000,
        capBytes: 4 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal
      })
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(result.lanes.a.bytes).toBeGreaterThanOrEqual(4 * MB)
    } finally {
      connection.close()
    }
  })

  test('a network that goes away, or stops answering, fails its lane', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': 1 * MB } }).start()
    let here = true
    const connection = pinned(() => (here ? A : undefined))
    setTimeout(() => {
      here = false
      server.dropConnections()
    }, 800)
    const gone = await measureTransfer({
      direction: 'download',
      server: server.url,
      lanes: [{ id: 'a', connection, present: () => here }],
      streams: 2,
      durationMs: 5_000,
      capBytes: 100 * MB,
      stallMs: 2_000,
      signal: new AbortController().signal
    })
    expect(gone.lanes.a.error).toBe('The network disconnected')
    connection.close()

    // A server that sends headers and then nothing: the lane stalls.
    const silent = createServer((_req, res) => res.writeHead(200).flushHeaders())
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const quiet = pinned(() => A)
    try {
      const stalled = await measureTransfer({
        direction: 'download',
        server: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
        lanes: [{ id: 'a', connection: quiet, present: () => true }],
        streams: 1,
        durationMs: 5_000,
        capBytes: MB,
        stallMs: 600,
        signal: new AbortController().signal
      })
      expect(stalled.lanes.a.error).toBe('The network stopped answering')
    } finally {
      quiet.close()
      silent.closeAllConnections()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  test('a lane whose every request fails gives up after a few tries', async () => {
    server = await new SpeedServer({ failFrom: { '127.0.0.1': 500 } }).start()
    const connection = pinned(() => A)
    const result = await measureTransfer({
      direction: 'upload',
      server: server.url,
      lanes: [{ id: 'a', connection, present: () => true }],
      streams: 1,
      durationMs: 5_000,
      capBytes: MB,
      stallMs: 4_000,
      signal: new AbortController().signal
    })
    expect(result.lanes.a.error).toBe('The test server answered 500')
    connection.close()
  })

  test('a cancelled transfer says so', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    const connection = pinned(() => A)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    for (const direction of ['download', 'upload'] as const) {
      await expect(
        measureTransfer({
          direction,
          server: server.url,
          lanes: [{ id: 'a', connection, present: () => true }],
          streams: 2,
          durationMs: 5_000,
          capBytes: 100 * MB,
          stallMs: 2_000,
          signal: controller.signal
        })
      ).rejects.toThrow('cancelled')
    }
    connection.close()
  })

  test('combined: two networks at once add up when they don’t share a line', async () => {
    test.skip(!B, 'needs a LAN address to act as the second network')
    server = await new SpeedServer({
      rates: { '127.0.0.1': 1.5 * MB, [B!.addresses[0].address]: 3 * MB }
    }).start()
    const lanes = [A, B!].map((each) => ({
      id: each.id,
      connection: pinned(() => each),
      present: () => true
    }))
    try {
      const result = await measureTransfer({
        direction: 'download',
        server: server.url,
        lanes,
        streams: 3,
        durationMs: 3_000,
        capBytes: 100 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal
      })
      near(steadyRate(result.samples), 4.5 * MB, 0.25)
      near(steadyRate(result.lanes.a.samples), 1.5 * MB, 0.3)
      near(steadyRate(result.lanes.b.samples), 3 * MB, 0.3)
    } finally {
      for (const lane of lanes) lane.connection.close()
    }
  })

  test('combined: two networks behind one slow line measure the line, not the sum', async () => {
    test.skip(!B, 'needs a LAN address to act as the second network')
    server = await new SpeedServer({
      rates: { '127.0.0.1': 2.5 * MB, [B!.addresses[0].address]: 2.5 * MB },
      shared: 3 * MB
    }).start()
    const lanes = [A, B!].map((each) => ({
      id: each.id,
      connection: pinned(() => each),
      present: () => true
    }))
    try {
      const result = await measureTransfer({
        direction: 'download',
        server: server.url,
        lanes,
        streams: 3,
        durationMs: 3_000,
        capBytes: 100 * MB,
        stallMs: 2_000,
        signal: new AbortController().signal
      })
      // Each network alone would do 2.5 MB/s; together they get the line's 3, not 5.
      near(steadyRate(result.samples), 3 * MB, 0.25)
    } finally {
      for (const lane of lanes) lane.connection.close()
    }
  })
})

test.describe('connections @smoke', () => {
  test('a POST body keeps a request alive past the timeout while it is being sent', async () => {
    server = await new SpeedServer().start()
    // Ten pieces, one every 150 ms: 1.5 s of body, with a 600 ms timeout.
    const piece = Buffer.alloc(16 * 1024)
    for (const connection of [
      new StreamConnection(() => A, { timeoutMs: 600 }),
      new DirectConnection(600)
    ] as Connection[]) {
      const { res } = await connection.request(new URL('/__up', server.url), {}, undefined, {
        length: 10 * piece.length,
        write: (req, progress) => {
          let sent = 0
          const next = (): void => {
            if (sent++ === 10) return void req.end()
            req.write(piece, progress)
            setTimeout(next, 150)
          }
          next()
        }
      })
      expect(res.statusCode).toBe(200)
      res.resume()
      connection.close()
    }
    expect(server.received['127.0.0.1']).toBe(20 * piece.length)
  })

  test('a request whose reply doesn’t come in time stalls, and a cancelled one gives up', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const target = new URL(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/__down`)
    const direct = new DirectConnection(300)
    try {
      await expect(direct.request(target, {})).rejects.toThrow('Connection stalled')
      const slowBody = direct.request(target, {}, undefined, {
        length: 1,
        write: (req, progress) => {
          req.end(Buffer.alloc(1), progress)
        }
      })
      await expect(slowBody).rejects.toThrow('Connection stalled')
      const controller = new AbortController()
      controller.abort()
      await expect(direct.request(target, {}, controller.signal)).rejects.toThrow('cancelled')
      const later = new AbortController()
      const pending = direct.request(target, {}, later.signal)
      later.abort()
      await expect(pending).rejects.toThrow('cancelled')

      // A tied connection the same way: no reply in time, with and without a body.
      const tied = new StreamConnection(() => A, { timeoutMs: 300 })
      try {
        await expect(tied.request(target, {})).rejects.toThrow('Connection stalled')
        await expect(
          tied.request(target, {}, undefined, {
            length: 1,
            write: (req, progress) => {
              req.end(Buffer.alloc(1), progress)
            }
          })
        ).rejects.toThrow('Connection stalled')
      } finally {
        tied.close()
      }
    } finally {
      direct.close()
      silent.closeAllConnections()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })
})

test.describe('running a test @smoke', () => {
  test('each network on its own, one after another, counted against its data limit', async () => {
    test.skip(!B, 'needs a LAN address to act as the second network')
    server = await new SpeedServer({
      rates: { '127.0.0.1': 2 * MB, [B!.addresses[0].address]: 1 * MB },
      delayMs: { '127.0.0.1': 10, [B!.addresses[0].address]: 30 }
    }).start()
    const h = harness(server, { pauseDownloads: async () => ['d1', 'd2'] })
    const id = h.tester.start({ scope: 'link', networkIds: ['a', 'b', 'a'] })
    expect(() => h.tester.start({ scope: 'link', networkIds: ['a'] })).toThrow('already running')
    const run = await h.finished
    expect(run.id).toBe(id)
    expect(run.status).toBe('done')
    expect(run.notes).toEqual(['downloads-paused'])
    expect(h.resumed).toEqual([['d1', 'd2']])
    expect(run.links.map((link) => link.networkId)).toEqual(['a', 'b'])
    const [a, b] = run.links
    expect(a).toMatchObject({ status: 'done', kind: 'ethernet', name: 'a name', latencySamples: 5 })
    near(a.downloadBytesPerSec, 2 * MB, 0.3)
    near(b.downloadBytesPerSec, 1 * MB, 0.3)
    near(a.uploadBytesPerSec, 2 * MB, 0.4)
    expect(a.latencyMs!).toBeLessThan(b.latencyMs!)
    expect(a.jitterMs).toBeDefined()
    expect(h.counted.a).toBeGreaterThanOrEqual(a.bytesDown + a.bytesUp)
    expect(h.counted.b).toBeGreaterThanOrEqual(b.bytesDown + b.bytesUp)
    expect(h.saved).toEqual([run])
    // The window saw each phase, the networks in turn, and the end.
    const phases = new Set(
      h.lives.filter((live) => live).map((live) => `${live!.networkId}:${live!.phase}`)
    )
    expect([...phases]).toEqual(
      expect.arrayContaining(['a:latency', 'a:download', 'a:upload', 'b:upload'])
    )
    expect(h.lives.at(-1)).toBeNull()
    expect(h.tester.current()).toBeNull()
  })

  test('a network that can’t be tested is said so, and a failing one doesn’t stop the rest', async () => {
    server = await new SpeedServer({ failFrom: { '127.0.0.1': 503 } }).start()
    const h = harness(server, { limitReached: (id) => id === 'capped' }, [
      A,
      network('capped', '127.0.0.1')
    ])
    h.tester.start({ scope: 'link', networkIds: ['gone', 'capped', 'a'] })
    const run = await h.finished
    expect(run.status).toBe('failed')
    expect(run.links.map((link) => [link.networkId, link.status, link.reason])).toEqual([
      ['gone', 'unavailable', 'Not connected'],
      ['capped', 'unavailable', 'Its data limit is reached'],
      ['a', 'failed', 'The test server answered 503']
    ])
    expect(h.saved).toHaveLength(1)

    const nothing = harness(server, {}, [])
    nothing.tester.start({ scope: 'link', networkIds: ['gone'] })
    expect((await nothing.finished).status).toBe('unavailable')
    await nothing.tester.settled()
    expect(() => nothing.tester.start({ scope: 'combined', networkIds: [] })).toThrow(
      'Choose a network'
    )
  })

  test('a network that drops while it is tested fails, and a busy one is noted', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    const h = harness(server, {
      // The interface carries 5 MB/s while the test gets 1: something else is using it.
      traffic: async () => ({ a: { rxBps: 0, txBps: 0, linkRxBps: 5 * MB, linkTxBps: 0 } })
    })
    h.tester.start({ scope: 'link', networkIds: ['a'] })
    await expect
      .poll(() => h.lives.some((live) => live?.phase === 'upload'), { timeout: 15_000 })
      .toBe(true)
    h.present.delete('a')
    server.dropConnections()
    const run = await h.finished
    expect(run.notes).toContain('busy-network')
    expect(run.links[0]).toMatchObject({ status: 'failed', reason: 'The network disconnected' })
    expect(run.links[0].downloadBytesPerSec).toBeDefined()
  })

  test('cancelled: nothing is kept, and the paused downloads resume', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    const h = harness(server, { pauseDownloads: async () => ['d1'] })
    h.tester.start({ scope: 'link', networkIds: ['a'] })
    await expect.poll(() => h.lives.some((live) => live?.phase === 'download')).toBe(true)
    h.tester.cancel()
    const run = await h.finished
    await h.tester.settled()
    expect(run.status).toBe('cancelled')
    expect(run.reason).toBeUndefined()
    expect(h.saved).toEqual([])
    expect(h.resumed).toEqual([['d1']])
  })

  test('a test that can’t start its downloads’ pause fails cleanly', async () => {
    server = await new SpeedServer().start()
    const h = harness(server, {
      pauseDownloads: async () => {
        throw new Error('disk full')
      }
    })
    h.tester.start({ scope: 'link', networkIds: ['a'] })
    const run = await h.finished
    expect(run).toMatchObject({ status: 'failed', reason: 'disk full' })
  })

  test('every network at once: the total, and each network’s part of it', async () => {
    test.skip(!B, 'needs a LAN address to act as the second network')
    server = await new SpeedServer({
      rates: { '127.0.0.1': 2.5 * MB, [B!.addresses[0].address]: 2.5 * MB },
      shared: 3 * MB
    }).start()
    const h = harness(server)
    h.tester.start({ scope: 'combined', networkIds: ['a', 'b', 'gone'] })
    const run = await h.finished
    expect(run.status).toBe('done')
    near(run.combined?.downloadBytesPerSec, 3 * MB, 0.25)
    near(run.combined?.uploadBytesPerSec, 3 * MB, 0.4)
    const [a, b, gone] = run.links
    expect(gone).toMatchObject({ status: 'unavailable', reason: 'Not connected' })
    expect(run.combined!.share).toEqual({ a: a.bytesDown, b: b.bytesDown })
    expect(a.latencyMs).toBeDefined()
    expect(b.downloadBytesPerSec).toBeDefined()
    expect(h.counted.a).toBeGreaterThanOrEqual(a.bytesDown + a.bytesUp)
    // The window saw each network's part grow while the download ran, not only at its end.
    const during = h.lives.filter(
      (live) => live?.phase === 'download' && (live.share.a ?? 0) > 0 && (live.share.b ?? 0) > 0
    )
    expect(during.length).toBeGreaterThan(3)
  })

  test('the next test can start as soon as the window hears the last one ended', async () => {
    // Paced, so each test runs its full time rather than reaching its data cap at once.
    server = await new SpeedServer({ rates: { '127.0.0.1': 4 * MB } }).start()
    let next: string | undefined
    let refused: unknown
    const h = harness(server, {
      // Saving takes a while; the window may start another test meanwhile.
      save: () => new Promise((resolve) => setTimeout(resolve, 300)),
      onLive: (live) => {
        if (live !== null || next !== undefined || refused !== undefined) return
        try {
          next = h.tester.start({ scope: 'link', networkIds: ['a'] })
        } catch (error) {
          refused = error
        }
      }
    })
    const first = h.tester.start({ scope: 'link', networkIds: ['a'] })
    await expect.poll(() => next ?? refused, { timeout: 15_000 }).toBeDefined()
    expect(refused).toBeUndefined()
    expect(next).not.toBe(first)
    // The first test's end doesn't count as the second's: the second is still running.
    await h.finished
    expect(() => h.tester.start({ scope: 'link', networkIds: ['a'] })).toThrow('already running')
    h.tester.cancel()
    await h.tester.settled()
  })

  test('every network at once, when none can be tested or none answers', async () => {
    server = await new SpeedServer({ failFrom: { '127.0.0.1': 503 } }).start()
    const none = harness(server)
    none.tester.start({ scope: 'combined', networkIds: ['gone'] })
    expect(await none.finished).toMatchObject({
      status: 'unavailable',
      reason: 'No network can be tested'
    })
    const silent = harness(server)
    silent.tester.start({ scope: 'combined', networkIds: ['a'] })
    const run = await silent.finished
    expect(run).toMatchObject({ status: 'failed', reason: 'No network answered' })
    expect(run.links[0]).toMatchObject({ status: 'failed', reason: 'The test server answered 503' })
  })

  test('every network at once, when one fails partway', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    const h = harness(server)
    h.tester.start({ scope: 'combined', networkIds: ['a'] })
    await expect.poll(() => h.lives.some((live) => live?.phase === 'download')).toBe(true)
    server.options.failFrom = { '127.0.0.1': 500 }
    server.dropConnections()
    const run = await h.finished
    expect(run.status).toBe('failed')
    expect(run.links[0]).toMatchObject({ status: 'failed', reason: 'The test server answered 500' })
    expect(run.combined?.uploadBytesPerSec).toBeUndefined()
  })

  test('through system merge: only while it is on, and the helper says which networks carried it', async () => {
    server = await new SpeedServer({ rates: { '127.0.0.1': 2 * MB } }).start()
    const off = harness(server, {
      systemMerge: async () => ({ on: false, reason: 'Another VPN is on', limited: false })
    })
    off.tester.start({ scope: 'system', networkIds: [] })
    expect(await off.finished).toMatchObject({ status: 'unavailable', reason: 'Another VPN is on' })
    const offQuietly = harness(server, { systemMerge: async () => ({ on: false, limited: false }) })
    offQuietly.tester.start({ scope: 'system', networkIds: [] })
    expect((await offQuietly.finished).reason).toBe('System merge is off')
    const noHelper = harness(server)
    noHelper.tester.start({ scope: 'system', networkIds: [] })
    expect((await noHelper.finished).reason).toBe('The system-wide helper isn’t running')

    const state: SystemMergeState = { on: true, stickySites: true, limited: true }
    // The helper sees the test on en0 only, as a sticky site would put it.
    const traffic: Record<string, LinkTraffic> = {
      en0: { rxBps: 2 * MB, txBps: 2 * MB, linkRxBps: 2 * MB, linkTxBps: 2 * MB },
      en1: { rxBps: 0, txBps: 0, linkRxBps: 0, linkTxBps: 0 }
    }
    const on = harness(
      server,
      {
        systemMerge: async () => state,
        traffic: async () => traffic
      },
      [{ ...A, id: 'en0', device: 'en0' }]
    )
    on.tester.start({ scope: 'system', networkIds: ['ignored'] })
    const run = await on.finished
    expect(run.status).toBe('done')
    expect(run.notes.sort()).toEqual(['speed-limit', 'sticky-sites-on'])
    near(run.combined?.downloadBytesPerSec, 2 * MB, 0.3)
    near(run.combined?.uploadBytesPerSec, 2 * MB, 0.4)
    expect(run.combined?.latencyMs).toBeDefined()
    expect(Object.keys(run.combined!.share)).toEqual(['en0', 'en1'])
    expect(run.links.map((link) => [link.networkId, link.name])).toEqual([['en0', 'a name']])
    expect(run.links[0].bytesDown).toBeGreaterThan(0)
    // Nothing is counted against a network's data limit: the helper chose the networks.
    expect(on.counted).toEqual({})
    expect(on.lives.some((live) => live && Object.keys(live.share).includes('en0'))).toBe(true)
    expect(SYSTEM_LANE).toBe('system')
  })

  test('through system merge, when the transfer fails', async () => {
    server = await new SpeedServer({ delayMs: { '127.0.0.1': () => 0 } }).start()
    const h = harness(server, {
      systemMerge: async () => ({ on: true, stickySites: false, limited: false }),
      traffic: async () => ({ unseen: { rxBps: 0, txBps: 0, linkRxBps: 0, linkTxBps: 0 } })
    })
    h.tester.start({ scope: 'system', networkIds: [] })
    await expect.poll(() => h.lives.some((live) => live?.phase === 'download')).toBe(true)
    server.options.failFrom = { '127.0.0.1': 502 }
    server.dropConnections()
    const run = await h.finished
    expect(run).toMatchObject({
      status: 'failed',
      reason: 'The test server answered 502',
      notes: []
    })
  })
})

test.describe('history @smoke', () => {
  test('kept newest first, read leniently, and cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mergelane-speed-'))
    const path = join(dir, 'speed-tests.json')
    try {
      let now = 10_000
      const history = new SpeedTestHistory(path, () => now)
      expect(await history.list()).toEqual([])
      const run = (id: string, startedAt: number): SpeedTestRun => ({
        id,
        scope: 'link',
        server: 'https://speed.cloudflare.com',
        startedAt,
        finishedAt: startedAt + 1,
        status: 'done',
        links: [],
        notes: []
      })
      await history.add(run('old', 1_000))
      await history.add(run('new', 2_000))
      expect((await history.list()).map((each) => each.id)).toEqual(['new', 'old'])
      now = 1_500 + 90 * 24 * 60 * 60_000
      expect((await history.list()).map((each) => each.id)).toEqual(['new'])
      await history.clear()
      expect(await history.list()).toEqual([])
      await writeFile(path, 'not json')
      expect(await new SpeedTestHistory(path).list()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
