import { describe, expect, it } from 'vitest'
import { activeTime, savedByMerging, UsageTally, withPending, type UsageReport } from './usage'

// Local times, so days are the computer's own whatever time zone the tests run in.
const at = (hour: number, minute: number, second = 0, ms = 0): number =>
  new Date(2026, 10, 26, hour, minute, second, ms).getTime()
const TODAY = '2026-11-26'
const MB = 1024 * 1024

describe('savedByMerging', () => {
  it('is nothing when one network carried everything', () => {
    expect(savedByMerging(60_000, [10 * MB])).toBe(0)
    expect(savedByMerging(60_000, [10 * MB, 0])).toBe(0)
  })

  it('is the time again when two networks carried half each', () => {
    expect(savedByMerging(60_000, [5 * MB, 5 * MB])).toBe(60_000)
  })

  it('is time × (total ÷ busiest − 1)', () => {
    // 3 of 4 on the busiest: alone it would have taken 4/3 as long.
    expect(savedByMerging(30_000, [3 * MB, 1 * MB])).toBe(10_000)
    expect(savedByMerging(1000, [1, 1, 1])).toBe(2000)
  })

  it('is nothing with no time or no bytes', () => {
    expect(savedByMerging(0, [1, 1])).toBe(0)
    expect(savedByMerging(-5, [1, 1])).toBe(0)
    expect(savedByMerging(Number.NaN, [1, 1])).toBe(0)
    expect(savedByMerging(1000, [])).toBe(0)
    expect(savedByMerging(1000, [0, 0])).toBe(0)
  })
})

describe('activeTime', () => {
  it('is started to finished, less the pauses', () => {
    expect(activeTime({ startedAt: 1000, completedAt: 61_000 })).toBe(60_000)
    expect(activeTime({ startedAt: 1000, completedAt: 61_000, totalPausedMs: 20_000 })).toBe(40_000)
  })

  it('is nothing until it finished, and never less than nothing', () => {
    expect(activeTime({ startedAt: 1000 })).toBe(0)
    expect(activeTime({ startedAt: 5000, completedAt: 1000 })).toBe(0)
  })
})

