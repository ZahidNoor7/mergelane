// Layer B (Node only, no Electron): what the dashboard works out from the store
// (src/renderer/src/utils/dashboard.ts) — the downloads it lists, each network's speed and
// condition, the failover log, and the merged-traffic samples.
import { expect, test } from '@playwright/test'
import type {
  DownloadState,
  HttpDownloadNetwork,
  NetworkInterfaceInfo,
  NetworkStatus
} from '../src/shared/types'
import {
  activeDownloads,
  appendLinkSamples,
  appendNetworkEvents,
  combinedHistory,
  formatDowntime,
  NETWORK_EVENTS_KEPT,
  networkSpeeds,
  networkSummaries,
  type NetworkEvent
} from '../src/renderer/src/utils/dashboard'

const MiB = 1024 ** 2

function net(
  id: string,
  speed: number,
  status: NetworkStatus = 'on',
  enabled = true
): HttpDownloadNetwork {
  return {
    id,
    label: `${id}-os`,
    kind: 'ethernet',
    enabled,
    status,
    bytesDownloaded: 0,
    speedBytesPerSec: speed,
    retries: 0,
    transfer: 'http'
  }
}

/** Just the fields the dashboard reads, as an HTTP download. */
function download(
  id: string,
  fields: Partial<DownloadState> & { networks?: HttpDownloadNetwork[] } = {}
): DownloadState {
  return {
    id,
    url: `https://example.com/${id}`,
    fileName: `${id}.bin`,
    destinationPath: `/tmp/${id}.bin`,
    totalBytes: 10 * MiB,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    status: 'downloading',
    startedAt: 0,
    kind: 'http',
    networks: [],
    streams: [],
    peakStreams: 0,
    blocks: [],
    totalBlocks: 0,
    blockSizeBytes: 0,
    ...fields
  } as DownloadState
}

function iface(id: string, kind: NetworkInterfaceInfo['kind'] = 'wifi'): NetworkInterfaceInfo {
  return { id, device: id, displayName: `${id} name`, addresses: [], kind }
}

