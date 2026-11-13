import type { SpeedTestLive, SpeedTestRun } from '@shared/speedTest'
import type { DownloadState, NetworkInterfaceInfo, SystemMergeSnapshot } from '@shared/types'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store/useAppStore'
import { TooltipProvider } from '../ui/tooltip'
import { SpeedTestView } from './SpeedTestView'

// Networks › Speed test (ADR-0064), against a stand-in for the main process: what the view asks for,
// and what it shows of the pushes the main process sends while a test runs.

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 14, 15).getTime()

const iface = (
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo => ({ id, device: id, displayName, addresses: [], kind })

const WIFI = iface('en0', 'Wi-Fi', 'wifi')
const PHONE = iface('en7', 'iPhone USB', 'usb')

const link = (
  networkId: string,
  overrides: Partial<SpeedTestRun['links'][number]> = {}
): SpeedTestRun['links'][number] => ({
  networkId,
  kind: networkId === 'en7' ? 'usb' : 'wifi',
  name: networkId === 'en7' ? 'iPhone USB' : 'Wi-Fi',
  status: 'done',
  latencySamples: 20,
  bytesDown: 10 * MB,
  bytesUp: MB,
  ...overrides
})

const run = (overrides: Partial<SpeedTestRun> = {}): SpeedTestRun => ({
  id: 'r1',
  scope: 'link',
  server: 'https://speed.cloudflare.com',
  startedAt: NOW - 60_000,
  finishedAt: NOW - 30_000,
  status: 'done',
  links: [
    link('en0', {
      downloadBytesPerSec: 10 * MB,
      uploadBytesPerSec: 2 * MB,
      latencyMs: 12,
      jitterMs: 1
    }),
    link('en7', { downloadBytesPerSec: 4 * MB, uploadBytesPerSec: MB, latencyMs: 40, jitterMs: 6 })
  ],
  notes: [],
  ...overrides
})

const live = (overrides: Partial<SpeedTestLive> = {}): SpeedTestLive => ({
  runId: 'live',
  scope: 'link',
  startedAt: NOW,
  networkIds: ['en0', 'en7'],
  networkId: 'en0',
  phase: 'download',
  fraction: 0.4,
  bytesPerSec: 5 * MB,
  peakBytesPerSec: 6 * MB,
  results: [],
  share: {},
  pausedDownloads: 0,
  ...overrides
})

const merge = (overrides: Partial<SystemMergeSnapshot> = {}): SystemMergeSnapshot => ({
  installed: true,
  reachable: true,
  state: 'on',
  links: [],
  appVersion: '0.4.0',
  helperOutdated: false,
  stickySites: true,
  events: [],
  outages: [],
  ...overrides
})

const initial = useAppStore.getState()
let pushLive: (value: SpeedTestLive | null) => void
let pushFinished: (value: SpeedTestRun) => void
let api: Record<string, ReturnType<typeof vi.fn>>

function show(history: SpeedTestRun[] = [], current: SpeedTestLive | null = null): void {
  api.speedTestHistory.mockResolvedValue(history)
  api.speedTestLive.mockResolvedValue(current)
  render(
    <TooltipProvider>
      <SpeedTestView />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  api = {
    speedTestHistory: vi.fn(),
    speedTestLive: vi.fn(),
    speedTestStart: vi.fn(() => Promise.resolve('id')),
    speedTestCancel: vi.fn(() => Promise.resolve()),
    speedTestClearHistory: vi.fn(() => Promise.resolve()),
    updateSettings: vi.fn(() => Promise.resolve()),
    systemMerge: vi.fn(() => Promise.resolve(merge())),
    onSpeedTestLive: vi.fn((callback) => {
      pushLive = callback
      return () => {}
    }),
    onSpeedTestFinished: vi.fn((callback) => {
      pushFinished = callback
      return () => {}
    })
  }
  window.mergelane = { ...window.mergelane, ...api } as unknown as typeof window.mergelane
  useAppStore.setState({
    interfaces: [WIFI, PHONE],
    downloads: {},
    speedTest: { open: true },
    speedUnit: 'bytes'
  })
})

afterEach(() => {
  // Unmounted while matchMedia is still stubbed: the dial and the theme read it as they stop.
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

describe('starting a test', () => {
  it('tests every connected network, one at a time, by default', async () => {
    const user = userEvent.setup()
    show()
    expect(await screen.findByText(/No tests yet/)).toBeTruthy()
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: 'Speed test' })
    )
    expect(screen.getByRole('meter', { name: 'Speed' }).getAttribute('aria-valuetext')).toBe(
      'Ready: — MB/s'
    )
    expect(screen.getByText(/Uses up to 200 MB on each network/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Start test' }))
    expect(api.speedTestStart).toHaveBeenCalledWith({ scope: 'link', networkIds: ['en0', 'en7'] })
  })

  it('tests only the networks picked, together when asked, and not without one', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'All together' }))
    expect(screen.getByText(/measures what arrives/)).toBeTruthy()
    const boxes = within(screen.getByRole('group', { name: 'Networks' })).getAllByRole('checkbox')
    await user.click(boxes[1])
    await user.click(screen.getByRole('button', { name: 'Start test' }))
    expect(api.speedTestStart).toHaveBeenLastCalledWith({ scope: 'combined', networkIds: ['en0'] })
    await user.click(boxes[1])
    await user.click(boxes[0])
    await user.click(boxes[1])
    expect((screen.getByRole('button', { name: 'Start test' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('starts on the network it was opened from', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ speedTest: { open: true, networkId: 'en7' } })
    show()
    await user.click(screen.getByRole('button', { name: 'Start test' }))
    expect(api.speedTestStart).toHaveBeenCalledWith({ scope: 'link', networkIds: ['en7'] })
  })

  it('says that running downloads pause, and when nothing is connected', async () => {
    useAppStore.setState({
      downloads: {
        a: { id: 'a', status: 'downloading', networks: [] } as unknown as DownloadState,
        d: { id: 'd', status: 'downloading', networks: [] } as unknown as DownloadState,
        // Waiting ones go on waiting: only running ones are counted.
        b: { id: 'b', status: 'queued', networks: [] } as unknown as DownloadState,
        c: { id: 'c', status: 'paused', networks: [] } as unknown as DownloadState
      }
    })
    show()
    expect(screen.getByText(/Your 2 downloads pause while the test runs/)).toBeTruthy()
    act(() =>
      useAppStore.setState({
        downloads: {
          a: { id: 'a', status: 'downloading', networks: [] } as unknown as DownloadState,
          b: { id: 'b', status: 'queued', networks: [] } as unknown as DownloadState
        }
      })
    )
    expect(screen.getByText(/Your download pauses while the test runs/)).toBeTruthy()
    act(() => useAppStore.setState({ interfaces: [] }))
    expect(screen.getByText(/No network is connected/)).toBeTruthy()
  })

  it('shows why a start was refused', async () => {
    const user = userEvent.setup()
    api.speedTestStart.mockRejectedValue(
      new Error(
        "Error invoking remote method 'speedtest:start': Error: A speed test is already running"
      )
    )
    show()
    await user.click(screen.getByRole('button', { name: 'Start test' }))
    expect((await screen.findByRole('alert')).textContent).toBe('A speed test is already running')
  })

  it('through system merge: only while it is on, saying why not', async () => {
    const user = userEvent.setup()
    api.systemMerge.mockResolvedValueOnce(merge({ installed: false, state: 'off' }))
    show()
    await user.click(screen.getByRole('button', { name: 'Other apps' }))
    const start = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Start test' }) as HTMLButtonElement
    expect(await screen.findByText(/Needs the system-wide helper/)).toBeTruthy()
    expect(start().disabled).toBe(true)
    expect(screen.getByText(/Uses up to 200 MB in all/)).toBeTruthy()

    api.systemMerge.mockResolvedValue(merge({ state: 'off', reason: 'Another VPN is on' }))
    await user.click(screen.getByRole('button', { name: 'Each network' }))
    await user.click(screen.getByRole('button', { name: 'Other apps' }))
    expect(await screen.findByText('Another VPN is on')).toBeTruthy()

    api.systemMerge.mockResolvedValue(merge({ state: 'off' }))
    await user.click(screen.getByRole('button', { name: 'Each network' }))
    await user.click(screen.getByRole('button', { name: 'Other apps' }))
    expect(await screen.findByText(/Turn on system merge/)).toBeTruthy()

    api.systemMerge.mockResolvedValue(merge())
    await user.click(screen.getByRole('button', { name: 'Each network' }))
    await user.click(screen.getByRole('button', { name: 'Other apps' }))
    expect(await screen.findByText(/the test reaches one network/)).toBeTruthy()
    await user.click(start())
    expect(api.speedTestStart).toHaveBeenCalledWith({ scope: 'system', networkIds: [] })
  })

  it('says it is checking system merge until the helper answers', async () => {
    const user = userEvent.setup()
    api.systemMerge.mockReturnValue(new Promise(() => {}))
    show()
    await user.click(screen.getByRole('button', { name: 'Other apps' }))
    expect(screen.getByText('Checking system merge…')).toBeTruthy()
  })
})

describe('while a test runs', () => {
  it('shows the speed on the dial, the step, and each network as it finishes', async () => {
    const user = userEvent.setup()
    show([], live({ pausedDownloads: 2 }))
    const meter = await screen.findByRole('meter', { name: 'Speed' })
    expect(meter.getAttribute('aria-valuetext')).toBe('Download: 5.0 MB/s')
    expect(screen.getByRole('status').textContent).toBe('Testing Wi-Fi (1 of 2): download')
    expect(screen.getByText(/Your 2 downloads were paused/)).toBeTruthy()
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(steps[0].textContent).toBe('Ping')
    expect(steps[1].getAttribute('aria-current')).toBe('step')
    expect(screen.getByLabelText('Done')).toBeTruthy()
    // Nothing can be changed meanwhile; it can be stopped.
    expect(
      (screen.getByRole('button', { name: 'Each network' }) as HTMLButtonElement).disabled
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(api.speedTestCancel).toHaveBeenCalled()

    act(() =>
      pushLive(
        live({ phase: 'latency', latencyMs: 14, networkId: 'en7', results: [run().links[0]] })
      )
    )
    expect(meter.getAttribute('aria-valuetext')).toBe('Ping: 14 ms ping')
    expect(screen.getByRole('heading', { name: 'Results so far' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Testing iPhone USB (2 of 2): ping')
    act(() => pushLive(live({ phase: 'latency', latencyMs: undefined })))
    expect(meter.getAttribute('aria-valuetext')).toBe('Ping: — ms ping')
  })

  it('all together: each network’s part, as it arrives', async () => {
    show(
      [],
      live({ scope: 'combined', networkId: undefined, share: { en0: 3 * MB, en7: MB, gone: 0 } })
    )
    const part = await screen.findByRole('progressbar', { name: 'Each network’s part' })
    expect(part.getAttribute('aria-valuetext')).toBe('Wi-Fi 75%, iPhone USB 25%, gone 0%')
    expect(screen.getByRole('status').textContent).toBe('Testing every network together: download')
    expect(
      (screen.getByRole('button', { name: 'All together' }) as HTMLElement).getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
  })

  it('through system merge', async () => {
    show([], live({ scope: 'system', networkId: undefined, networkIds: [], phase: 'upload' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Testing through system merge: upload')
    )
  })

  it('shows the finished test and reloads the history', async () => {
    show([], live())
    await screen.findByRole('meter', { name: 'Speed' })
    const finished = run({ id: 'new' })
    api.speedTestHistory.mockResolvedValue([finished])
    act(() => {
      pushLive(null)
      pushFinished(finished)
    })
    expect(await screen.findByRole('heading', { name: 'Results' })).toBeTruthy()
    expect(screen.getByRole('meter', { name: 'Speed' }).getAttribute('aria-valuetext')).toBe(
      'Last download: 10.0 MB/s'
    )
  })

  it('shows a test that was stopped, though it isn’t kept', async () => {
    show([run()], live())
    await screen.findByRole('meter', { name: 'Speed' })
    act(() => {
      pushLive(null)
      pushFinished(run({ id: 'stopped', status: 'cancelled', links: [] }))
    })
    expect(await screen.findByText('The test was stopped before it finished.')).toBeTruthy()
  })
})

describe('results', () => {
  it('compares each figure with the last test of the same kind, and names the standouts', async () => {
    const before = run({
      id: 'before',
      startedAt: NOW - 3_600_000,
      links: [
        link('en0', { downloadBytesPerSec: 8 * MB, uploadBytesPerSec: 2 * MB, latencyMs: 15 })
      ]
    })
    show([run(), before])
    const table = await screen.findByRole('table')
    const wifi = within(table).getByRole('row', { name: /Wi-Fi/ })
    expect(within(wifi).getByText('Fastest')).toBeTruthy()
    expect(within(wifi).getByText('Steadiest')).toBeTruthy()
    expect(within(wifi).getByLabelText('25% higher than the last test')).toBeTruthy()
    expect(within(wifi).getByLabelText('20% lower than the last test')).toBeTruthy()
    expect(within(wifi).getByText('12 ms')).toBeTruthy()
    const phone = within(table).getByRole('row', { name: /iPhone USB/ })
    expect(within(phone).getByText('Slowest')).toBeTruthy()
  })

  it('says why a network wasn’t measured, and what a test couldn’t do', async () => {
    const user = userEvent.setup()
    const runs = [
      run({
        id: 'failed',
        status: 'failed',
        reason: 'The test server answered 503',
        links: [
          link('en0', { status: 'failed', reason: 'The test server answered 503' }),
          link('en7', { status: 'unavailable', reason: 'Its data limit is reached' })
        ]
      }),
      run({
        id: 'none',
        status: 'unavailable',
        reason: 'No network can be tested',
        links: [],
        startedAt: NOW - 90_000
      }),
      run({ id: 'bare', status: 'failed', links: [], startedAt: NOW - 95_000 })
    ]
    show(runs)
    expect(await screen.findByText('The test failed. The test server answered 503')).toBeTruthy()
    expect(screen.getByText(/Failed: The test server answered 503/)).toBeTruthy()
    expect(screen.getByText(/Not tested: Its data limit is reached/)).toBeTruthy()
    const past = within(screen.getByRole('list', { name: 'Past tests' })).getAllByRole('button')
    await user.click(past[1])
    expect(screen.getByText(/couldn’t run. No network can be tested/)).toBeTruthy()
    await user.click(past[2])
    expect(screen.getByText('The test failed. No network finished it.')).toBeTruthy()
  })

  it('all together: the total first, each network’s part, and the notes', async () => {
    show([
      run({
        scope: 'combined',
        combined: {
          downloadBytesPerSec: 12 * MB,
          uploadBytesPerSec: 3 * MB,
          share: { en0: 30, en7: 10 }
        },
        notes: ['downloads-paused', 'busy-network']
      })
    ])
    const rows = within(await screen.findByRole('table')).getAllByRole('row')
    expect(rows[1].textContent).toMatch(/^All together/)
    expect(
      screen
        .getByRole('progressbar', { name: 'Each network’s part of the download' })
        .getAttribute('aria-valuetext')
    ).toBe('Wi-Fi 75%, iPhone USB 25%')
    expect(screen.getByText(/were paused for the test/)).toBeTruthy()
    expect(screen.getByText(/Something else was using the network/)).toBeTruthy()
  })

  it('through system merge: the total is named for it', async () => {
    show([run({ scope: 'system', combined: { downloadBytesPerSec: MB, share: {} }, links: [] })])
    expect(await screen.findByText('Through system merge')).toBeTruthy()
  })
})

describe('history', () => {
  it('lists past tests, shows one picked, filters by network with its trend, and clears', async () => {
    const user = userEvent.setup()
    const runs = [
      run({ id: 'a' }),
      run({
        id: 'b',
        scope: 'combined',
        startedAt: NOW - 86_400_000,
        combined: { downloadBytesPerSec: 20 * MB, share: {} },
        links: [link('en0', { latencyMs: 9 })]
      }),
      run({
        id: 'c',
        startedAt: NOW - 5 * 86_400_000,
        links: [link('en0', { downloadBytesPerSec: 7 * MB })]
      })
    ]
    show(runs)
    const list = await screen.findByRole('list', { name: 'Past tests' })
    const items = within(list).getAllByRole('button')
    expect(items).toHaveLength(3)
    expect(items[0].getAttribute('aria-pressed')).toBe('true')
    expect(items[0].textContent).toMatch(/^Today, .*Each network: Wi-Fi, iPhone USB/)
    expect(items[1].textContent).toMatch(/^Yesterday, .*All together.*20.0 MB\/s/)

    await user.click(items[1])
    expect(items[1].getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/^All together, Yesterday/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'iPhone USB' }))
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Wi-Fi' }))
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(
      /^Wi-Fi’s download speed in its last 2 tests, oldest first: 7.0 MB\/s, 10.0 MB\/s$/
    )
    await user.click(screen.getByRole('button', { name: 'All tests' }))
    expect(within(list).getAllByRole('button')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Clear history…' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }))
    expect(api.speedTestClearHistory).toHaveBeenCalled()
    expect(await screen.findByText(/No tests yet/)).toBeTruthy()
  })

  it('says when clearing failed', async () => {
    const user = userEvent.setup()
    api.speedTestClearHistory.mockRejectedValue(new Error('disk full'))
    show([run()])
    await user.click(await screen.findByRole('button', { name: 'Clear history…' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear history' })
    )
    expect((await screen.findByRole('alert')).textContent).toBe('disk full')
  })
})

describe('the server', () => {
  it('is Cloudflare’s unless changed, and can be changed and put back', async () => {
    const user = userEvent.setup()
    show()
    expect(screen.getByText('speed.cloudflare.com')).toBeTruthy()
    expect(screen.getByText(/Cloudflare’s public speed test/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Change server…' }))
    const field = await screen.findByRole('textbox', { name: 'Server address' })
    await user.clear(field)
    await user.type(field, 'ftp://nope')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/starts with https:\/\/ or http:\/\//)).toBeTruthy()
    expect(api.updateSettings).not.toHaveBeenCalled()
    await user.clear(field)
    await user.type(field, 'https://speed.example.net/anything')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.updateSettings).toHaveBeenCalledWith({
      speedTestServer: 'https://speed.example.net'
    })
    expect(await screen.findByText('speed.example.net')).toBeTruthy()
    expect(screen.getByText(/Your own server/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Change server…' }))
    await user.click(await screen.findByRole('button', { name: 'Use Cloudflare' }))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ speedTestServer: undefined })
    expect(await screen.findByText('speed.cloudflare.com')).toBeTruthy()
  })

  it('starts from the one saved, and says the one in use when the view opens again', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ speedTestServer: 'http://10.0.0.2:8080' })
    show()
    expect(screen.getByText('10.0.0.2:8080')).toBeTruthy()
    // An edit abandoned isn't kept for the next time the server is changed.
    await user.click(screen.getByRole('button', { name: 'Change server…' }))
    await user.type(await screen.findByRole('textbox', { name: 'Server address' }), 'junk')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Change server…' }))
    expect(
      ((await screen.findByRole('textbox', { name: 'Server address' })) as HTMLInputElement).value
    ).toBe('http://10.0.0.2:8080')
    cleanup()
    act(() => useAppStore.getState().setSpeedTestServer('https://speed.example.org'))
    show()
    expect(screen.getByText('speed.example.org')).toBeTruthy()
  })
})

describe('leaving', () => {
  it('goes back to the network list', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Networks' }))
    expect(useAppStore.getState().speedTest.open).toBe(false)
  })
})