describe('UsageTally', () => {
  it('counts bytes by local day and network, and drains them once', () => {
    const tally = new UsageTally()
    tally.add('en0', 100, at(10, 0, 1))
    tally.add('en0', 50, at(10, 0, 2))
    tally.add('en7', 30, at(10, 0, 2))
    tally.add('en0', 0, at(10, 0, 3))
    tally.add('en0', -4, at(10, 0, 3))
    const { bytes } = tally.drain(at(10, 0, 5))
    expect(bytes).toEqual([
      { day: TODAY, networkId: 'en0', bytes: 150 },
      { day: TODAY, networkId: 'en7', bytes: 30 }
    ])
    expect(tally.drain(at(10, 0, 6)).bytes).toEqual([])
  })

  it('puts bytes either side of local midnight on their own days', () => {
    const tally = new UsageTally()
    tally.add('en0', 10, at(23, 59, 59))
    tally.add('en0', 20, new Date(2026, 10, 27, 0, 0, 1).getTime())
    const { bytes, saved } = tally.drain(new Date(2026, 10, 27, 0, 5).getTime())
    expect(bytes).toEqual([
      { day: TODAY, networkId: 'en0', bytes: 10 },
      { day: '2026-11-27', networkId: 'en0', bytes: 20 }
    ])
    expect(saved.map((day) => [day.day, day.busyMs])).toEqual([
      [TODAY, 1000],
      ['2026-11-27', 1000]
    ])
  })

  it('works a minute out once it has ended: the seconds with traffic, saved against the busiest', () => {
    const tally = new UsageTally()
    // 10 seconds with traffic, half on each network.
    for (let second = 0; second < 10; second++) {
      tally.add('en0', 500, at(10, 0, second, 100))
      tally.add('en7', 500, at(10, 0, second, 900))
    }
    // Still the same minute: nothing of it is worked out yet.
    expect(tally.drain(at(10, 0, 30)).saved).toEqual([])
    expect(tally.drain(at(10, 1, 0)).saved).toEqual([
      { day: TODAY, busyMs: 10_000, savedMs: 10_000, peakBytesPerSec: 0 }
    ])
  })

  it('never saves more than the minute: overlapping downloads count each second once', () => {
    const tally = new UsageTally()
    for (let second = 0; second < 60; second++) {
      // Two downloads at once, each split over both networks.
      for (const network of ['en0', 'en7', 'en0', 'en7']) tally.add(network, 100, at(10, 0, second))
    }
    const [day] = tally.drain(at(10, 1, 0)).saved
    expect(day.busyMs).toBe(60_000)
    expect(day.savedMs).toBe(60_000)
  })

  it('closes a minute when the next one starts, and adds minutes up per day', () => {
    const tally = new UsageTally()
    tally.add('en0', 300, at(10, 0, 5))
    tally.add('en7', 100, at(10, 0, 5))
    tally.add('en0', 100, at(10, 1, 5))
    const { saved } = tally.drain(at(10, 2, 0))
    // Minute one: 1 s, 3 of 4 on en0, so a third of a second; minute two: one network, nothing.
    expect(saved).toEqual([{ day: TODAY, busyMs: 2000, savedMs: 333, peakBytesPerSec: 0 }])
  })

  it('closes the minute counting now at quit', () => {
    const tally = new UsageTally()
    tally.add('en0', 1, at(10, 0, 5))
    tally.add('en7', 1, at(10, 0, 5))
    expect(tally.drain(at(10, 0, 10), true).saved).toEqual([
      { day: TODAY, busyMs: 1000, savedMs: 1000, peakBytesPerSec: 0 }
    ])
  })

  it('closes the minute when the clock goes back before it', () => {
    const tally = new UsageTally()
    tally.add('en0', 1, at(10, 30, 5))
    expect(tally.drain(at(10, 0, 0)).saved).toEqual([
      { day: TODAY, busyMs: 1000, savedMs: 0, peakBytesPerSec: 0 }
    ])
    // A byte from the earlier time starts a minute of its own.
    tally.add('en0', 1, at(10, 30, 6))
    tally.add('en0', 1, at(10, 0, 1))
    expect(tally.drain(at(10, 5, 0)).saved).toEqual([
      { day: TODAY, busyMs: 2000, savedMs: 0, peakBytesPerSec: 0 }
    ])
  })

  it('keeps the day’s fastest merged speed', () => {
    const tally = new UsageTally()
    tally.peak(2 * MB, at(9, 0))
    tally.peak(5.4 * MB, at(9, 1))
    tally.peak(3 * MB, at(9, 2))
    tally.peak(0, at(9, 3))
    tally.peak(Number.NaN, at(9, 3))
    expect(tally.drain(at(9, 5)).saved).toEqual([
      { day: TODAY, busyMs: 0, savedMs: 0, peakBytesPerSec: Math.round(5.4 * MB) }
    ])
  })

  it('says what is pending without changing it, the minute counting now as if ended', () => {
    const tally = new UsageTally()
    tally.add('en0', 10, at(10, 0, 1))
    tally.add('en7', 10, at(10, 0, 1))
    tally.add('en0', 10, at(10, 1, 1))
    tally.peak(100, at(10, 1, 2))
    const pending = tally.pending()
    expect(pending.bytes).toEqual([
      { day: TODAY, networkId: 'en0', bytes: 20 },
      { day: TODAY, networkId: 'en7', bytes: 10 }
    ])
    expect(pending.saved).toEqual([
      { day: TODAY, busyMs: 2000, savedMs: 1000, peakBytesPerSec: 100 }
    ])
    // Changing what pending returned changes nothing counted.
    pending.bytes[0].bytes = 0
    expect(tally.pending().bytes[0].bytes).toBe(20)
    // Drained once both minutes have ended, it is what pending said.
    expect(tally.drain(at(10, 2, 0))).toEqual({
      bytes: [
        { day: TODAY, networkId: 'en0', bytes: 20 },
        { day: TODAY, networkId: 'en7', bytes: 10 }
      ],
      saved: [{ day: TODAY, busyMs: 2000, savedMs: 1000, peakBytesPerSec: 100 }]
    })
  })

  it('says a minute is pending on a day with nothing closed yet', () => {
    const tally = new UsageTally()
    tally.add('en0', 10, at(10, 0, 1))
    expect(tally.pending().saved).toEqual([
      { day: TODAY, busyMs: 1000, savedMs: 0, peakBytesPerSec: 0 }
    ])
    expect(new UsageTally().pending()).toEqual({ bytes: [], saved: [] })
  })

  it('takes back counts that could not be written', () => {
    const tally = new UsageTally()
    tally.add('en0', 10, at(10, 0, 1))
    tally.peak(50, at(10, 0, 1))
    const failed = tally.drain(at(10, 1, 0))
    tally.add('en0', 5, at(10, 1, 1))
    tally.restore(failed)
    tally.restore({
      bytes: [{ day: TODAY, networkId: 'en7', bytes: 3 }],
      saved: [{ day: TODAY, busyMs: 1000, savedMs: 500, peakBytesPerSec: 20 }]
    })
    expect(tally.drain(at(10, 1, 30))).toEqual({
      bytes: [
        { day: TODAY, networkId: 'en0', bytes: 15 },
        { day: TODAY, networkId: 'en7', bytes: 3 }
      ],
      saved: [{ day: TODAY, busyMs: 2000, savedMs: 500, peakBytesPerSec: 50 }]
    })
  })
})

