import { describe, expect, it } from 'vitest'
import {
  appendNetworkEvents,
  dropoutsSince,
  fastestToday,
  heldSpeed,
  HELD_SECONDS,
  localDay,
  NETWORK_EVENTS_KEPT,
  NETWORK_EVENTS_MAX_AGE_MS,
  pruneNetworkEvents,
  raiseFastest,
  reconcileAtLaunch,
  sanitizeNetworkActivity,
  type NetworkEvent
} from './networkActivity'
import type { NetworkInterfaceInfo } from './types'

const NOW = new Date(2026, 10, 11, 15).getTime()
const HOUR = 3600e3

const iface = (id: string, kind: NetworkInterfaceInfo['kind'] = 'wifi'): NetworkInterfaceInfo => ({
  id,
  device: id,
  displayName: `${id} name`,
  addresses: [],
  kind
})
const event = (fields: Partial<NetworkEvent>): NetworkEvent => ({
  id: 'en0',
  osName: 'Wi-Fi',
  kind: 'wifi',
  change: 'dropped',
  at: NOW,
  left: 0,
  ...fields
})

describe('the network log', () => {
  it('logs drops, recoveries with their downtime, and newcomers', () => {
    const a = iface('a')
    const b = iface('b', 'usb')
    let log = appendNetworkEvents([], [a, b], [a], NOW)
    expect(log).toEqual([
      { id: 'b', osName: 'b name', kind: 'usb', change: 'dropped', at: NOW, left: 1 }
    ])
    expect(appendNetworkEvents(log, [a], [a], NOW + 1)).toBe(log)
    log = appendNetworkEvents(log, [a], [a, b, iface('c')], NOW + 5000)
    expect(log.slice(1).map((each) => [each.id, each.change, each.downForMs])).toEqual([
      ['b', 'recovered', 5000],
      ['c', 'joined', undefined]
    ])
  })

  it('keeps a week, and at most NETWORK_EVENTS_KEPT', () => {
    const old = event({ at: NOW - NETWORK_EVENTS_MAX_AGE_MS })
    const fresh = event({ at: NOW - HOUR })
    expect(pruneNetworkEvents([old, fresh], NOW)).toEqual([fresh])
    const kept = [fresh]
    expect(pruneNetworkEvents(kept, NOW)).toBe(kept)
    const many = Array.from({ length: NETWORK_EVENTS_KEPT + 3 }, (_, index) =>
      event({ at: NOW - index })
    ).reverse()
    const pruned = pruneNetworkEvents(many, NOW)
    expect(pruned).toHaveLength(NETWORK_EVENTS_KEPT)
    expect(pruned.at(-1)!.at).toBe(NOW)
  })

  it('at launch, a network the last launch saw drop and that is here again came back while closed', () => {
    const log = [
      event({ id: 'en7', kind: 'usb', at: NOW - 2 * HOUR }),
      event({ id: 'en5', kind: 'ethernet', at: NOW - HOUR }),
      event({ id: 'en5', kind: 'ethernet', change: 'recovered', at: NOW - 1000 })
    ]
    const next = reconcileAtLaunch(log, [iface('en7', 'usb'), iface('en5', 'ethernet')], NOW)
    expect(next.slice(3)).toEqual([
      {
        id: 'en7',
        osName: 'en7 name',
        kind: 'usb',
        change: 'recovered',
        at: NOW,
        whileClosed: true,
        left: 2
      }
    ])
    // Nothing to say: the same log.
    expect(reconcileAtLaunch(next, [iface('en0')], NOW)).toBe(next)
  })

  it('counts the dropouts since a moment, and whether they are all back', () => {
    const events = [
      event({ at: NOW - 30 * HOUR }),
      event({ id: 'en7', at: NOW - 2 * HOUR }),
      event({ id: 'en7', change: 'recovered', at: NOW - HOUR }),
      event({ id: 'en0', change: 'joined', at: NOW - HOUR })
    ]
    expect(dropoutsSince(events, NOW - 24 * HOUR)).toEqual({ count: 1, allBack: true })
    expect(dropoutsSince([...events, event({ id: 'en5', at: NOW })], NOW - 24 * HOUR)).toEqual({
      count: 2,
      allBack: false
    })
    expect(dropoutsSince([], NOW)).toEqual({ count: 0, allBack: true })
  })
})

describe('the fastest merged speed', () => {
  it('names the local calendar day', () => {
    expect(localDay(NOW)).toBe('2026-11-11')
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  })

  it('counts only a speed held for HELD_SECONDS', () => {
    expect(heldSpeed([])).toBeUndefined()
    expect(heldSpeed(Array(HELD_SECONDS - 1).fill(10))).toBeUndefined()
    expect(heldSpeed([10, 10, 0, 10, 10])).toBeUndefined()
    expect(heldSpeed([99, 10, 20, 30, 40, 50])).toBe(30)
  })

  it('rises through the day, starts over the next, and is the same object when unchanged', () => {
    expect(raiseFastest(undefined, undefined, NOW)).toBeUndefined()
    expect(raiseFastest(undefined, 0, NOW)).toBeUndefined()
    const first = raiseFastest(undefined, 100, NOW)!
    expect(first).toEqual({ day: '2026-11-11', bytesPerSec: 100 })
    expect(raiseFastest(first, 50, NOW)).toBe(first)
    expect(raiseFastest(first, 200, NOW)).toEqual({ day: '2026-11-11', bytesPerSec: 200 })
    expect(raiseFastest(first, 10, NOW + 24 * HOUR)).toEqual({
      day: '2026-11-12',
      bytesPerSec: 10
    })
    expect(fastestToday(first, NOW)).toBe(100)
    expect(fastestToday(first, NOW + 24 * HOUR)).toBeUndefined()
    expect(fastestToday(undefined, NOW)).toBeUndefined()
  })
})

describe('the saved file', () => {
  it('keeps what is well formed, sorted and bounded, and drops the rest', () => {
    const saved = {
      events: [
        event({ id: 'en7', change: 'recovered', at: NOW - 1000, downForMs: 5, whileClosed: true }),
        event({ at: NOW - 2000, downForMs: 9 }),
        { ...event({}), kind: 'satellite' },
        { ...event({}), change: 'vanished' },
        { ...event({}), id: '' },
        { ...event({}), osName: 3 },
        { ...event({}), at: -1 },
        { ...event({}), left: Number.NaN },
        'nonsense',
        event({ at: NOW - NETWORK_EVENTS_MAX_AGE_MS - 1 })
      ],
      fastest: { day: '2026-11-11', bytesPerSec: 42 }
    }
    expect(sanitizeNetworkActivity(saved, NOW)).toEqual({
      events: [
        // A drop has no downtime; only a recovery does.
        event({ at: NOW - 2000 }),
        event({ id: 'en7', change: 'recovered', at: NOW - 1000, downForMs: 5, whileClosed: true })
      ],
      fastest: { day: '2026-11-11', bytesPerSec: 42 }
    })
  })

  it('reads anything else as empty', () => {
    expect(sanitizeNetworkActivity(undefined, NOW)).toEqual({ events: [] })
    expect(sanitizeNetworkActivity([], NOW)).toEqual({ events: [] })
    expect(
      sanitizeNetworkActivity({ events: 'x', fastest: { day: 'today', bytesPerSec: 1 } }, NOW)
    ).toEqual({ events: [] })
    expect(
      sanitizeNetworkActivity({ fastest: { day: '2026-11-11', bytesPerSec: 0 } }, NOW)
    ).toEqual({ events: [] })
  })
})
