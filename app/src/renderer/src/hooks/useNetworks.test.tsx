import type { NetworkActivity } from '@shared/networkActivity'
import type { NetworkInterfaceInfo } from '@shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { useNetworkEvents, useNetworkUsage } from './useNetworks'

const initial = useAppStore.getState()
const wifi: NetworkInterfaceInfo = {
  id: 'en0',
  device: 'en0',
  displayName: 'Wi-Fi',
  addresses: [],
  kind: 'wifi'
}
const saved: NetworkActivity = {
  events: [{ id: 'en7', osName: 'iPhone USB', kind: 'usb', change: 'dropped', at: 5, left: 1 }],
  fastest: { day: '2026-11-11', bytesPerSec: 99 }
}

let networksListener: ((list: NetworkInterfaceInfo[]) => void) | null
let activityListener: ((activity: NetworkActivity) => void) | null
let activityAnswer: () => Promise<NetworkActivity>
const api = {
  listInterfaces: vi.fn(() => Promise.resolve([wifi])),
  onNetworksChanged: vi.fn((callback: (list: NetworkInterfaceInfo[]) => void) => {
    networksListener = callback
    return () => (networksListener = null)
  }),
  networkActivity: vi.fn(() => activityAnswer()),
  onNetworkActivity: vi.fn((callback: (activity: NetworkActivity) => void) => {
    activityListener = callback
    return () => (activityListener = null)
  }),
  networkUsage: vi.fn(() => Promise.resolve({ en0: 1234 }))
}

beforeEach(() => {
  networksListener = null
  activityListener = null
  activityAnswer = () => Promise.resolve(saved)
  window.mergelane = { ...window.mergelane, ...api } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('useNetworkEvents', () => {
  it('loads the networks and the saved log, then takes every change main sends', async () => {
    const { unmount } = renderHook(() => useNetworkEvents())
    await act(async () => {})
    let store = useAppStore.getState()
    expect(store.interfaces).toEqual([wifi])
    expect(store.interfacesStatus).toBe('ready')
    expect(store.networkEvents).toEqual(saved.events)
    expect(store.fastestMerged).toEqual(saved.fastest)

    // Lists alone log nothing in the window now: main does.
    act(() => networksListener!([]))
    expect(useAppStore.getState().networkEvents).toEqual(saved.events)
    const next: NetworkActivity = {
      events: [...saved.events, { ...saved.events[0], change: 'recovered', at: 9 }]
    }
    act(() => activityListener!(next))
    store = useAppStore.getState()
    expect(store.interfaces).toEqual([])
    expect(store.networkEvents).toEqual(next.events)
    expect(store.fastestMerged).toBeUndefined()

    unmount()
    expect(networksListener).toBeNull()
    expect(activityListener).toBeNull()
  })

  it('an answer that comes after the window let go, or a failed one, changes nothing', async () => {
    let finish: (activity: NetworkActivity) => void = () => {}
    activityAnswer = () => new Promise((resolve) => (finish = resolve))
    const { unmount } = renderHook(() => useNetworkEvents())
    unmount()
    await act(async () => finish(saved))
    expect(useAppStore.getState().networkEvents).toEqual([])

    activityAnswer = () => Promise.reject(new Error('gone'))
    renderHook(() => useNetworkEvents())
    await act(async () => {})
    expect(useAppStore.getState().networkEvents).toEqual([])
  })

  it('a failed network list says why', async () => {
    api.listInterfaces.mockRejectedValueOnce(new Error('no answer'))
    renderHook(() => useNetworkEvents())
    await act(async () => {})
    expect(useAppStore.getState().interfacesStatus).toBe('error')
    expect(useAppStore.getState().interfacesError).toBe('no answer')
  })
})

describe('useNetworkUsage', () => {
  it('polls while active, and not at all otherwise', async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useNetworkUsage(active), {
      initialProps: { active: false }
    })
    expect(api.networkUsage).not.toHaveBeenCalled()
    rerender({ active: true })
    await act(async () => {})
    expect(result.current).toEqual({ en0: 1234 })
    await act(async () => vi.advanceTimersByTime(2000))
    expect(api.networkUsage).toHaveBeenCalledTimes(2)
  })
})