describe('withPending', () => {
  const written: UsageReport = {
    networks: [
      { day: '2026-11-25', networkId: 'en0', bytes: 100, name: 'Wi-Fi', kind: 'wifi' },
      { day: TODAY, networkId: 'en0', bytes: 10, name: 'Wi-Fi', kind: 'wifi' }
    ],
    days: [
      { day: '2026-11-25', busyMs: 5000, savedMs: 1000, peakBytesPerSec: 900 },
      { day: TODAY, busyMs: 1000, savedMs: 0, peakBytesPerSec: 50 }
    ]
  }
  const names = (id: string): { name: string; kind: 'usb' } => ({
    name: `iPhone ${id}`,
    kind: 'usb'
  })

  it('adds what is counted to what was written, by day and network', () => {
    const report = withPending(
      written,
      {
        bytes: [
          { day: TODAY, networkId: 'en0', bytes: 5 },
          { day: TODAY, networkId: 'en7', bytes: 7 }
        ],
        saved: [
          { day: TODAY, busyMs: 2000, savedMs: 300, peakBytesPerSec: 40 },
          { day: '2026-11-27', busyMs: 1000, savedMs: 0, peakBytesPerSec: 70 }
        ]
      },
      names
    )
    expect(report.networks).toEqual([
      written.networks[0],
      { day: TODAY, networkId: 'en0', bytes: 15, name: 'Wi-Fi', kind: 'wifi' },
      { day: TODAY, networkId: 'en7', bytes: 7, name: 'iPhone en7', kind: 'usb' }
    ])
    expect(report.days).toEqual([
      written.days[0],
      { day: TODAY, busyMs: 3000, savedMs: 300, peakBytesPerSec: 50 },
      { day: '2026-11-27', busyMs: 1000, savedMs: 0, peakBytesPerSec: 70 }
    ])
    // What was written is left as it was.
    expect(written.networks[1].bytes).toBe(10)
    expect(written.days[1].busyMs).toBe(1000)
  })

  it('raises a day’s fastest when the counted one is faster', () => {
    const report = withPending(
      written,
      { bytes: [], saved: [{ day: TODAY, busyMs: 0, savedMs: 0, peakBytesPerSec: 80 }] },
      names
    )
    expect(report.days[1].peakBytesPerSec).toBe(80)
  })
})
