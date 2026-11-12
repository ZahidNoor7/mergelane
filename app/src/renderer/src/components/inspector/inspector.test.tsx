import type {
  DownloadSchedule,
  DownloadState,
  FinishedDownload,
  NetworkInterfaceInfo
} from '@shared/types'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeStartAt, HELD_NOTE, missedStartNote } from '@shared/startAt'
import { DownloadsPlace } from '../../screens/DownloadsPlace'
import { useAppStore } from '../../store/useAppStore'
import { ActionsContext, StateContext } from '../downloadActionsContext'
import { TooltipProvider } from '../ui/tooltip'
import { Inspector } from './Inspector'

// Their own tests cover these end to end; here they show they were offered.
vi.mock('../TorrentFiles', () => ({
  TorrentFiles: () => <p>Torrent files</p>
}))
vi.mock('../UsenetServerDialog', () => ({
  UsenetServerButton: ({ host }: { host: string }) => <button type="button">{host}</button>
}))
vi.mock('../LimitsDialog', () => ({ LimitsDialog: () => null }))

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 11, 15).getTime()

const network = (id: string, fields: Record<string, unknown> = {}): unknown => ({
  id,
  kind: 'wifi',
  label: `${id} label`,
  enabled: true,
  status: 'on',
  speedBytesPerSec: 0,
  bytesDownloaded: 2 * MB,
  retries: 0,
  transfer: 'http',
  ...fields
})

const block = (index: number, fields: Record<string, unknown> = {}): unknown => ({
  index,
  kind: 'http',
  rangeStart: index * MB,
  rangeEnd: (index + 1) * MB - 1,
  bytesDownloaded: MB / 2,
  status: 'downloading',
  ...fields
})

function download(fields: Record<string, unknown>): DownloadState {
  return {
    id: 'x',
    url: 'https://files.example.com/x.zip',
    fileName: 'x.zip',
    destinationPath: '/Users/test/Downloads/x.zip',
    totalBytes: 10 * MB,
    bytesDownloaded: 4 * MB,
    speedBytesPerSec: 0,
    status: 'downloading',
    startedAt: NOW - 10_000,
    kind: 'http',
    networks: [],
    streams: [],
    peakStreams: 2,
    blocks: [],
    totalBlocks: 10,
    blockSizeBytes: MB,
    skippedBytes: 0,
    missingBytes: 0,
    ...fields
  } as unknown as DownloadState
}

const running = download({
  id: 'run',
  fileName: 'Holiday film.mkv',
  speedBytesPerSec: 3 * MB,
  timeLeftSeconds: 5,
  peakSpeedBytesPerSec: 4 * MB,
  diskLimited: true,
  networks: [
    network('en0', { speedBytesPerSec: 2 * MB, bytesDownloaded: 3 * MB, retries: 1 }),
    network('en5', { kind: 'ethernet', speedBytesPerSec: 1 * MB, bytesDownloaded: 1 * MB }),
    network('en7', {
      enabled: false,
      status: 'failed',
      error: 'connect ECONNREFUSED',
      bytesDownloaded: 0
    })
  ],
  streams: [
    {
      id: 1,
      interfaceId: 'en0',
      status: 'downloading',
      speedBytesPerSec: 2 * MB,
      bytesDownloaded: 3 * MB,
      currentBlockIndex: 0,
      split: true,
      rangeStart: 0,
      rangeEnd: null
    },
    {
      id: 2,
      interfaceId: 'en0',
      status: 'retrying',
      speedBytesPerSec: 0,
      bytesDownloaded: 0,
      rangeStart: 0,
      rangeEnd: null
    },
    {
      id: 3,
      interfaceId: 'en5',
      status: 'completed',
      speedBytesPerSec: 0,
      bytesDownloaded: MB,
      currentBlockIndex: 1,
      rangeStart: 0,
      rangeEnd: null
    }
  ],
  blocks: [block(0), block(1, { status: 'completed', bytesDownloaded: MB })]
})

