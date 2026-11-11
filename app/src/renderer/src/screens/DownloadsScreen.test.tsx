import type {
  DownloadSchedule,
  DownloadState,
  FinishedDownload,
  NetworkInterfaceInfo
} from '@shared/types'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionsContext, StateContext } from '../components/downloadActionsContext'
import { TooltipProvider } from '../components/ui/tooltip'
import { useAppStore } from '../store/useAppStore'
import { DownloadsScreen } from './DownloadsScreen'

// The limits dialog has its own tests end to end; here it is a stand-in that shows it was offered.
vi.mock('../components/LimitsDialog', () => ({
  LimitsDialog: ({ open, showSchedule }: { open: boolean; showSchedule: boolean }) =>
    open ? <div role="dialog">{showSchedule ? 'Schedule' : 'Limits'}</div> : null
}))

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 11, 15).getTime()

function iface(id: string, displayName: string): NetworkInterfaceInfo {
  return { id, device: id, displayName, addresses: [], kind: 'wifi' }
}

function download(
  id: string,
  fields: Record<string, unknown> & { status: DownloadState['status'] }
): DownloadState {
  return {
    id,
    url: `https://files.example.com/${id}`,
    fileName: `${id}.zip`,
    destinationPath: `/Users/test/Downloads/${id}.zip`,
    totalBytes: 10 * MB,
    bytesDownloaded: 4 * MB,
    speedBytesPerSec: 0,
    startedAt: NOW - 60_000,
    kind: 'http',
    networks: [],
    streams: [],
    peakStreams: 0,
    blocks: [],
    totalBlocks: 0,
    blockSizeBytes: 0,
    ...fields
  } as unknown as DownloadState
}

function network(id: string, fields: Record<string, unknown> = {}): DownloadState['networks'][0] {
  return {
    id,
    kind: 'wifi',
    label: `${id} label`,
    enabled: true,
    status: 'on',
    speedBytesPerSec: 0,
    bytesDownloaded: 2 * MB,
    transfer: 'http',
    ...fields
  } as unknown as DownloadState['networks'][0]
}

const running = download('film', {
  status: 'downloading',
  fileName: 'Holiday film.mkv',
  speedBytesPerSec: 2 * MB,
  timeLeftSeconds: 3,
  // Not on every network: the row shows which ones.
  networks: [
    network('en0', { speedBytesPerSec: 2 * MB }),
    network('en7', { enabled: false, bytesDownloaded: 0 }),
    network('en5', { status: 'limit' })
  ]
})
const starting = download('starting', {
  status: 'downloading',
  totalBytes: 0,
  bytesDownloaded: 1 * MB,
  networks: [network('en0')]
})
const muxing = download('talk', {
  status: 'downloading',
  kind: 'stream',
  protocol: 'youtube',
  muxing: true,
  fileName: 'Talk.mp4',
  speedBytesPerSec: 1 * MB,
  networks: [network('en0')]
})
const waiting = download('waiting', {
  status: 'queued',
  queuedAt: 2,
  totalBytes: 0,
  bytesDownloaded: 0
})
const second = download('second', { status: 'queued', queuedAt: 1 })
const paused = download('paused', {
  status: 'paused',
  fileName: 'ubuntu.iso',
  networks: [network('en0')]
})
const pausedUnsized = download('unsized', { status: 'paused', totalBytes: 0 })
const failed = download('broken', {
  status: 'error',
  error: 'Something odd',
  fileName: 'broken.pdf',
  networks: [network('en0')]
})
const completed = download('done', {
  status: 'completed',
  bytesDownloaded: 10 * MB,
  completedAt: NOW - 30_000
})
const cancelled = download('gone', { status: 'cancelled' })
const finished = {
  ...download('report', { status: 'completed' }),
  fileName: 'Report.pdf',
  kind: 'torrent',
  folder: false,
  bytesDownloaded: 10 * MB,
  completedAt: NOW - 120_000,
  startedAt: NOW - 3 * 24 * 60 * 60 * 1000,
  unitsWritten: 4
} as unknown as FinishedDownload
const moved = {
  ...download('photo', { status: 'completed' }),
  fileName: 'photo.jpg',
  bytesDownloaded: 10 * MB,
  completedAt: NOW,
  missing: true,
  unitsWritten: 4
} as unknown as FinishedDownload

