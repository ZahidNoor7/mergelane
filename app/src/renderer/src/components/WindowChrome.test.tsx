import { scheduleMessage } from '@shared/downloadSchedule'
import type {
  DownloadSchedule,
  DownloadState,
  NetworkInterfaceInfo,
  UpdateState
} from '@shared/types'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { CompactBar, Sidebar } from './WindowChrome'
import { TooltipProvider } from './ui/tooltip'

const MB = 1024 * 1024

function iface(
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo {
  return { id, device: id, displayName, addresses: [], kind }
}

function download(
  id: string,
  status: DownloadState['status'],
  networks: Array<{ id: string; speed: number; kind?: NetworkInterfaceInfo['kind'] }> = []
): DownloadState {
  return {
    id,
    url: `https://example.com/${id}`,
    fileName: `${id}.bin`,
    destinationPath: `/tmp/${id}.bin`,
    totalBytes: 10 * MB,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    status,
    startedAt: 0,
    kind: 'http',
    networks: networks.map((network) => ({
      id: network.id,
      kind: network.kind ?? 'wifi',
      label: `${network.id} label`,
      enabled: true,
      status: 'on',
      speedBytesPerSec: network.speed,
      bytesDownloaded: 0,
      transfer: 'http'
    })),
    streams: [],
    peakStreams: 0,
    blocks: [],
    totalBlocks: 0,
    blockSizeBytes: 0
  } as unknown as DownloadState
}

/** A found update, as main/updater.ts reports it. */
const AVAILABLE = {
  status: 'available',
  version: '0.2.0',
  channel: 'stable',
  autoCheck: true,
  lastChecked: 1,
  latest: { version: '0.3.0', notes: { summary: null, items: [] } },
  skipped: null,
  error: null
} as unknown as UpdateState

const initial = useAppStore.getState()
const freeSpace = vi.fn((dir: string) => Promise.resolve(dir ? 512 * 1024 * 1024 * 1024 : 0))
const updateSettings = vi.fn(() => Promise.resolve())

beforeEach(() => {
  // jsdom has no media queries: the Mac is in light mode.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  window.mergelane = {
    ...window.mergelane,
    freeSpace,
    updateSettings
  } as unknown as typeof window.mergelane
  useAppStore.setState({
    screen: 'downloads',
    selectedId: null,
    detailOpen: false,
    interfaces: [iface('en0', 'Wi-Fi', 'wifi'), iface('en7', 'iPhone USB', 'usb')],
    downloads: {
      a: download('a', 'downloading', [
        { id: 'en0', speed: 4 * MB },
        { id: 'en7', speed: 2 * MB },
        // Gone from the Mac: out, and not counted in the merged speed.
        { id: 'en5', speed: 1 * MB, kind: 'ethernet' }
      ]),
      b: download('b', 'queued'),
      c: download('c', 'paused'),
      d: download('d', 'completed')
    },
    slowMode: false,
    speedUnit: 'bytes',
    destinationDir: '/Users/test/Downloads',
    downloadSchedule: undefined
  })
})