const torrent = download({
  id: 'tor',
  kind: 'torrent',
  fileName: 'Trio',
  folder: true,
  speedBytesPerSec: 1 * MB,
  uploadSpeedBytesPerSec: 0.5 * MB,
  networks: [
    network('en0', {
      transfer: 'torrent',
      speedBytesPerSec: 1 * MB,
      bytesUploaded: 1 * MB,
      uploadSpeedBytesPerSec: 0.5 * MB
    })
  ],
  peers: [
    {
      id: 0,
      interfaceId: 'en0',
      status: 'receiving',
      client: 'WebTorrent',
      bytesDownloaded: 2 * MB,
      speedBytesPerSec: 1 * MB,
      bytesUploaded: MB,
      uploadSpeedBytesPerSec: 0.5 * MB
    },
    {
      id: 1,
      interfaceId: 'en0',
      status: 'connected',
      client: null,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      bytesUploaded: 0,
      uploadSpeedBytesPerSec: 0
    }
  ],
  pieces: [],
  files: { chosen: 2, total: 3, selected: [0, 2] }
})

const iface = (id: string, displayName: string): NetworkInterfaceInfo => ({
  id,
  device: id,
  displayName,
  addresses: [],
  kind: 'wifi'
})

const initial = useAppStore.getState()
const perform = vi.fn<(id: string, targets: unknown[]) => Promise<boolean>>(() =>
  Promise.resolve(true)
)
let resolvePerform: ((done: boolean) => void) | null = null

function show(ui: React.ReactElement, busy = false): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <ActionsContext.Provider value={{ perform, askClearFinished: vi.fn() }}>
        <StateContext.Provider value={{ busy }}>{ui}</StateContext.Provider>
      </ActionsContext.Provider>
    </TooltipProvider>
  )
}

let observed: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
const measure = (width: number): void =>
  act(() => observed.forEach((callback) => callback([{ contentRect: { width } }])))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  observed = []
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
        observed.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  window.mergelane = {
    ...window.mergelane,
    updateSettings: vi.fn(() => Promise.resolve()),
    setDownloadNetwork: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.mergelane
  useAppStore.setState({ interfaces: [iface('en0', 'Wi-Fi')], homeDir: '/Users/test' })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resolvePerform = null
})

