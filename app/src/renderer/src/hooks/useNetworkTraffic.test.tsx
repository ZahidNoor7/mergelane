import type { TrafficRate } from '@shared/interfaceCounters'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNetworkTraffic } from './useNetworkTraffic'

// The Dashboard's total speed, all apps (ADR-0070), and its last minute (ADR-0071): each network's traffic from the
// main process, once a second.

let answer: () => Promise<Record<string, TrafficRate> | null>
const networkTraffic = vi.fn(() => answer())

beforeEach(() => {
  vi.useFakeTimers()
  answer = () => Promise.resolve({ en0: { rx: 100, tx: 10 } })
  window.mergelane = { ...window.mergelane, networkTraffic } as unknown as typeof window.mergelane
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useNetworkTraffic', () => {
  it('asks at once and every second while active, and stops when not', async () => {
    const { result, rerender } = renderHook(({ active }) => useNetworkTraffic(active), {
      initialProps: { active: true }
    })
    expect(result.current.traffic).toBeUndefined()
    await act(async () => {})
    expect(result.current.traffic).toEqual({ en0: { rx: 100, tx: 10 } })
    expect(networkTraffic).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(networkTraffic).toHaveBeenCalledTimes(3)
    rerender({ active: false })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(networkTraffic).toHaveBeenCalledTimes(3)
  })

  it('keeps a minute of each network’s speed, in and out together, every series as long', async () => {
    let second = 0
    answer = () => {
      second += 1
      // en7 turns up in the third second; en0 is missing from the fourth.
      const latest: Record<string, TrafficRate> = {}
      if (second !== 4) latest.en0 = { rx: second * 100, tx: 10 }
      if (second >= 3) latest.en7 = { rx: 5, tx: 5 }
      return Promise.resolve(latest)
    }
    const { result } = renderHook(() => useNetworkTraffic(true))
    await act(async () => {})
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    }
    expect(result.current.history).toEqual({
      en0: [110, 210, 310, 0],
      en7: [0, 0, 10, 10]
    })
    // A minute, no more.
    for (let i = 0; i < 70; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    }
    expect(result.current.history.en0).toHaveLength(60)
    expect(result.current.history.en7).toHaveLength(60)
  })

  it('null where the counters can’t be read, or the main process fails; the history stays', async () => {
    const { result } = renderHook(() => useNetworkTraffic(true))
    await act(async () => {})
    answer = () => Promise.resolve(null)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.traffic).toBeNull()
    expect(result.current.history).toEqual({ en0: [110] })
    answer = () => Promise.reject(new Error('gone'))
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.traffic).toBeNull()
    expect(result.current.history).toEqual({ en0: [110] })
  })

  it('an answer after it stopped changes nothing', async () => {
    let resolve: (value: Record<string, TrafficRate> | null) => void = () => {}
    answer = () => new Promise((done) => (resolve = done))
    const { result, unmount } = renderHook(() => useNetworkTraffic(true))
    unmount()
    await act(async () => resolve({ en0: { rx: 1, tx: 1 } }))
    expect(result.current.traffic).toBeUndefined()
    answer = () => Promise.reject(new Error('late'))
    const late = renderHook(() => useNetworkTraffic(true))
    late.unmount()
    await act(async () => {})
    expect(late.result.current.traffic).toBeUndefined()
  })
})
