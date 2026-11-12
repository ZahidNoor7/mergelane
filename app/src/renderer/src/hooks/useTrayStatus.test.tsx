import type { TrayStatus } from '@shared/trayFlyout'
import type { DownloadState, NetworkInterfaceInfo } from '@shared/types'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { useTrayStatus } from './useTrayStatus'

const MB = 1024 * 1024
const initial = useAppStore.getState()

const iface = (
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo => ({ id, device: id, displayName, addresses: [], kind })

function download(
  id: string,
  status: DownloadState['status'],
  networks: Array<{ id: string; speed: number; kind?: NetworkInterfaceInfo['kind'] }> = []
): DownloadState {
  return {
    id,
    status,
    networks: networks.map((network) => ({
      id: network.id,
      kind: network.kind ?? 'wifi',
      label: `${network.id} label`,
      enabled: true,
      status: 'on',
      speedBytesPerSec: network.speed,
      bytesDownloaded: 0
    }))
  } as unknown as DownloadState
}

let showPlace: ((place: 'settings' | 'networks') => void) | null
const stopShowPlace = vi.fn()
const publishTrayStatus = vi.fn<(status: TrayStatus) => Promise<void>>(() => Promise.resolve())
const onShowPlace = vi.fn((callback: (place: 'settings' | 'networks') => void) => {
  showPlace = callback
  return stopShowPlace
})

function Probe(): null {
  useTrayStatus()
  return null
}

beforeEach(() => {
  showPlace = null
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  window.mergelane = {
    ...window.mergelane,
    platform: 'win32',
    publishTrayStatus,
    onShowPlace
  } as unknown as typeof window.mergelane
  useAppStore.setState({
    interfaces: [iface('en0', 'Wi-Fi', 'wifi'), iface('en7', 'iPhone USB', 'usb')],
    downloads: {
      a: download('a', 'downloading', [
        { id: 'en0', speed: 4 * MB },
        { id: 'en7', speed: 2 * MB },
        // Gone: out, and not counted in the merged speed.
        { id: 'en5', speed: 1 * MB, kind: 'ethernet' }
      ])
    },
    speedUnit: 'bytes',
    appearanceTheme: 'porcelain'
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  window.mergelane.platform = 'darwin'
  useAppStore.setState(initial, true)
})

describe('useTrayStatus', () => {
  it('publishes what the sidebar shows, the merged speed, the units and the theme', () => {
    render(<Probe />)
    expect(publishTrayStatus).toHaveBeenCalledTimes(1)
    const status = publishTrayStatus.mock.calls[0][0]
    expect(status).toMatchObject({ total: 6 * MB, active: true, unit: 'bytes', theme: 'porcelain' })
    expect(
      status.networks.map(({ id, kind, name, speed, out }) => ({ id, kind, name, speed, out }))
    ).toEqual([
      { id: 'en0', kind: 'wifi', name: 'Wi-Fi', speed: 4 * MB, out: false },
      { id: 'en7', kind: 'usb', name: 'iPhone USB', speed: 2 * MB, out: false },
      { id: 'en5', kind: 'ethernet', name: 'en5 label', speed: 1 * MB, out: true }
    ])
    expect(status.networks[0].color).toMatch(/^#|^var\(|^rgb|^oklch/)
  })

  it('publishes again only when something the flyout shows changes', () => {
    render(<Probe />)
    act(() => useAppStore.setState({ selectedId: 'a' }))
    expect(publishTrayStatus).toHaveBeenCalledTimes(1)
    act(() => useAppStore.setState({ speedUnit: 'bits' }))
    expect(publishTrayStatus).toHaveBeenCalledTimes(2)
    expect(publishTrayStatus.mock.calls[1][0].unit).toBe('bits')
    act(() =>
      useAppStore.setState({ downloads: { a: download('a', 'paused', [{ id: 'en0', speed: 0 }]) } })
    )
    expect(publishTrayStatus.mock.calls[2][0]).toMatchObject({ total: 0, active: false })
  })

  it('counts a download waiting its turn as one Pause all would pause', () => {
    useAppStore.setState({ downloads: { b: download('b', 'queued') } })
    render(<Probe />)
    expect(publishTrayStatus.mock.calls[0][0]).toMatchObject({ total: 0, active: true })
  })

  it('opens the place the icon’s menu asks for', () => {
    const { unmount } = render(<Probe />)
    act(() => showPlace!('settings'))
    expect(useAppStore.getState().screen).toBe('settings')
    act(() => showPlace!('networks'))
    expect(useAppStore.getState().screen).toBe('networks')
    unmount()
    expect(stopShowPlace).toHaveBeenCalled()
  })

  it('does nothing on the Mac, which has no flyout', () => {
    window.mergelane.platform = 'darwin'
    render(<Probe />)
    expect(publishTrayStatus).not.toHaveBeenCalled()
    expect(onShowPlace).not.toHaveBeenCalled()
  })
})