test.describe('dashboard model @smoke', () => {
  test('active downloads are split by state, with the total speed and when all are done', () => {
    const active = activeDownloads([
      download('late', { startedAt: 3, speedBytesPerSec: MiB, bytesDownloaded: 4 * MiB }),
      download('early', { startedAt: 1, speedBytesPerSec: MiB, bytesDownloaded: 6 * MiB }),
      download('second-in-queue', { status: 'queued', startedAt: 0, queuedAt: 20 }),
      download('first-in-queue', { status: 'queued', startedAt: 5, queuedAt: 10 }),
      download('held', { status: 'paused' }),
      download('broken', { status: 'error' }),
      download('broken-too', { status: 'error' })
    ])
    expect(active.running.map((entry) => entry.id)).toEqual(['early', 'late'])
    expect(active.queued.map((entry) => entry.id)).toEqual(['first-in-queue', 'second-in-queue'])
    expect(active.paused.map((entry) => entry.id)).toEqual(['held'])
    expect(active.failed).toBe(2)
    expect(active.totalSpeed).toBe(2 * MiB)
    // 4 + 6 MiB left at 2 MiB/s.
    expect(active.etaSeconds).toBe(5)
  })

  test('a queued download with no queue place waits behind those that have one', () => {
    const active = activeDownloads([
      download('placed', { status: 'queued', queuedAt: 5 }),
      download('unplaced', { status: 'queued' })
    ])
    expect(active.queued.map((entry) => entry.id)).toEqual(['unplaced', 'placed'])
  })

  test('there is no telling when all are done with a size unknown, or nothing moving', () => {
    expect(
      activeDownloads([
        download('sized', { speedBytesPerSec: MiB }),
        download('unsized', { totalBytes: 0, speedBytesPerSec: MiB })
      ]).etaSeconds
    ).toBeUndefined()
    expect(activeDownloads([download('stalled')]).etaSeconds).toBeUndefined()
    const idle = activeDownloads([])
    expect(idle).toEqual({ running: [], paused: [], queued: [], failed: 0, totalSpeed: 0 })
    // Already past its size: nothing left, not a negative time.
    expect(
      activeDownloads([download('over', { bytesDownloaded: 11 * MiB, speedBytesPerSec: MiB })])
        .etaSeconds
    ).toBe(0)
  })

  test('each network’s speed adds up over the running downloads only', () => {
    const speeds = networkSpeeds([
      download('one', { networks: [net('a', 100), net('b', 50)] }),
      download('two', { networks: [net('a', 25)] }),
      download('held', { status: 'paused', networks: [net('a', 999)] })
    ])
    expect([...speeds]).toEqual([
      ['a', 125],
      ['b', 50]
    ])
  })

  test('the last minute adds up per network, each download lined up at its newest second', () => {
    const history = combinedHistory([
      download('long', { speedHistory: { a: [1, 2, 3, 4], b: [10, 10, 10, 10] } }),
      download('short', { speedHistory: { a: [100, 200] } }),
      download('held', { status: 'paused', speedHistory: { a: [5000, 5000, 5000, 5000, 5000] } }),
      download('fresh')
    ])
    expect(history).toEqual({ a: [1, 2, 103, 204], b: [10, 10, 10, 10] })
  })

  test('the last minute is never longer than a minute', () => {
    const series = Array.from({ length: 75 }, (_, index) => index)
    const history = combinedHistory([download('long', { speedHistory: { a: series } })])
    expect(history.a).toHaveLength(60)
    expect(history.a[0]).toBe(15)
    expect(history.a.at(-1)).toBe(74)
    expect(combinedHistory([])).toEqual({})
  })

  test('a network is up, limited, paused, unreachable or gone', () => {
    const summaries = networkSummaries(
      [iface('up'), iface('capped', 'usb'), iface('used'), iface('stuck'), iface('limit')],
      [
        download('one', {
          networks: [
            net('up', 300),
            net('stuck', 0, 'unreachable'),
            net('limit', 0, 'limit'),
            net('gone', 0, 'offline'),
            // Switched off by the user: it says nothing about the network.
            net('ignored', 0, 'offline', false)
          ]
        }),
        // Not running: its network statuses are old news.
        download('held', { status: 'paused', networks: [net('capped', 0, 'unreachable')] })
      ],
      {
        capped: { speedLimit: 2 * MiB },
        used: { dataLimit: 100 },
        up: { dataLimit: 1000 }
      },
      { used: 100, up: 999 }
    )
    expect(summaries).toEqual([
      { id: 'up', kind: 'wifi', osName: 'up name', condition: 'up', speed: 300 },
      {
        id: 'capped',
        kind: 'usb',
        osName: 'capped name',
        condition: 'limited',
        speed: 0,
        speedLimit: 2 * MiB
      },
      { id: 'used', kind: 'wifi', osName: 'used name', condition: 'paused', speed: 0 },
      { id: 'stuck', kind: 'wifi', osName: 'stuck name', condition: 'unreachable', speed: 0 },
      { id: 'limit', kind: 'wifi', osName: 'limit name', condition: 'paused', speed: 0 },
      { id: 'gone', kind: 'ethernet', osName: 'gone-os', condition: 'offline', speed: 0 }
    ])
  })

  test('a network one download can’t reach the server on, but another uses, is up', () => {
    const [summary] = networkSummaries(
      [iface('a')],
      [
        download('one', { networks: [net('a', 0, 'unreachable')] }),
        download('two', { networks: [net('a', 50)] })
      ],
      {},
      {}
    )
    expect(summary.condition).toBe('up')
  })

  test('a gone network two downloads list is listed once', () => {
    const summaries = networkSummaries(
      [],
      [
        download('one', { networks: [net('gone', 0, 'offline')] }),
        download('two', { networks: [net('gone', 0, 'offline')] })
      ],
      {},
      {}
    )
    expect(summaries.map((summary) => summary.id)).toEqual(['gone'])
  })

  test('networks that drop, come back and turn up are logged, with how long one was gone', () => {
    const a = iface('a')
    const b = iface('b', 'usb')
    const c = iface('c', 'ethernet')
    let log: NetworkEvent[] = []
    log = appendNetworkEvents(log, [a, b], [a], 1_000)
    expect(log).toEqual([
      { id: 'b', osName: 'b name', kind: 'usb', change: 'dropped', at: 1_000, left: 1 }
    ])
    // Nothing changed: the same log, so the store has nothing new to say.
    expect(appendNetworkEvents(log, [a], [a], 2_000)).toBe(log)
    log = appendNetworkEvents(log, [a], [a, b, c], 15_000)
    expect(log.slice(1)).toEqual([
      {
        id: 'b',
        osName: 'b name',
        kind: 'usb',
        change: 'recovered',
        at: 15_000,
        downForMs: 14_000,
        left: 3
      },
      { id: 'c', osName: 'c name', kind: 'ethernet', change: 'joined', at: 15_000, left: 3 }
    ])
    // Back again after being back: a drop, then a fresh recovery from that drop.
    log = appendNetworkEvents(log, [a, b, c], [], 20_000)
    expect(log.slice(-3).map((event) => [event.id, event.change, event.left])).toEqual([
      ['a', 'dropped', 0],
      ['b', 'dropped', 0],
      ['c', 'dropped', 0]
    ])
    log = appendNetworkEvents(log, [], [a], 21_000)
    expect(log.at(-1)).toMatchObject({ id: 'a', change: 'recovered', downForMs: 1_000 })
  })

  test('the log keeps only the newest changes', () => {
    let log: NetworkEvent[] = []
    const a = iface('a')
    for (let at = 0; at < NETWORK_EVENTS_KEPT + 6; at++) {
      log =
        at % 2 === 0 ? appendNetworkEvents(log, [a], [], at) : appendNetworkEvents(log, [], [a], at)
    }
    expect(log).toHaveLength(NETWORK_EVENTS_KEPT)
    expect(log.at(-1)!.at).toBe(NETWORK_EVENTS_KEPT + 5)
  })

  test('how long a network was gone reads the way people say it', () => {
    expect(formatDowntime(0)).toBe('1s')
    expect(formatDowntime(14_200)).toBe('14s')
    expect(formatDowntime(59_400)).toBe('59s')
    expect(formatDowntime(60_000)).toBe('1 min')
    expect(formatDowntime(42 * 60_000)).toBe('42 min')
    expect(formatDowntime(3 * 3_600_000)).toBe('3 h')
  })

  test('merged traffic keeps a minute per link, and a link that leaves takes its history', () => {
    let history: Record<string, number[]> = {}
    history = appendLinkSamples(history, [
      { name: 'en0', rxBps: 10 },
      { name: 'en7', rxBps: -5 }
    ])
    expect(history).toEqual({ en0: [10], en7: [0] })
    history = appendLinkSamples(history, [{ name: 'en0', rxBps: 20 }])
    expect(history).toEqual({ en0: [10, 20] })
    for (let second = 0; second < 5; second++) {
      history = appendLinkSamples(history, [{ name: 'en0', rxBps: second }], 3)
    }
    expect(history).toEqual({ en0: [2, 3, 4] })
  })
})