const initial = useAppStore.getState()
const perform = vi.fn<(id: string, targets: unknown[]) => Promise<boolean>>(() =>
  Promise.resolve(true)
)
const askClearFinished = vi.fn()
let busy = false

function show(
  downloads: DownloadState[] = [],
  history: FinishedDownload[] = [],
  fields: Partial<ReturnType<typeof useAppStore.getState>> = {}
): ReturnType<typeof render> {
  useAppStore.setState({
    downloads: Object.fromEntries(downloads.map((item) => [item.id, item])),
    history,
    interfaces: [iface('en0', 'Wi-Fi')],
    interfacesStatus: 'ready',
    ...fields
  })
  return render(
    <TooltipProvider>
      <ActionsContext.Provider value={{ perform, askClearFinished }}>
        <StateContext.Provider value={{ busy }}>
          <DownloadsScreen />
        </StateContext.Provider>
      </ActionsContext.Provider>
    </TooltipProvider>
  )
}

const ALL = [
  running,
  starting,
  muxing,
  waiting,
  second,
  paused,
  pausedUnsized,
  failed,
  completed,
  cancelled
]
const user = (): ReturnType<typeof userEvent.setup> => userEvent.setup()
const group = (name: string): HTMLElement => screen.getByRole('region', { name })
const rowNames = (name: string): string[] =>
  within(group(name))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('button')!.textContent!)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  busy = false
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
    }
  )
  window.mergelane = {
    ...window.mergelane,
    updateSettings: vi.fn(() => Promise.resolve()),
    openNetworkSettings: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.mergelane
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DownloadsScreen, empty', () => {
  it('says how to start, and starts a new download', async () => {
    const openNewDownload = vi.fn()
    show([], [], { openNewDownload })
    expect(screen.getByRole('heading', { level: 1, name: 'Downloads' })).toBeTruthy()
    expect(screen.getByText('Nothing yet')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'No downloads yet' })).toBeTruthy()
    expect(screen.getByText(/Paste a link \(⌘V\)/)).toBeTruthy()
    // The empty list draws the networks there are, idle.
    expect(screen.getByText('Wi-Fi')).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: /New download/ })
    await user().click(buttons[buttons.length - 1])
    expect(openNewDownload).toHaveBeenCalled()
  })

  it('with no network, says how to get one', async () => {
    const loadInterfaces = vi.fn()
    show([], [], { interfaces: [], loadInterfaces })
    expect(screen.getByRole('heading', { name: 'No networks connected' })).toBeTruthy()
    await user().click(screen.getByRole('button', { name: 'Scan again' }))
    expect(loadInterfaces).toHaveBeenCalled()
    await user().click(screen.getByRole('button', { name: 'Network settings' }))
    expect(window.mergelane.openNetworkSettings).toHaveBeenCalled()
  })
})