afterEach(() => {
  // Unmounted first: resetting the store would otherwise re-render after matchMedia is gone.
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const renderIn = (ui: React.ReactElement): ReturnType<typeof render> =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe('Sidebar', () => {
  it('shows where the window is, and moves between the places', async () => {
    renderIn(<Sidebar />)
    const places = screen.getByRole('navigation', { name: 'Mergelane' })
    const dashboard = within(places).getByRole('button', { name: 'Dashboard' })
    // Downloading, queued and paused count; a finished one doesn't.
    const downloads = within(places).getByRole('button', { name: 'Downloads, 3 in progress' })
    expect(downloads.getAttribute('aria-current')).toBe('page')
    expect(dashboard.getAttribute('aria-current')).toBeNull()

    const user = userEvent.setup()
    await user.click(dashboard)
    expect(useAppStore.getState().screen).toBe('dashboard')
    expect(dashboard.getAttribute('aria-current')).toBe('page')

    // With a download's details open, Downloads is the place, and goes back to the list.
    act(() => useAppStore.getState().openDownload('a'))
    expect(downloads.getAttribute('aria-current')).toBe('page')
    await user.click(downloads)
    expect(useAppStore.getState()).toMatchObject({ screen: 'downloads', detailOpen: false })
  })

  it('has no count when nothing is in progress', () => {
    useAppStore.setState({ downloads: { d: download('d', 'completed') } })
    renderIn(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Downloads' })).toBeTruthy()
  })

  it('lists every network with its speed, or that it is out, and the merged speed', () => {
    renderIn(<Sidebar />)
    const heading = screen.getByRole('heading', { level: 2, name: 'Networks' })
    const rows = within(heading.parentElement!).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Wi-Fi4.0MB/s',
      'iPhone USB2.0MB/s',
      'en5 labelOut'
    ])
    // The network that's out is faded.
    expect((rows[2].querySelector('[data-kind="ethernet"]') as HTMLElement).style.opacity).toBe(
      '0.38'
    )
    expect(screen.getByText('Merged').parentElement!.textContent).toBe('Merged6.0MB/s')
  })

  it('shows a dash for a network and a merge with nothing moving', () => {
    useAppStore.setState({ downloads: {} })
    renderIn(<Sidebar />)
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('shows the free space, the schedule and slow mode, which it turns on', async () => {
    // Only the clock is fixed, so the schedule's message is known; timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 11, 9, 0))
    const schedule: DownloadSchedule = {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      days: [0, 1, 2, 3, 4, 5, 6]
    }
    useAppStore.setState({ downloadSchedule: schedule })
    renderIn(<Sidebar />)
    const message = scheduleMessage(schedule, Date.now())
    expect(message).toBeTruthy()
    expect(screen.getByText(message!)).toBeTruthy()
    expect(await screen.findByText('512.0 GB free')).toBeTruthy()
    expect(freeSpace).toHaveBeenCalledWith('/Users/test/Downloads')

    const slowMode = screen.getByRole('switch', { name: 'Slow mode' })
    await userEvent.setup().click(slowMode)
    expect(useAppStore.getState().slowMode).toBe(true)
    expect(updateSettings).toHaveBeenCalledWith({ slowMode: true })
    // Its tooltip says it holds uploads too (owner, 2026-11-11).
    await userEvent.setup().hover(slowMode.closest('label')!)
    expect(
      await screen.findByText(/Limit downloads and uploads to .+ each/, {}, { timeout: 3000 })
    ).toBeTruthy()
  })

  it('opens Settings from its foot, and marks it while it shows', async () => {
    renderIn(<Sidebar />)
    const settings = screen.getByRole('button', { name: /^Settings/ })
    expect(settings.getAttribute('aria-current')).toBeNull()
    await userEvent.setup().click(settings)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(settings.getAttribute('aria-current')).toBe('page')
    // Networks is a place too.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Networks' }))
    expect(useAppStore.getState().screen).toBe('networks')
  })

  it('with an update out: the notice, and a dot that takes Settings to Updates', async () => {
    useAppStore.setState({ update: AVAILABLE })
    renderIn(<Sidebar />)
    expect(screen.getByText('is available.')).toBeTruthy()
    const settings = screen.getByRole('button', { name: /^Settings/ })
    expect(within(settings).getByRole('img', { name: 'Update available' })).toBeTruthy()
    expect(within(settings).queryByText('⌘,')).toBeNull()
    await userEvent.setup().click(settings)
    expect(useAppStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'updates' })
  })
})

describe('CompactBar', () => {
  it('shows the merged speed and switches places with a segmented control', async () => {
    renderIn(<CompactBar />)
    expect(screen.getByText('Merged').textContent).toBe('Merged6.0MB/s')
    const section = screen.getByRole('group', { name: 'Section' })
    const dashboard = within(section).getByRole('button', { name: 'Dashboard' })
    const downloads = within(section).getByRole('button', { name: 'Downloads' })
    expect(downloads.getAttribute('aria-pressed')).toBe('true')

    const user = userEvent.setup()
    await user.click(dashboard)
    expect(useAppStore.getState().screen).toBe('dashboard')
    expect(dashboard.getAttribute('aria-pressed')).toBe('true')
    // Pressing the place already chosen keeps it: a segmented control is never empty.
    await user.click(dashboard)
    expect(useAppStore.getState().screen).toBe('dashboard')
    await user.click(downloads)
    expect(useAppStore.getState().screen).toBe('downloads')
  })

  it('names slow mode for a screen reader, without showing the label, and opens Settings', async () => {
    renderIn(<CompactBar />)
    expect(screen.getByText('Slow mode').className).toContain('sr-only')
    expect(screen.getByRole('switch', { name: 'Slow mode' })).toBeTruthy()
    const settings = screen.getByRole('button', { name: 'Settings' })
    await userEvent.setup().click(settings)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(settings.getAttribute('aria-current')).toBe('page')
  })

  it('names an update in the Settings button, which then opens Updates', async () => {
    useAppStore.setState({ update: AVAILABLE })
    renderIn(<CompactBar />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Settings, update available' }))
    expect(useAppStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'updates' })
  })
})