describe('Inspector, running', () => {
  it('heads with the file, where it comes from and goes, and what can be done', async () => {
    show(<Inspector download={running} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Holiday film.mkv' })).toBeTruthy()
    expect(screen.getByText('files.example.com')).toBeTruthy()
    expect(screen.getByText('Saving to ~/Downloads')).toBeTruthy()
    const actions = screen.getByRole('group', { name: 'Actions' })
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Pause', 'Show in Finder', 'Cancel download'])
    // Pausing says so until the download's state moves on.
    perform.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolvePerform = resolve))
    )
    await userEvent.setup().click(within(actions).getByRole('button', { name: 'Pause' }))
    expect(perform).toHaveBeenCalledWith('pause', [running])
    expect(within(actions).getByRole('button', { name: 'Pausing' })).toBeTruthy()
    // It didn't go through: the button comes back.
    await act(async () => resolvePerform!(false))
    expect(within(actions).getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('shows the speed, the numbers, the networks and the window title', () => {
    show(<Inspector download={running} />)
    expect(document.title).toBe('Mergelane — 40%')
    const progress = screen.getByRole('progressbar', { name: 'Holiday film.mkv progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('5s left')).toBeTruthy()
    expect(screen.getByText(/^Average/).textContent).toContain('peak')
    expect(screen.getByRole('img', { name: 'Slow drive' })).toBeTruthy()
    // Two networks carry it: how much faster it is than either alone.
    expect(screen.getByText(/faster than .* alone/)).toBeTruthy()
    expect(screen.getByText('Done').nextElementSibling!.textContent).toBe('40%')
    expect(screen.getByText('Size').nextElementSibling!.textContent).toBe('10.0 MB')
    expect(screen.getByText('1 retry')).toBeTruthy()
    const networks = screen.getByRole('list', { name: 'Networks' })
    const rows = within(networks).getAllByRole('checkbox')
    expect(rows.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Use en0 label',
      'Use en5 label',
      'Use en7 label'
    ])
    // Its share of what the networks brought, and why one isn't in it.
    expect(networks.textContent).toContain('75%')
    expect(networks.textContent).toContain('Failed')
  })

  it('switches a network for this download, and opens its streams', async () => {
    show(<Inspector download={running} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Use en5 label' }))
    expect(window.mergelane.setDownloadNetwork).toHaveBeenCalledWith('run', 'en5', false)
    await user.click(screen.getByRole('checkbox', { name: 'Use en7 label' }))
    expect(window.mergelane.setDownloadNetwork).toHaveBeenCalledWith('run', 'en7', true)

    const streams = screen.getByRole('button', { name: '2 streams' })
    await user.click(streams)
    expect(streams.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('list', { name: 'en0 label streams' })
    expect(list.textContent).toContain('Stream #1')
    expect(list.textContent).toContain('Chunk #1')
    expect(within(list).getByText('Split')).toBeTruthy()
    expect(within(list).getByText('Retrying…')).toBeTruthy()
    expect(
      screen.getByRole('progressbar', { name: 'Stream #1 progress' }).getAttribute('aria-valuenow')
    ).toBe('50')
    await user.click(screen.getByRole('button', { name: '1 stream' }))
    expect(screen.getByRole('list', { name: 'en5 label streams' }).textContent).toContain('Done')
  })

  it('names a stream’s segments and a Usenet download’s articles', async () => {
    const stream = download({
      kind: 'stream',
      protocol: 'hls',
      fileName: 'Talk.mp4',
      quality: '720p',
      muxing: true,
      networks: [network('en0')],
      streams: [
        {
          id: 1,
          interfaceId: 'en0',
          status: 'paused',
          speedBytesPerSec: 0,
          bytesDownloaded: 0,
          currentBlockIndex: 0,
          hedge: true,
          rangeStart: 0,
          rangeEnd: null
        }
      ],
      blocks: [block(0, { kind: 'stream' })]
    })
    show(<Inspector download={stream} />)
    expect(screen.getByText('Joining video and audio…')).toBeTruthy()
    expect(screen.getByText('Quality').nextElementSibling!.textContent).toBe('720p')
    await userEvent.setup().click(screen.getByRole('button', { name: '1 stream' }))
    const list = screen.getByRole('list', { name: 'en0 label streams' })
    expect(list.textContent).toContain('Segment #1')
    expect(list.textContent).toContain('Paused')
    cleanup()

    const nzb = download({
      kind: 'nzb',
      fileName: 'Show',
      server: 'news.example.com',
      nzbFiles: [{ name: 'a.rar', bytes: MB, segments: 4, missing: 2 }],
      networks: [network('en0')],
      streams: [
        {
          id: 1,
          interfaceId: 'en0',
          status: 'downloading',
          speedBytesPerSec: MB,
          bytesDownloaded: MB,
          hedge: true,
          currentBlockIndex: 0,
          rangeStart: 0,
          rangeEnd: null
        }
      ],
      blocks: [block(0, { kind: 'nzb' })]
    })
    show(<Inspector download={nzb} />)
    expect(screen.getByRole('button', { name: 'news.example.com' })).toBeTruthy()
    expect(screen.getByText('2 missing')).toBeTruthy()
    expect(screen.getByText('Files').nextElementSibling!.textContent).toBe('1')
    await userEvent.setup().click(screen.getByRole('button', { name: '1 connection' }))
    const connections = screen.getByRole('list', { name: 'en0 label connections' })
    expect(connections.textContent).toContain('Article #1')
    expect(within(connections).getByText('Backup')).toBeTruthy()
  })

  it('shows a torrent’s peers, upload, files and trackers', async () => {
    show(<Inspector download={torrent} />)
    expect(screen.getByText('Uploading').nextElementSibling!.textContent).toBe('512.0 KB/s')
    expect(screen.getByText('Peers').nextElementSibling!.textContent).toBe('2')
    const networks = screen.getByRole('list', { name: 'Networks' })
    expect(networks.textContent).toContain('2.0 MB received, 1.0 MB sent')
    expect(networks.textContent).toContain('Uploading at 512.0 KB/s')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '2 peers' }))
    const peers = within(screen.getByRole('list', { name: 'en0 label peers' })).getAllByRole(
      'listitem'
    )
    expect(peers[0].textContent).toContain('Peer #1')
    expect(peers[0].textContent).toContain('WebTorrent')
    expect(peers[0].textContent).toContain('Sending at')
    expect(peers[1].textContent).not.toContain('↑')
    expect(within(peers[1]).getByRole('img', { name: 'Idle' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '2 of 3 files' }))
    expect(screen.getByText('Torrent files')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Trackers' }))
    expect(perform).toHaveBeenCalledWith('trackers', [torrent])
  })

  it('says why nothing moves: waiting for a network, or at the data limit', () => {
    const stuck = (status: string, kind = 'http'): DownloadState =>
      download({
        kind,
        networks: [network('en0', { status, transfer: kind === 'torrent' ? 'torrent' : 'http' })],
        streams: [],
        peers: [],
        pieces: [],
        nzbFiles: [],
        files: { chosen: 1, total: 1 }
      })
    const reason = (item: DownloadState): string => {
      show(<Inspector download={item} />)
      const text = screen.getByRole('alert').textContent!
      cleanup()
      return text
    }
    expect(reason(stuck('unreachable'))).toBe('Can’t reach the server. Retrying…')
    expect(reason(stuck('unreachable', 'torrent'))).toBe('Can’t reach peers. Retrying…')
    expect(reason(stuck('unreachable', 'nzb'))).toBe('Can’t reach the news server. Retrying…')
    expect(reason(stuck('limit'))).toMatch(/reached its data limit/)
    expect(reason(stuck('offline'))).toBe('Waiting for a network. Reconnect one or switch one on.')
  })

  it('paused or waiting: nothing moves, with the cap and why', () => {
    useAppStore.setState({ slowMode: true, slowModeSpeed: MB })
    const paused = download({
      status: 'paused',
      pausedAt: NOW - 1000,
      error: 'Request failed with status code 503',
      networks: [network('en0')]
    })
    show(<Inspector download={paused} />)
    expect(document.title).toBe('Mergelane — Paused (40%)')
    expect(screen.getByText(/^Slow mode:/)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    cleanup()

    useAppStore.setState({ slowMode: false, speedLimit: 2 * MB })
    const schedule: DownloadSchedule = {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      days: [0, 1, 2, 3, 4, 5, 6]
    }
    useAppStore.setState({ downloadSchedule: schedule })
    const queued = download({ status: 'queued', totalBytes: 0, networks: [network('en0')] })
    show(<Inspector download={queued} />)
    expect(document.title).toBe('Mergelane — Queued')
    expect(screen.getByText(/^Limited to/)).toBeTruthy()
    expect(screen.getByText('Waiting for the schedule')).toBeTruthy()
    expect(screen.getByText('Done').nextElementSibling!.textContent).toBe('—')
    cleanup()

    useAppStore.setState({ downloadSchedule: undefined })
    show(<Inspector download={download({ totalBytes: 0, networks: [network('en0')] })} />)
    expect(document.title).toBe('Mergelane — downloading')
    expect(
      screen.getByRole('progressbar', { name: 'x.zip progress' }).getAttribute('aria-valuetext')
    ).toBe('4.0 MB received')
  })
})

describe('Inspector, planned starts (ADR-0044)', () => {
  it('one added for later says when it starts, and starts now from its header', async () => {
    const at = new Date(2026, 10, 12, 1).getTime()
    const timed = download({ status: 'queued', startAt: at, networks: [network('en0')] })
    show(<Inspector download={timed} />)
    expect(screen.getByText(describeStartAt(at, NOW))).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start now' }))
    expect(perform).toHaveBeenCalledWith('start', [timed])
  })

  it('one added to the queue says when its turn comes', () => {
    show(
      <Inspector
        download={download({ status: 'queued', held: true, networks: [network('en0')] })}
      />
    )
    expect(screen.getByText(HELD_NOTE)).toBeTruthy()
    expect(screen.getByText('Waiting for a turn')).toBeTruthy()
  })

  it('one that started late says why', () => {
    const missed = NOW - 2 * 3_600_000
    show(<Inspector download={download({ missedStartAt: missed, networks: [network('en0')] })} />)
    expect(screen.getByText(missedStartNote(missed, NOW))).toBeTruthy()
  })
})

describe('Inspector, finished and failed', () => {
  const finished = {
    ...download({ status: 'completed' }),
    kind: 'torrent',
    fileName: 'Trio',
    folder: true,
    bytesDownloaded: 10 * MB,
    bytesUploaded: 2 * MB,
    completedAt: NOW - 10_000 + 5000,
    peakSpeedBytesPerSec: 3 * MB,
    peakPeers: 4,
    files: { chosen: 2, total: 3, selected: [0, 2] },
    networks: [
      network('en0', { transfer: 'torrent', bytesDownloaded: 6 * MB, bytesUploaded: MB }),
      network('en5', { transfer: 'torrent', bytesDownloaded: 4 * MB, bytesUploaded: 0 }),
      network('en7', { transfer: 'torrent', bytesDownloaded: 0 })
    ],
    unitsWritten: 40
  } as unknown as FinishedDownload

  it('says how it went, the speed over it, and what each network brought', () => {
    show(<Inspector download={finished} />)
    expect(screen.getByRole('status').textContent).toBe('Download complete: Trio')
    expect(screen.getByText('Saved to ~/Downloads')).toBeTruthy()
    expect(screen.getByText('Time').nextElementSibling!.textContent).toBe('0:05')
    expect(screen.getByText('Average').nextElementSibling!.textContent).toBe('2.0 MB/s')
    expect(screen.getByText('Networks').nextElementSibling!.textContent).toBe('2')
    expect(screen.getByText('Peers').nextElementSibling!.textContent).toBe('4')
    const networks = screen.getByRole('list', { name: 'Networks' })
    expect(within(networks).getAllByRole('listitem')).toHaveLength(2)
    expect(networks.textContent).toContain('60%')
    expect(networks.textContent).toContain('sent')
    expect(
      screen.getByText(/^2 of 3 files, written in 40 pieces, uploaded 2\.0 MB, 0 retries$/)
    ).toBeTruthy()
    const actions = screen.getByRole('group', { name: 'Actions' })
    expect(within(actions).getByRole('button', { name: /Show in/ })).toBeTruthy()
  })

  it('says where an NZB’s files stand, and when a file was moved', () => {
    const nzb = (files: Array<{ name: string; missing: number }>): FinishedDownload =>
      ({
        ...download({ status: 'completed' }),
        kind: 'nzb',
        fileName: 'Show',
        completedAt: undefined,
        nzbFiles: files.map((file) => ({ ...file, bytes: MB, segments: 4 })),
        networks: [network('en0', { retries: 1 })],
        missing: true,
        unitsWritten: 8
      }) as unknown as FinishedDownload
    const note = (files: Array<{ name: string; missing: number }>): string | null => {
      show(<Inspector download={nzb(files)} />)
      const text = screen.queryByText(/news server|unpack/)?.textContent ?? null
      cleanup()
      return text
    }
    expect(
      note([
        { name: 'a.rar', missing: 1 },
        { name: 'a.par2', missing: 0 }
      ])
    ).toMatch(/1 article wasn’t .* \.par2 files before unpacking\./)
    expect(note([{ name: 'a.bin', missing: 2 }])).toMatch(/no \.par2 files/)
    expect(note([{ name: 'a.7z', missing: 0 }])).toMatch(/unpack the archive/)
    expect(note([{ name: 'a.bin', missing: 0 }])).toBeNull()

    show(<Inspector download={nzb([{ name: 'a.bin', missing: 0 }])} />)
    expect(screen.getByText('Moved or deleted since')).toBeTruthy()
    expect(screen.getByText('Connections')).toBeTruthy()
    expect(screen.getByText(/^1 file, written in 8 articles, 1 retry$/)).toBeTruthy()
  })

  it('a just-finished download counts its chunks, segments or pieces', () => {
    const counts = (fields: Record<string, unknown>): string => {
      show(<Inspector download={download({ status: 'completed', ...fields })} />)
      const text = screen.getByText(/written in/).textContent!
      cleanup()
      return text
    }
    expect(counts({ totalBlocks: 7 })).toMatch(/^written in 7 chunks/)
    expect(counts({ kind: 'stream', protocol: 'hls', totalBlocks: 3 })).toMatch(/3 segments/)
    expect(
      counts({
        kind: 'nzb',
        nzbFiles: [],
        blocks: [block(0, { status: 'completed' }), block(1, { status: 'pending' })]
      })
    ).toMatch(/1 articles/)
    expect(
      counts({
        kind: 'torrent',
        files: { chosen: 1, total: 1 },
        pieces: [{ status: 'completed' }, { status: 'skipped' }],
        bytesUploaded: undefined
      })
    ).toMatch(/1 pieces, uploaded 0 B/)
  })

  it('a failed download says why, how far it got, and copies its link', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    // After user-event's setup, which puts in a clipboard of its own.
    const copy = async (): Promise<void> => {
      const user = userEvent.setup()
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      await user.click(screen.getByRole('button', { name: 'Copy link' }))
    }
    const failed = download({
      status: 'error',
      error: 'Something odd',
      kind: 'nzb',
      server: 'news.example.com',
      missingBytes: 0,
      nzbFiles: [{ name: 'a.bin', bytes: 10 * MB, segments: 10, missing: 0 }]
    })
    show(<Inspector download={failed} />)
    expect(screen.getByRole('alert').textContent).toContain('Download failed')
    expect(screen.getByText('4.0 MB of 10.0 MB (40%)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'news.example.com' })).toBeTruthy()
    await copy()
    expect(writeText).toHaveBeenCalledWith(failed.url)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    cleanup()

    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')))
    show(<Inspector download={download({ status: 'error', bytesDownloaded: 0 })} />)
    expect(screen.getByText('The download stopped unexpectedly. Try again.')).toBeTruthy()
    expect(screen.getByText('No data downloaded')).toBeTruthy()
    await copy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    cleanup()

    show(
      <Inspector download={download({ status: 'cancelled', totalBytes: 0, bytesDownloaded: MB })} />
    )
    expect(screen.getByRole('alert').textContent).toContain('Download cancelled')
    expect(screen.getByText('1.0 MB downloaded')).toBeTruthy()
  })
})

describe('DownloadsPlace', () => {
  const finished = {
    ...download({ status: 'completed' }),
    id: 'done',
    fileName: 'Report.pdf',
    bytesDownloaded: 10 * MB,
    completedAt: NOW,
    unitsWritten: 10
  } as unknown as FinishedDownload

  it('wide: the list, and the selected download’s details beside it', async () => {
    useAppStore.setState({ downloads: { run: running }, history: [finished] })
    show(<DownloadsPlace />)
    measure(1044)
    expect(screen.queryByRole('complementary')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Report.pdf' }))
    const details = screen.getByRole('complementary', { name: 'Download details' })
    expect(within(details).getByRole('heading', { name: 'Report.pdf' })).toBeTruthy()
    // The row shows it's the one open; no way back is needed.
    expect(screen.getByRole('button', { name: 'Report.pdf' }).getAttribute('aria-current')).toBe(
      'true'
    )
    expect(within(details).queryByRole('button', { name: 'Downloads' })).toBeNull()
  })

  it('wide: the details close with their × or Esc, and focus goes back to the row', async () => {
    useAppStore.setState({ downloads: { run: running }, history: [finished] })
    show(<DownloadsPlace />)
    measure(1044)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Report.pdf' }))
    const details = screen.getByRole('complementary', { name: 'Download details' })
    await user.click(within(details).getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(useAppStore.getState().selectedId).toBeNull()
    act(() => frames.forEach((frame) => frame(0)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report.pdf' }))
    // Esc closes them too, once nothing is ticked.
    await user.click(screen.getByRole('button', { name: 'Holiday film.mkv' }))
    expect(screen.getByRole('complementary', { name: 'Download details' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('narrow: the details in the list’s place, focused, and back to the row', async () => {
    useAppStore.setState({ downloads: { run: running } })
    show(<DownloadsPlace />)
    measure(700)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Holiday film.mkv' }))
    const heading = screen.getByRole('heading', { level: 2, name: 'Holiday film.mkv' })
    expect(document.activeElement).toBe(heading)
    expect(screen.queryByRole('heading', { level: 1, name: 'Downloads' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Downloads' }))
    act(() => frames.forEach((frame) => frame(0)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Holiday film.mkv' }))
  })

  it('a cancelled or gone download has no details', () => {
    useAppStore.setState({
      downloads: { gone: download({ id: 'gone', status: 'cancelled' }) },
      selectedId: 'gone',
      detailOpen: true
    })
    show(<DownloadsPlace />)
    measure(700)
    expect(screen.getByRole('heading', { level: 1, name: 'Downloads' })).toBeTruthy()
    act(() => useAppStore.setState({ selectedId: 'missing' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Downloads' })).toBeTruthy()
  })
})

describe('the selection in the store', () => {
  it('opens and closes details, and forgets a removed download’s', () => {
    const store = useAppStore.getState()
    store.openDownload('a')
    expect(useAppStore.getState()).toMatchObject({
      screen: 'downloads',
      selectedId: 'a',
      detailOpen: true
    })
    store.setScreen('dashboard')
    expect(useAppStore.getState()).toMatchObject({ screen: 'dashboard', detailOpen: false })
    store.openDownload('a')
    store.closeDownload()
    expect(useAppStore.getState()).toMatchObject({ selectedId: 'a', detailOpen: false })
    store.forgetDownload('b')
    expect(useAppStore.getState().selectedId).toBe('a')
    store.forgetDownload('a')
    expect(useAppStore.getState().selectedId).toBeNull()
  })
})

describe('the inspector while busy', () => {
  it('holds the ways out while a removal is under way', () => {
    show(<Inspector download={running} />, true)
    expect(
      (screen.getByRole('button', { name: 'Cancel download' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