describe('DownloadsScreen, the list', () => {
  it('groups downloads by what they are doing, and says what is running', () => {
    show(ALL, [finished, moved])
    expect(screen.getByText('3 downloading, 2 waiting, 2 paused, 1 need attention')).toBeTruthy()
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    ).toEqual(['Downloading', 'Waiting', 'Paused', 'Needs attention', 'Finished'])
    // Waiting in queue order; a cancelled download isn't listed.
    expect(rowNames('Waiting')).toEqual(['second.zip', 'waiting.zip'])
    expect(screen.queryByText('gone.zip')).toBeNull()
    // One has no size yet, so there's no telling when they'll all be done.
    expect(screen.getByText('3 downloading')).toBeTruthy()
  })

  it('says each one’s progress in words', () => {
    show(ALL, [finished, moved])
    const meta = (name: string): string =>
      screen.getByRole('button', { name }).closest('li')!.querySelector('p')!.textContent!
    expect(meta('Holiday film.mkv')).toBe('40%4.0 MB of 10.0 MB3s left')
    expect(meta('starting.zip')).toBe('1.0 MBStarting')
    expect(meta('Talk.mp4')).toBe('Joining video and audio…40%4.0 MB of 10.0 MB')
    expect(meta('waiting.zip')).toBe('Waiting for a turn0 B')
    expect(meta('ubuntu.iso')).toBe('Paused at 40%4.0 MB of 10.0 MB')
    expect(meta('unsized.zip')).toBe('Paused4.0 MB')
    expect(meta('done.zip')).toBe('10.0 MBfiles.example.comJust now')
    expect(meta('Report.pdf')).toBe('10.0 MB2 min ago')
    expect(meta('photo.jpg')).toBe('10.0 MBfiles.example.comMoved or deleted')
    // A failure says why, in the danger colour.
    const error = screen
      .getByRole('button', { name: 'broken.pdf' })
      .closest('li')!
      .querySelector('p')!
    expect(error.className).toContain('text-destructive')
    // The running one shows its speed and which networks it is on.
    const film = screen.getByRole('button', { name: 'Holiday film.mkv' }).closest('li')!
    expect(film.textContent).toContain('2.0MB/s')
    expect(within(film).getByRole('img', { name: /2\.0 MB\/s, .* Off, .*/ })).toBeTruthy()
    expect(
      within(screen.getByRole('button', { name: 'Report.pdf' }).closest('li')!).getByText('Torrent')
    ).toBeTruthy()
  })

  it('opens a download, and does a row’s next step', async () => {
    show(ALL)
    await user().click(screen.getByRole('button', { name: 'Holiday film.mkv' }))
    expect(useAppStore.getState()).toMatchObject({ selectedId: 'film', detailOpen: true })
    await user().click(screen.getByRole('button', { name: 'Pause Holiday film.mkv' }))
    expect(perform).toHaveBeenCalledWith('pause', [running])
  })

  it('a waiting download outside the schedule says when it starts', () => {
    const schedule: DownloadSchedule = {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      days: [0, 1, 2, 3, 4, 5, 6]
    }
    show([waiting], [], { downloadSchedule: schedule })
    const row = screen.getByRole('button', { name: 'waiting.zip' }).closest('li')!
    expect(row.textContent).not.toContain('Waiting for a turn')
  })

  it('splits the list by status, counting what the search and filters leave', async () => {
    show(ALL, [finished])
    const tabs = screen.getByRole('group', { name: 'Show' })
    const tab = (name: RegExp): HTMLElement => within(tabs).getByRole('button', { name })
    expect(tab(/^All/).textContent).toBe('All10')
    expect(tab(/^In progress/).textContent).toBe('In progress7')
    expect(tab(/^Finished/).textContent).toBe('Finished2')
    expect(tab(/^Needs attention/).textContent).toBe('Needs attention1')

    await user().click(tab(/^Needs attention/))
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    ).toEqual(['Needs attention'])
    // Pressing the tab already chosen keeps it.
    await user().click(tab(/^Needs attention/))
    expect(useAppStore.getState().downloadFilter).toBe('failed')
    await user().click(tab(/^Finished/))
    expect(rowNames('Finished')).toEqual(['done.zip', 'Report.pdf'])
  })

  it('says when a tab is empty, and shows everything again', async () => {
    show([running])
    for (const [tab, message] of [
      [/^Finished/, 'No finished downloads'],
      [/^Needs attention/, 'Nothing needs attention']
    ] as const) {
      await user().click(screen.getByRole('button', { name: tab }))
      expect(screen.getByRole('status').textContent).toContain(message)
    }
    cleanup()
    show([completed])
    await user().click(screen.getByRole('button', { name: /^In progress/ }))
    expect(screen.getByText('Nothing in progress')).toBeTruthy()
    await user().click(screen.getByRole('button', { name: 'Show all downloads' }))
    expect(useAppStore.getState().downloadFilter).toBe('all')
  })
})

