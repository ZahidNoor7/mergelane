import type { MenuBarPanelData, SystemTraffic } from '@shared/menuBarPanel'
import { formatSpeed } from '@shared/speedText'
import type { DownloadState, FinishedDownload, NetworkInterfaceInfo } from '@shared/types'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { MenuBarPanel } from './MenuBarPanel'

// The menu under the macOS menu bar icon (ADR-0067), after the design's "The menu bar menu". Its window and the
// helper's numbers have their own tests end to end (e2e/onThisMac.spec.ts); here the page is drawn from stand-ins.

const MB = 1024 * 1024
const GB = 1024 * MB
const NOW = new Date(2026, 10, 17, 15).getTime()
const initial = useAppStore.getState()
/** A speed as SpeedText draws it: the figure, then its unit in its own span. */
const speed = (bytesPerSecond: number, unit: 'bytes' | 'bits' = 'bytes'): string =>
  formatSpeed(bytesPerSecond, unit).replace(' ', '')

const iface = (
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo => ({ id, device: id, displayName, addresses: [], kind })

const network = (id: string, fields: Record<string, unknown> = {}): unknown => ({
  id,
  kind: 'wifi',
  label: id,
  enabled: true,
  status: 'on',
  speedBytesPerSec: 0,
  bytesDownloaded: 0,
  transfer: 'torrent',
  bytesUploaded: 0,
  uploadSpeedBytesPerSec: 0,
  ...fields
})

/** A torrent started today, on Wi-Fi and the iPhone. */
const running = {
  id: 'd',
  status: 'downloading',
  kind: 'torrent',
  startedAt: NOW - 60_000,
  networks: [
    network('en0', {
      speedBytesPerSec: 3 * MB,
      bytesDownloaded: 2 * GB,
      uploadSpeedBytesPerSec: MB
    }),
    network('en7', { kind: 'usb', speedBytesPerSec: MB, bytesDownloaded: GB })
  ]
} as unknown as DownloadState

const finished = {
  id: 'f',
  startedAt: NOW - 120_000,
  completedAt: NOW - 30_000,
  networks: [network('en5', { kind: 'ethernet', bytesDownloaded: GB })]
} as unknown as FinishedDownload

let data: MenuBarPanelData
const shownListeners: Array<() => void> = []
const hiddenListeners: Array<() => void> = []
const shown = (): void => shownListeners.forEach((listener) => listener())
const hidden = (): void => hiddenListeners.forEach((listener) => listener())
const api = {
  menuBarPanel: vi.fn(() => Promise.resolve(data)),
  onMenuBarPanelShown: vi.fn((callback: () => void) => {
    shownListeners.push(callback)
    return vi.fn()
  }),
  onMenuBarPanelHidden: vi.fn((callback: () => void) => {
    hiddenListeners.push(callback)
    return vi.fn()
  }),
  menuBarChoose: vi.fn(() => Promise.resolve()),
  closeMenuBarPanel: vi.fn(() => Promise.resolve()),
  resizeMenuBarPanel: vi.fn<(height: number) => Promise<void>>(() => Promise.resolve()),
  listDownloads: vi.fn(() => Promise.resolve([])),
  listHistory: vi.fn(() => Promise.resolve([finished])),
  onDownloadUpdated: vi.fn(() => vi.fn()),
  onHistoryChanged: vi.fn(() => vi.fn()),
  listInterfaces: vi.fn(() =>
    Promise.resolve([
      iface('en0', 'Wi-Fi', 'wifi'),
      iface('en7', 'iPhone USB', 'usb'),
      iface('en5', 'Ethernet', 'ethernet')
    ])
  ),
  onNetworksChanged: vi.fn(() => vi.fn()),
  onNetworkActivity: vi.fn(() => vi.fn()),
  networkActivity: vi.fn(() => Promise.resolve({ events: [] }))
}

const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  data = {
    system: null,
    speedUnit: 'bytes',
    appearanceTheme: 'sage',
    networkPreferences: {},
    speedBesideIcon: false
  }
  shownListeners.length = 0
  hiddenListeners.length = 0
  observers.length = 0
  window.mergelane = { ...window.mergelane, ...api } as unknown as typeof window.mergelane
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
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
  useAppStore.setState({ downloads: { d: running } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  useAppStore.setState(initial, true)
  delete document.documentElement.dataset.palette
})

async function show(): Promise<HTMLElement> {
  render(<MenuBarPanel />)
  // The networks, the history and the main process's numbers arrive.
  await act(async () => {})
  return screen.getByRole('dialog', { name: 'Mergelane' })
}

const rows = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Networks' })).getAllByRole('listitem')

describe('the menu bar’s menu', () => {
  it('shows the merged download and upload, and each network as the design does', async () => {
    const panel = await show()
    expect(within(panel).getByRole('heading').textContent).toBe('Merged across 2 of 3 networks')
    const totals = within(panel).getByRole('region', { name: 'Merged speed' })
    expect(totals.textContent).toContain(`Download${speed(4 * MB)}`)
    expect(totals.textContent).toContain(`Upload${speed(MB)}`)

    const [wifi, iphone, ethernet] = rows()
    expect(wifi.textContent).toBe(`Wi-Fi75% · 2.0 GB today${speed(3 * MB)}${speed(MB)}`)
    expect(iphone.textContent).toBe(`iPhone USB25% · 1.0 GB today${speed(MB)}—`)
    // Nothing moving on it, but a finished download came in over it today.
    expect(ethernet.textContent).toBe('Ethernet0% · 1.0 GB today——')
    expect(screen.getByText('4.0 GB downloaded today')).toBeTruthy()
    // The theme the window uses.
    expect(document.documentElement.dataset.palette).toBe('sage')
  })

  it('with System merge on, each network’s whole traffic from the helper, in the window’s units', async () => {
    const system: SystemTraffic = {
      links: [
        { name: 'en0', down: 10 * MB, up: 2 * MB },
        { name: 'en5', down: 6 * MB, up: 0 }
      ]
    }
    data = { ...data, system, speedUnit: 'bits' }
    const panel = await show()
    expect(within(panel).getByRole('heading').textContent).toBe('Merged across 2 of 3 networks')
    const totals = within(panel).getByRole('region', { name: 'Merged speed' })
    expect(totals.textContent).toContain(`Download${speed(16 * MB, 'bits')}`)
    expect(rows()[0].textContent).toContain('63% · 2.0 GB today')
    expect(rows()[1].textContent).toBe('iPhone USB0% · 1.0 GB today——')
  })

  it('says a network is off, or out, instead of its speeds', async () => {
    data = { ...data, networkPreferences: { en7: { role: 'never' } } }
    useAppStore.setState({
      downloads: {
        d: {
          ...running,
          networks: [...running.networks, network('en9', { kind: 'ethernet', label: 'Dock' })]
        } as unknown as DownloadState
      }
    })
    await show()
    const [, iphone, , dock] = rows()
    expect(iphone.textContent).toBe('iPhone USBOff——')
    expect(dock.textContent).toBe('DockOutNot connected')
    expect(screen.getByRole('heading').textContent).toBe('Merged across 1 of 4 networks')
  })

  it('reads the main process’s numbers once a second while open, and not while closed', async () => {
    await show()
    expect(api.menuBarPanel).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(api.menuBarPanel).toHaveBeenCalledTimes(3)
    act(() => hidden())
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(api.menuBarPanel).toHaveBeenCalledTimes(3)
    // Opened again: at once, then every second.
    await act(async () => shown())
    expect(api.menuBarPanel).toHaveBeenCalledTimes(4)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(api.menuBarPanel).toHaveBeenCalledTimes(5)
  })

  it('keeps showing the last numbers when the main process can’t answer', async () => {
    api.menuBarPanel.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(screen.getByRole('heading').textContent).toBe('Merged across 2 of 3 networks')
  })

  it('fits its window to its height', async () => {
    await show()
    expect(api.resizeMenuBarPanel).toHaveBeenCalledTimes(1)
    act(() => observers[0].callback())
    expect(api.resizeMenuBarPanel).toHaveBeenCalledTimes(2)
    cleanup()
    expect(observers[0].disconnect).toHaveBeenCalled()
  })
})

describe('its commands', () => {
  const item = (name: RegExp): HTMLElement => screen.getByRole('menuitem', { name })

  it('are a menu: the pointer highlights one, a click chooses it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await show()
    const menu = screen.getByRole('menu', { name: 'Commands' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((each) => each.textContent)
    ).toEqual([
      'Open Mergelane⌘O',
      'Pause all downloads',
      'New download…⌘N',
      'Settings…⌘,',
      'Quit Mergelane⌘Q'
    ])
    expect(within(menu).getByRole('menuitemcheckbox').textContent).toBe('Speed beside the icon')
    expect(item(/^Open/).getAttribute('aria-keyshortcuts')).toBe('Meta+O')
    await user.hover(item(/^New download/))
    expect(item(/^New download/).dataset.highlighted).toBe('true')
    await user.unhover(item(/^New download/))
    expect(item(/^New download/).dataset.highlighted).toBeUndefined()
    await user.hover(item(/^Quit/))
    // Closed and opened again: nothing highlighted.
    act(() => hidden())
    expect(item(/^Quit/).dataset.highlighted).toBeUndefined()
    await user.click(item(/^Settings/))
    expect(api.menuBarChoose).toHaveBeenCalledWith('settings')
  })

  it('Pause all only while something is downloading or waiting', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    useAppStore.setState({ downloads: { d: { ...running, status: 'paused' } as DownloadState } })
    await show()
    const pause = item(/^Pause all/)
    expect(pause.getAttribute('aria-disabled')).toBe('true')
    await user.hover(pause)
    expect(pause.dataset.highlighted).toBeUndefined()
    await user.click(pause)
    expect(api.menuBarChoose).not.toHaveBeenCalled()

    act(() => useAppStore.setState({ downloads: { d: running } }))
    expect(pause.getAttribute('aria-disabled')).toBeNull()
    await user.click(pause)
    expect(api.menuBarChoose).toHaveBeenCalledWith('pauseAll')
  })

  it('the arrow keys move the highlight past a disabled one, and Return chooses', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    useAppStore.setState({ downloads: {} })
    await show()
    await user.keyboard('{Enter}')
    expect(api.menuBarChoose).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}')
    expect(item(/^Open/).dataset.highlighted).toBe('true')
    // Pause all is disabled: skipped.
    await user.keyboard('{ArrowDown}')
    expect(item(/^New download/).dataset.highlighted).toBe('true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    // From the first, up wraps to the last.
    expect(item(/^Quit/).dataset.highlighted).toBe('true')
    await user.keyboard('{Enter}')
    expect(api.menuBarChoose).toHaveBeenCalledWith('quit')
  })

  it('up from nothing highlights the last, and Space chooses too', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await show()
    await user.keyboard('{ArrowUp}')
    expect(item(/^Quit/).dataset.highlighted).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(item(/^Open/).dataset.highlighted).toBe('true')
    await user.keyboard(' ')
    expect(api.menuBarChoose).toHaveBeenCalledWith('open')
  })

  it('⌘ and a command’s key choose it; Esc closes the menu', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    useAppStore.setState({ downloads: {} })
    await show()
    await user.keyboard('{Meta>}n{/Meta}')
    expect(api.menuBarChoose).toHaveBeenLastCalledWith('newDownload')
    await user.keyboard('{Meta>},{/Meta}')
    expect(api.menuBarChoose).toHaveBeenLastCalledWith('settings')
    // ⌘ with a key no command has, and nothing is chosen.
    await user.keyboard('{Meta>}z{/Meta}')
    expect(api.menuBarChoose).toHaveBeenCalledTimes(2)
    await user.keyboard('{Escape}')
    expect(api.closeMenuBarPanel).toHaveBeenCalled()
  })

  it('the speed beside the icon is a switch: it shows what the menu bar shows, and a click turns it over', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await show()
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Speed beside the icon' })
    const track = (): HTMLElement => toggle.lastElementChild as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(track().dataset.on).toBeUndefined()
    expect(track().className).toContain('bg-track')
    // Highlighted, it still reads on the accent.
    await user.hover(toggle)
    expect(track().className).toContain('bg-primary-foreground/25')
    await user.unhover(toggle)

    data = { ...data, speedBesideIcon: true }
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(track().dataset.on).toBe('true')
    expect(track().className).toContain('bg-primary')
    await user.hover(toggle)
    expect(track().className).toContain('bg-primary-foreground/45')
    await user.click(toggle)
    expect(api.menuBarChoose).toHaveBeenCalledWith('speedBesideIcon')
  })
})
