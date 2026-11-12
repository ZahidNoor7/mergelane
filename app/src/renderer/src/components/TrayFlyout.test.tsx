import { formatSpeed } from '@shared/speedText'
import type { TrayStatus } from '@shared/trayFlyout'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { TrayFlyout } from './TrayFlyout'

const MB = 1_000_000
const initial = useAppStore.getState()

const STATUS: TrayStatus = {
  total: 3 * MB,
  active: true,
  unit: 'bytes',
  theme: 'sage',
  networks: [
    {
      id: 'en0',
      kind: 'wifi',
      name: 'Home Wi-Fi',
      color: '#9140B8',
      onColor: '#FFFFFF',
      speed: 2 * MB,
      out: false
    },
    {
      id: 'en5',
      kind: 'usb',
      name: 'iPhone',
      color: '#5A8605',
      onColor: '#FFFFFF',
      speed: 1 * MB,
      out: false
    },
    {
      id: 'en7',
      kind: 'ethernet',
      name: 'Office',
      color: '#00857B',
      onColor: '#FFFFFF',
      speed: 0,
      out: true
    }
  ]
}

let latest: TrayStatus | null
let push: ((status: TrayStatus) => void) | null
const stop = vi.fn()
const api = {
  trayStatus: vi.fn(() => Promise.resolve(latest)),
  onTrayStatus: vi.fn((callback: (status: TrayStatus) => void) => {
    push = callback
    return stop
  }),
  openMainWindow: vi.fn(() => Promise.resolve()),
  pauseAllDownloads: vi.fn(() => Promise.resolve()),
  closeTrayFlyout: vi.fn(() => Promise.resolve()),
  resizeTrayFlyout: vi.fn<(height: number) => Promise<void>>(() => Promise.resolve())
}

const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = []

beforeEach(() => {
  latest = STATUS
  push = null
  observers.length = 0
  window.mergelane = { ...window.mergelane, ...api } as unknown as typeof window.mergelane
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(callback: () => void) {
        observers.push({ callback, disconnect: this.disconnect })
      }
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  useAppStore.setState(initial, true)
  delete document.documentElement.dataset.palette
})

async function show(): Promise<HTMLElement> {
  render(<TrayFlyout />)
  await act(async () => {})
  return screen.getByRole('dialog', { name: 'Mergelane' })
}

const rows = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Networks' })).getAllByRole('listitem')

describe('the notification-area flyout', () => {
  it('shows the merged speed and each network as the window’s sidebar does, with Out for one that’s gone', async () => {
    const flyout = await show()
    const header = flyout.firstElementChild as HTMLElement
    expect(header.textContent).toBe(`Mergelane${formatSpeed(3 * MB, 'bytes').replace(' ', '')}`)
    expect(rows().map((row) => row.textContent)).toEqual([
      `Home Wi-Fi${formatSpeed(2 * MB, 'bytes').replace(' ', '')}`,
      `iPhone${formatSpeed(1 * MB, 'bytes').replace(' ', '')}`,
      'OfficeOut'
    ])
    expect(within(rows()[2]).getByText('Out').className).toMatch(/text-destructive/)
    // The window's theme.
    expect(document.documentElement.dataset.palette).toBe('sage')
  })

  it('follows the window: a new status, in the window’s units', async () => {
    await show()
    act(() => {
      push!({
        ...STATUS,
        total: 1 * MB,
        unit: 'bits',
        networks: [{ ...STATUS.networks[0], speed: 1 * MB }]
      })
    })
    expect(useAppStore.getState().speedUnit).toBe('bits')
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toBe(`Home Wi-Fi${formatSpeed(1 * MB, 'bits').replace(' ', '')}`)
  })

  it('shows a dash and can’t pause when nothing moves, or before the window has said anything', async () => {
    latest = null
    await show()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Pause all' }).hasAttribute('disabled')).toBe(true)
    act(() => push!({ ...STATUS, total: 0, active: false, networks: [] }))
    expect(screen.getByRole('button', { name: 'Pause all' }).hasAttribute('disabled')).toBe(true)
  })

  it('opens the window, and pauses every download', async () => {
    const user = userEvent.setup()
    await show()
    await user.click(screen.getByRole('button', { name: 'Open Mergelane' }))
    expect(api.openMainWindow).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Pause all' }))
    expect(api.pauseAllDownloads).toHaveBeenCalledTimes(1)
  })

  it('goes away on Esc', async () => {
    const user = userEvent.setup()
    await show()
    await user.keyboard('a')
    expect(api.closeTrayFlyout).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(api.closeTrayFlyout).toHaveBeenCalledTimes(1)
  })

  it('tells main its height, again as it changes, and stops listening when it closes', async () => {
    const { unmount } = render(<TrayFlyout />)
    await act(async () => {})
    expect(api.resizeTrayFlyout).toHaveBeenCalledTimes(1)
    act(() => observers[0].callback())
    expect(api.resizeTrayFlyout).toHaveBeenCalledTimes(2)
    unmount()
    expect(observers[0].disconnect).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it('ignores a status that arrives after it closed, and a failed request', async () => {
    let answer: (status: TrayStatus) => void = () => {}
    api.trayStatus.mockImplementationOnce(
      () => new Promise<TrayStatus | null>((resolve) => (answer = resolve))
    )
    const { unmount } = render(<TrayFlyout />)
    unmount()
    await act(async () => answer(STATUS))
    expect(document.documentElement.dataset.palette).toBeUndefined()

    api.trayStatus.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(screen.getByText('—')).toBeTruthy()
  })
})