describe('DownloadsScreen, search and filters', () => {
  it('searches by name, says when nothing matches, and clears', async () => {
    show(ALL)
    const search = screen.getByRole('textbox', { name: 'Search downloads' })
    await user().type(search, 'film')
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    ).toEqual(['Downloading'])
    await user().clear(search)
    await user().type(search, 'zzz')
    expect(screen.getByText('No downloads match “zzz”')).toBeTruthy()
    await user().click(screen.getAllByRole('button', { name: 'Clear search' })[0])
    expect((search as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(search)

    // Escape clears the search, then leaves the field.
    await user().type(search, 'zzz')
    await user().keyboard('{Escape}')
    expect((search as HTMLInputElement).value).toBe('')
    await user().keyboard('{Escape}')
    expect(document.activeElement).not.toBe(search)
  })

  it('filters by type and date, with chips to take them off', async () => {
    show(ALL, [finished])
    const filters = screen.getByRole('button', { name: 'Filters' })
    await user().click(filters)
    expect(filters.getAttribute('aria-expanded')).toBe('true')
    const panel = screen.getByRole('group', { name: 'Filters' })
    expect(filters.getAttribute('aria-controls')).toBe(panel.id)
    await user().click(within(panel).getByRole('button', { name: /^Documents/ }))
    expect(within(panel).getByText(/^Showing/).textContent).toBe('Showing 2 of 10 downloads')
    expect(screen.getByRole('button', { name: 'Filters, 1 on' })).toBeTruthy()
    // A second click on a type takes it off; Any type clears them all.
    await user().click(within(panel).getByRole('button', { name: /^Archives/ }))
    await user().click(within(panel).getByRole('button', { name: /^Archives/ }))
    await user().click(within(panel).getByRole('button', { name: 'Any type' }))
    expect(useAppStore.getState().downloadFilters.types).toEqual([])
    await user().click(within(panel).getByRole('button', { name: /^Documents/ }))
    await user().click(within(panel).getByRole('button', { name: /^Last 7 days/ }))
    await user().click(within(panel).getByRole('button', { name: 'Done' }))

    const chips = screen.getByRole('list', { name: 'Active filters' })
    expect(within(chips).getByText('Last 7 days')).toBeTruthy()
    await user().click(within(chips).getByRole('button', { name: 'Remove filter: Last 7 days' }))
    await user().click(within(chips).getByRole('button', { name: 'Remove filter: Documents' }))
    expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull()

    useAppStore.getState().setDownloadFilters({ date: 'today', types: ['image'] })
    await act(async () => {})
    await user().click(screen.getByRole('button', { name: 'Clear all' }))
    expect(useAppStore.getState().downloadFilters.date).toBe('any')
  })

  it('a custom range starts as the last week, says when it is backwards, and clears', async () => {
    show(ALL, [finished])
    await user().click(screen.getByRole('button', { name: 'Filters' }))
    const panel = screen.getByRole('group', { name: 'Filters' })
    await user().click(within(panel).getByRole('button', { name: 'Custom range' }))
    expect(useAppStore.getState().downloadFilters).toMatchObject({
      date: 'custom',
      from: '2026-11-05',
      to: '2026-11-11'
    })
    expect(within(panel).getByText('Both days included.')).toBeTruthy()
    const from = (): HTMLInputElement => panel.querySelector('input[type="date"]')!
    fireEvent.change(from(), { target: { value: '2026-11-20' } })
    expect(within(panel).getByRole('alert').textContent).toBe(
      'The start date is after the end date.'
    )
    // Chosen again, the range keeps its days.
    await user().click(within(panel).getByRole('button', { name: /^Today/ }))
    await user().click(within(panel).getByRole('button', { name: 'Custom range' }))
    expect(useAppStore.getState().downloadFilters.from).toBe('2026-11-20')
    fireEvent.change(from(), { target: { value: '' } })
    await user().click(within(panel).getByRole('button', { name: 'Done' }))
    expect(screen.getByText('… – 11 Nov')).toBeTruthy()
    await user().click(screen.getByRole('button', { name: 'Filters, 1 on' }))
    await user().click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(useAppStore.getState().downloadFilters.date).toBe('any')
  })

  it('says when the filters leave nothing, and clears them', async () => {
    show([running])
    useAppStore.getState().setDownloadFilters({ types: ['audio'] })
    await act(async () => {})
    expect(screen.getByText('No downloads match these filters')).toBeTruthy()
    await user().click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(useAppStore.getState().downloadFilters.types).toEqual([])
    useAppStore.getState().setDownloadFilters({ types: ['audio'] })
    await act(async () => {})
    await user().click(screen.getByRole('button', { name: 'Show all downloads' }))
    expect(useAppStore.getState().downloadFilters.types).toEqual([])
  })
})

describe('DownloadsScreen, the selection', () => {
  it('selects rows and groups, acts on them, and lets go', async () => {
    show(ALL, [finished])
    await user().click(screen.getByRole('checkbox', { name: 'Select Holiday film.mkv' }))
    const toolbar = screen.getByRole('toolbar', { name: 'Selected downloads' })
    expect(within(toolbar).getByText('1 selected')).toBeTruthy()
    await user().click(within(toolbar).getByRole('button', { name: 'Select all' }))
    expect(within(toolbar).getByText('10 selected')).toBeTruthy()
    await user().click(within(toolbar).getByRole('button', { name: 'Deselect all' }))
    expect(screen.queryByRole('toolbar')).toBeNull()

    await user().click(screen.getByRole('checkbox', { name: 'Select all paused downloads' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    const first = within(screen.getByRole('toolbar')).getAllByRole('button')[2]
    await user().click(first)
    expect(perform).toHaveBeenCalled()
    await user().click(screen.getByRole('checkbox', { name: 'Select all paused downloads' }))
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('answers the keys: select all, find, Escape and Delete', async () => {
    show(ALL, [finished])
    const keys = user()
    await keys.keyboard('{Meta>}a{/Meta}')
    expect(screen.getByText('10 selected')).toBeTruthy()
    await keys.keyboard('{Escape}')
    expect(screen.queryByRole('toolbar')).toBeNull()

    await keys.click(screen.getByRole('checkbox', { name: 'Select done.zip' }))
    await keys.keyboard('{Backspace}')
    expect(perform).toHaveBeenCalledWith('remove', [completed])
    await keys.keyboard('{Meta>}{Backspace}{/Meta}')
    expect(perform).toHaveBeenCalledWith('trash', [completed])
    // Find lets go of the selection, then, once the search is back in the toolbar, goes to it.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    await keys.keyboard('{Meta>}f{/Meta}')
    act(() => frames.forEach((frame) => frame(0)))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search downloads' }))
    ;(document.activeElement as HTMLElement).blur()
    await keys.keyboard('{Meta>}f{/Meta}')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search downloads' }))

    // Delete with nothing that can be removed does nothing; keys in a field are the field's.
    perform.mockClear()
    ;(document.activeElement as HTMLElement).blur()
    await keys.click(screen.getByRole('checkbox', { name: 'Select Holiday film.mkv' }))
    await keys.keyboard('{Delete}')
    expect(perform).not.toHaveBeenCalledWith('remove', expect.anything())
  })

  it('clears the finished list, and offers the schedule', async () => {
    show([waiting], [finished], {
      downloadSchedule: {
        enabled: true,
        startMinute: 0,
        endMinute: 60,
        days: [0, 1, 2, 3, 4, 5, 6]
      }
    })
    await user().click(screen.getByRole('button', { name: 'Clear finished list' }))
    expect(askClearFinished).toHaveBeenCalled()
    await user().click(screen.getByRole('button', { name: /^Download schedule/ }))
    expect(screen.getByRole('dialog').textContent).toBe('Schedule')
  })

  it('while busy, holds the selection’s buttons', async () => {
    busy = true
    show(ALL)
    await user().click(screen.getByRole('checkbox', { name: 'Select Holiday film.mkv' }))
    expect(
      (screen.getByRole('button', { name: 'Deselect all' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
