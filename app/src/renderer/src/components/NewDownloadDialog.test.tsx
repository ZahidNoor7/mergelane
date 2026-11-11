import type { NetworkInterfaceInfo, PendingLink, ProbeResult } from '@shared/types'
import { DEFAULT_DOWNLOAD_SCHEDULE } from '@shared/downloadSchedule'
import { nextStartAt, startAtAction } from '@shared/startAt'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { NewDownloadDialog } from './NewDownloadDialog'
import { TooltipProvider } from './ui/tooltip'

// Their own tests cover these; here they stand in, showing what they were given.
vi.mock('./TorrentFiles', () => ({
  TorrentFileList: ({
    files,
    skipped,
    onChange
  }: {
    files: { path: string }[]
    skipped: number[]
    onChange: (skipped: number[]) => void
  }) => (
    <button type="button" onClick={() => onChange(skipped.length ? [] : [0, 1])}>
      {files.length} torrent files
    </button>
  )
}))
vi.mock('./UsenetServerDialog', () => ({
  UsenetServerDialog: ({ open }: { open: boolean }) => (open ? <p>Usenet server settings</p> : null)
}))
vi.mock('./NetworkEditPopover', () => ({
  NetworkEditPopover: ({ trigger }: { trigger: React.ReactNode }) => trigger
}))

const MB = 1024 * 1024

const iface = (
  id: string,
  displayName: string,
  subnet = `10.0.${id.length}.0/24`
): NetworkInterfaceInfo =>
  ({
    id,
    device: id,
    displayName,
    kind: 'wifi',
    addresses: [{ family: 4, address: '10.0.0.2', subnet }]
  }) as unknown as NetworkInterfaceInfo

const base = {
  requestedUrl: 'https://example.com/a.zip',
  finalUrl: 'https://example.com/a.zip',
  supportsRanges: true,
  totalBytes: 10 * MB,
  suggestedFileName: 'a.zip',
  contentType: null,
  etag: 'e1',
  lastModified: null
}
const HTTP = { ...base, kind: 'http' } as ProbeResult
const TORRENT = {
  ...base,
  kind: 'torrent',
  suggestedFileName: 'Trio',
  torrent: {
    infoHash: 'abc',
    pieceLength: 1024,
    files: [
      { path: 'Trio/a.bin', length: 2 * MB },
      { path: 'Trio/b.bin', length: 3 * MB },
      { path: 'Trio/c.bin', length: 4 * MB }
    ]
  }
} as ProbeResult
const NZB = {
  ...base,
  kind: 'nzb',
  suggestedFileName: 'Show',
  nzb: { hash: 'h1', files: [{ name: 'a.rar', bytes: MB, segments: 2 }] }
} as ProbeResult
const VIDEO = (protocol: 'hls' | 'youtube'): ProbeResult =>
  ({
    ...base,
    kind: 'stream',
    suggestedFileName: 'Talk',
    totalBytes: null,
    stream: {
      protocol,
      durationSeconds: 90,
      variants: [
        { id: 'v240', bandwidth: 800_000, height: 240, bytes: 3 * MB },
        { id: 'v120', bandwidth: 300_000, height: 120, bytes: MB }
      ]
    }
  }) as unknown as ProbeResult

const initial = useAppStore.getState()
let bridge: Record<string, ReturnType<typeof vi.fn>>
let magnetListener: ((status: { link: string; noPeersYet?: boolean }) => void) | null = null

function open(link?: Partial<PendingLink> & { probe?: ProbeResult }, fields = {}): void {
  const links = link ? [{ id: 'l1', url: 'https://example.com/a.zip', ...link }] : []
  useAppStore.setState({
    newDownloadOpen: true,
    links,
    shownId: link ? 'l1' : null,
    draftUrl: link ? links[0].url : '',
    formKey: 1,
    ...fields
  })
  render(
    <TooltipProvider>
      <NewDownloadDialog />
    </TooltipProvider>
  )
}
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'New download' })
/** The footer's button: "Add to queue" is also one of When's choices. */
const submit = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  bridge = {
    readClipboardText: vi.fn(() => Promise.resolve('')),
    onMagnetCheckStatus: vi.fn((listener) => {
      magnetListener = listener
      return () => {}
    }),
    probeUrl: vi.fn(() => Promise.resolve(HTTP)),
    usenetServer: vi.fn(() => Promise.resolve({ host: 'news.example.com', connections: 8 })),
    chooseDestinationFolder: vi.fn(() => Promise.resolve('/Users/test/Films')),
    chooseDownloadFile: vi.fn(() => Promise.resolve('/Users/test/a.torrent')),
    resumeFromLink: vi.fn(() => Promise.resolve()),
    startDownload: vi.fn(() => Promise.resolve('new-id')),
    freeSpace: vi.fn(() => Promise.resolve(100 * MB)),
    networkUsage: vi.fn(() => Promise.resolve({})),
    updateSettings: vi.fn(() => Promise.resolve()),
    dismissLink: vi.fn(() => Promise.resolve())
  }
  window.mergelane = { ...window.mergelane, ...bridge } as unknown as typeof window.mergelane
  useAppStore.setState({
    interfaces: [iface('en0', 'Wi-Fi'), iface('en5', 'Ethernet')],
    interfacesStatus: 'ready',
    destinationDir: '/Users/test/Downloads',
    homeDir: '/Users/test',
    downloads: {},
    downloadsAtOnce: 3,
    networkPreferences: {}
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  magnetListener = null
})

describe('New download, a link', () => {
  it('opens as a sheet, checks a link typed in, and starts it', async () => {
    open()
    expect(dialog()).toBeTruthy()
    const link = screen.getByRole('textbox', { name: 'Link' })
    expect(document.activeElement).toBe(link)
    const user = userEvent.setup()
    await user.type(link, 'https://example.com/a.zip')
    expect(await screen.findByText('Checking the link…')).toBeTruthy()
    expect(await screen.findByText('10.0 MB, resumable', {}, { timeout: 2000 })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement).value).toBe(
      'a.zip'
    )
    expect(await screen.findByText('(100.0 MB free)')).toBeTruthy()

    // Streams per network for this download, and a new name.
    await user.click(
      within(screen.getByRole('group', { name: 'Streams' })).getByRole('button', { name: '8' })
    )
    await user.clear(screen.getByRole('textbox', { name: 'File name' }))
    await user.type(screen.getByRole('textbox', { name: 'File name' }), 'b.zip')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(bridge.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'http', suggestedFileName: 'b.zip', streamsPerNetwork: 8 }),
      undefined
    )
    await waitFor(() => expect(useAppStore.getState().newDownloadOpen).toBe(false))
    expect(useAppStore.getState()).toMatchObject({
      selectedId: 'new-id',
      startedUrl: 'https://example.com/a.zip'
    })
  })

  it('says why a link fails, and clears it', async () => {
    bridge.probeUrl.mockImplementationOnce(() => Promise.reject(new Error('Not found')))
    open()
    const user = userEvent.setup()
    const link = screen.getByRole('textbox', { name: 'Link' })
    await user.type(link, 'https://example.com/missing')
    await waitFor(() => expect(link.getAttribute('aria-invalid')).toBe('true'), { timeout: 2000 })
    await user.click(screen.getByRole('button', { name: 'Clear link' }))
    expect((link as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(link)
  })

  it('takes a link from the clipboard, unless it was just started', async () => {
    bridge.readClipboardText.mockImplementationOnce(() =>
      Promise.resolve(' https://example.com/c.zip ')
    )
    open()
    await waitFor(() => expect(useAppStore.getState().draftUrl).toBe('https://example.com/c.zip'))
    cleanup()
    useAppStore.setState({ draftUrl: '' })
    bridge.readClipboardText.mockImplementationOnce(() =>
      Promise.resolve('https://example.com/c.zip')
    )
    open(undefined, { startedUrl: 'https://example.com/c.zip' })
    await act(async () => {})
    expect(useAppStore.getState().draftUrl).toBe('')
  })

  it('a magnet with no peers yet says it is still looking', async () => {
    bridge.probeUrl.mockImplementationOnce(() => new Promise(() => {}))
    open()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Link' }), 'magnet:?xt=a')
    act(() => magnetListener!({ link: 'magnet:?xt=b', noPeersYet: true }))
    act(() => magnetListener!({ link: 'magnet:?xt=a', noPeersYet: true }))
    expect(screen.getByText('No peers found yet, still looking…')).toBeTruthy()
  })

  it('opens a .torrent or .nzb file, and changes where it saves', async () => {
    open({ probe: HTTP })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(useAppStore.getState().draftUrl).toBe('/Users/test/a.torrent'))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await waitFor(() => expect(useAppStore.getState().destinationDir).toBe('/Users/test/Films'))
    bridge.chooseDestinationFolder.mockImplementationOnce(() => Promise.resolve(null))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(useAppStore.getState().destinationDir).toBe('/Users/test/Films')
  })

  it('cancels and closes', async () => {
    open({ probe: HTTP })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(useAppStore.getState().newDownloadOpen).toBe(false))
    open({ probe: HTTP })
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Close' })[0])
    await waitFor(() => expect(useAppStore.getState().newDownloadOpen).toBe(false))
  })
})

describe('New download, kinds of download', () => {
  it('a torrent lists its files and starts with the ones chosen', async () => {
    open({ probe: TORRENT })
    expect(await screen.findByText('Trio')).toBeTruthy()
    expect(within(dialog()).getByText('Torrent')).toBeTruthy()
    expect(screen.getByText('3 files, 9.0 MB')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Streams' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '3 torrent files' }))
    expect(screen.getByText('1 of 3 files, 4.0 MB')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(bridge.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'torrent', infoHash: 'abc', selectedFiles: [2] }),
      'l1'
    )
  })

  it('an NZB asks for the news server, and sets one up when there is none', async () => {
    open({ probe: NZB })
    expect(await screen.findByText(/news\.example\.com/)).toBeTruthy()
    expect(within(dialog()).getByText('Usenet')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download' }))
    expect(bridge.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'nzb', nzbHash: 'h1' }),
      'l1'
    )
    cleanup()
    bridge.usenetServer.mockImplementationOnce(() => Promise.reject(new Error('none')))
    open({ probe: NZB })
    expect(await screen.findByText('Set up your news server to download this NZB.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Set up' }))
    expect(screen.getByText('Usenet server settings')).toBeTruthy()
  })

  it('a video offers its qualities with their sizes, best first', async () => {
    open({ probe: VIDEO('hls') })
    const quality = await screen.findByRole('group', { name: 'Quality' })
    const best = within(quality).getByRole('button', { name: /^240p/ })
    expect(best.getAttribute('aria-pressed')).toBe('true')
    expect(best.textContent).toContain('3.0 MB')
    expect(within(dialog()).getByText('HLS')).toBeTruthy()
    expect(screen.getByText('1:30, 3.0 MB, saved as MP4 or MKV')).toBeTruthy()
    const user = userEvent.setup()
    await user.click(within(quality).getByRole('button', { name: /^120p/ }))
    // Pressing the one chosen keeps it.
    await user.click(within(quality).getByRole('button', { name: /^120p/ }))
    expect(screen.getByText('1:30, 1.0 MB, saved as MP4 or MKV')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(bridge.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stream', protocol: 'hls', variantId: 'v120' }),
      'l1'
    )
    cleanup()
    open({ probe: VIDEO('youtube') })
    expect(await screen.findByText(/from YouTube/)).toBeTruthy()
    expect(within(dialog()).getByText('YouTube')).toBeTruthy()
  })

  it('a file the server sends whole goes over one network', async () => {
    open({ probe: { ...HTTP, supportsRanges: false } as ProbeResult })
    expect(
      await screen.findByText(
        /Uses one connection\. This server doesn’t support parallel downloads\./
      )
    ).toBeTruthy()
    expect(screen.getByText('This download uses one connection on one network.')).toBeTruthy()
    const networks = screen.getByRole('group', { name: 'Networks' })
    const ethernet = within(networks).getByRole('button', { name: /^Ethernet/ })
    expect(ethernet.getAttribute('aria-pressed')).toBe('false')
    await userEvent.setup().click(ethernet)
    expect(ethernet.getAttribute('aria-pressed')).toBe('true')
    expect(
      within(networks)
        .getByRole('button', { name: /^Wi-Fi/ })
        .getAttribute('aria-pressed')
    ).toBe('false')
    cleanup()
    open({ probe: { ...HTTP, totalBytes: null } as ProbeResult })
    expect(await screen.findByText(/The file size is unknown\./)).toBeTruthy()
  })
})

describe('New download, networks and warnings', () => {
  it('switches networks, keeping one, and remembers the pick', async () => {
    open({ probe: HTTP })
    const networks = screen.getByRole('group', { name: 'Networks' })
    const wifi = within(networks).getByRole('button', { name: /^Wi-Fi/ })
    const ethernet = within(networks).getByRole('button', { name: /^Ethernet/ })
    const user = userEvent.setup()
    await user.click(wifi)
    expect(wifi.getAttribute('aria-pressed')).toBe('false')
    // The last one on stays on.
    await user.click(ethernet)
    expect(ethernet.getAttribute('aria-pressed')).toBe('true')
    await user.click(wifi)
    await user.click(wifi)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(useAppStore.getState().networkPreferences['en0']).toMatchObject({ off: true })
    )
  })

  it('says when two networks share a subnet, or one is at its data limit or limited', async () => {
    useAppStore.setState({
      interfaces: [
        iface('en0', 'Wi-Fi', '10.0.0.0/24'),
        iface('en5', 'Ethernet', '10.0.0.0/24'),
        iface('en7', 'Phone')
      ],
      networkPreferences: {
        en7: { dataLimit: 5 * MB, speedLimit: undefined },
        en5: {
          speedLimit: 2 * MB,
          proxy: { enabled: true, host: 'p.example', port: 1080, type: 'socks5' }
        }
      }
    } as never)
    bridge.networkUsage.mockImplementation(() => Promise.resolve({ en7: 6 * MB }))
    open({ probe: HTTP })
    expect(
      await screen.findByText(/Wi-Fi and Ethernet share a subnet \(10\.0\.0\.0\/24\)/)
    ).toBeTruthy()
    const phone = within(screen.getByRole('group', { name: 'Networks' })).getByRole('button', {
      name: /^Phone/
    })
    await waitFor(() => expect(phone.getAttribute('aria-disabled')).toBe('true'))
    await userEvent.setup().click(phone)
    expect(phone.getAttribute('aria-pressed')).toBe('false')
    expect(
      screen.getByRole('button', { name: 'Configure proxy (SOCKS5) or edit Ethernet' })
    ).toBeTruthy()
  })

  it('says when the last pick has used up its data, or every network has', async () => {
    useAppStore.setState({
      interfaces: [iface('en0', 'Wi-Fi'), iface('en7', 'Phone')],
      networkPreferences: { en0: { off: true }, en7: { dataLimit: MB } }
    } as never)
    bridge.networkUsage.mockImplementation(() => Promise.resolve({ en7: 2 * MB }))
    open({ probe: HTTP })
    expect(
      await screen.findByText(/Phone has reached its data limit\. Choose another network/)
    ).toBeTruthy()
    cleanup()
    useAppStore.setState({
      networkPreferences: { en0: { dataLimit: MB }, en7: { dataLimit: MB } }
    } as never)
    bridge.networkUsage.mockImplementation(() => Promise.resolve({ en0: 2 * MB, en7: 2 * MB }))
    open({ probe: HTTP })
    expect(await screen.findByText(/Every network has reached its data limit/)).toBeTruthy()
  })

  it('says when there are no networks, or they couldn’t be listed', async () => {
    const loadInterfaces = vi.fn(() => Promise.resolve())
    useAppStore.setState({ interfaces: [], interfacesStatus: 'ready', loadInterfaces } as never)
    open({ probe: HTTP })
    expect(screen.getByText(/No networks connected/)).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan again' }))
    expect(loadInterfaces).toHaveBeenCalled()
    cleanup()
    useAppStore.setState({ interfacesStatus: 'error', interfacesError: 'EPERM' } as never)
    open({ probe: HTTP })
    expect(screen.getByText(/couldn’t list this computer’s networks/)).toBeTruthy()
    cleanup()
    useAppStore.setState({ interfacesStatus: 'loading' } as never)
    open({ probe: HTTP })
    expect(screen.getByText('Looking for networks…')).toBeTruthy()
  })

  it('stops a download that won’t fit on the drive', async () => {
    bridge.freeSpace.mockImplementation(() => Promise.resolve(MB))
    open({ probe: HTTP })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(
      /needs 10\.0 MB, but only 1\.0 MB is free/
    )
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

describe('New download, network roles (ADR-0045)', () => {
  const chip = (name: string): HTMLElement =>
    within(screen.getByRole('group', { name: 'Networks' })).getByRole('button', {
      name: new RegExp(`^${name}`)
    })

  it('a Don’t use network can’t be picked; a Standby one is picked, and says so', async () => {
    useAppStore.setState({
      interfaces: [iface('en0', 'Wi-Fi'), iface('en5', 'Ethernet'), iface('en7', 'Phone')],
      networkPreferences: {
        en0: { role: 'standby', speedLimit: 2 * MB },
        en7: { role: 'never' }
      }
    } as never)
    open({ probe: HTTP })
    const phone = chip('Phone')
    expect(phone.getAttribute('aria-disabled')).toBe('true')
    expect(phone.getAttribute('aria-pressed')).toBe('false')
    expect(phone.textContent).toContain('Don’t use')
    expect(chip('Wi-Fi').getAttribute('aria-pressed')).toBe('true')
    expect(chip('Wi-Fi').textContent).toContain('Standby')
    expect(chip('Ethernet').textContent).not.toContain('Standby')
    const user = userEvent.setup()
    await user.click(phone)
    expect(phone.getAttribute('aria-pressed')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(bridge.startDownload).toHaveBeenCalled())
    expect(bridge.startDownload.mock.calls[0][0]).toMatchObject({ interfaceIds: ['en0', 'en5'] })
    // Left out by its role, not by this pick: nothing is remembered for it.
    expect(useAppStore.getState().networkPreferences['en7']).toEqual({ role: 'never' })
  })

  it('a file sent whole goes over a Use network before a Standby one', async () => {
    useAppStore.setState({ networkPreferences: { en0: { role: 'standby' } } } as never)
    open({ probe: { ...HTTP, supportsRanges: false } as ProbeResult })
    await screen.findByText('This download uses one connection on one network.')
    expect(chip('Ethernet').getAttribute('aria-pressed')).toBe('true')
    expect(chip('Wi-Fi').getAttribute('aria-pressed')).toBe('false')
  })

  it('says when every network is set to Don’t use', async () => {
    useAppStore.setState({
      networkPreferences: { en0: { role: 'never' }, en5: { role: 'never' } }
    } as never)
    open({ probe: HTTP })
    expect(
      await screen.findByText('Every network is set to Don’t use. Change one on Networks.')
    ).toBeTruthy()
    expect(screen.queryByText(/Every network has reached its data limit/)).toBeNull()
    expect(submit().disabled).toBe(true)
  })
})

describe('New download, links from the browser', () => {
  it('steps through the links sent, says where one came from, and offers to resume', async () => {
    useAppStore.setState({
      links: [
        { id: 'l0', url: 'https://example.com/0.zip', probe: HTTP },
        {
          id: 'l1',
          url: 'https://example.com/a.zip',
          probe: HTTP,
          from: 'Chrome',
          signedInTo: 'example.com',
          resumes: { id: 'old', fileName: 'a.zip' }
        }
      ]
    })
    useAppStore.setState({
      newDownloadOpen: true,
      shownId: 'l1',
      draftUrl: 'https://example.com/a.zip',
      formKey: 1
    })
    render(
      <TooltipProvider>
        <NewDownloadDialog />
      </TooltipProvider>
    )
    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(screen.getByText('From Chrome, with your example.com sign-in')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Next download' }) as HTMLButtonElement).disabled
    ).toBe(true)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Resume it' }))
    expect(bridge.resumeFromLink).toHaveBeenCalledWith('l1', 'old')
    await waitFor(() => expect(useAppStore.getState().selectedId).toBe('old'))
    // The other link is shown next.
    await waitFor(() => expect(useAppStore.getState().shownId).toBe('l0'))
  })

  it('says when resuming or starting fails, and a link from a page without sign-in', async () => {
    bridge.resumeFromLink.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    open({ probe: HTTP, from: 'Safari', resumes: { id: 'old', fileName: 'a.zip' } })
    expect(screen.getByText('From Safari')).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Resume it' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    bridge.startDownload.mockImplementationOnce(() => Promise.reject(new Error('Disk full')))
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Disk full/))
  })

  it('steps back to an earlier link', async () => {
    useAppStore.setState({
      links: [
        { id: 'l0', url: 'https://example.com/0.zip', probe: HTTP },
        { id: 'l1', url: 'https://example.com/a.zip', probe: HTTP }
      ]
    })
    useAppStore.setState({
      newDownloadOpen: true,
      shownId: 'l1',
      draftUrl: 'https://example.com/a.zip',
      formKey: 1
    })
    render(
      <TooltipProvider>
        <NewDownloadDialog />
      </TooltipProvider>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous download' }))
    expect(useAppStore.getState().shownId).toBe('l0')
    // Changing a link sent from the browser lets it go.
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Link' }), 'x')
    await waitFor(() => expect(useAppStore.getState().links.map((link) => link.id)).toEqual(['l1']))
  })

  it('a full queue or a closed schedule adds it to the queue instead', async () => {
    useAppStore.setState({
      downloads: { a: { id: 'a', status: 'downloading', networks: [] } } as never,
      downloadsAtOnce: 1
    })
    open({ probe: HTTP })
    const add = submit()
    expect(add.textContent).toBe('Add to queue')
    await userEvent.setup().click(add)
    await waitFor(() => expect(bridge.startDownload).toHaveBeenCalled())
    expect(useAppStore.getState().selectedId).toBeNull()
    cleanup()
    useAppStore.setState({
      downloads: {},
      downloadSchedule: { enabled: true, startMinute: 0, endMinute: 1, days: [] }
    } as never)
    open({ probe: HTTP })
    expect(screen.getByRole('button', { name: 'Add to scheduled queue' })).toBeTruthy()
  })
})

describe('New download, when it starts (ADR-0044)', () => {
  const when = (): HTMLElement => screen.getByRole('group', { name: 'When' })
  const choice = (name: string): HTMLElement => within(when()).getByRole('button', { name })

  it('starts now unless told otherwise, as it always has', async () => {
    open({ probe: HTTP })
    expect(choice('Now').getAttribute('aria-pressed')).toBe('true')
    expect(submit().textContent).toBe('Download')
    await userEvent.setup().click(submit())
    await waitFor(() => expect(bridge.startDownload).toHaveBeenCalled())
    expect(bridge.startDownload.mock.calls[0][0]).not.toHaveProperty('when')
    expect(useAppStore.getState().selectedId).toBe('new-id')
  })

  it('adds one to the queue without opening it, saying when its turn comes', async () => {
    open({ probe: HTTP })
    const user = userEvent.setup()
    await user.click(choice('Add to queue'))
    expect(choice('Add to queue').getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByText(
        'It waits for a turn: it starts when a running download finishes, or when you start it.'
      )
    ).toBeTruthy()
    expect(submit().textContent).toBe('Add to queue')
    await user.click(submit())
    await waitFor(() =>
      expect(bridge.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'http', when: { kind: 'queue' } }),
        'l1'
      )
    )
    expect(useAppStore.getState().selectedId).toBeNull()
  })

  it('starts one at a time: the next time the clock reads it', async () => {
    open({ probe: HTTP })
    const user = userEvent.setup()
    await user.click(choice('At a time'))
    const field = screen.getByLabelText('Start time') as HTMLInputElement
    expect(field.value).toBe('01:00')
    expect(submit().textContent).toBe(startAtAction(nextStartAt('01:00')!))
    expect(submit().querySelector('svg')).toBeTruthy()

    fireEvent.change(field, { target: { value: '23:45' } })
    expect(submit().textContent).toBe(startAtAction(nextStartAt('23:45')!))
    // Cleared, the field goes back to the time it offers first.
    fireEvent.change(field, { target: { value: '' } })
    expect(field.value).toBe('01:00')
    fireEvent.change(field, { target: { value: '23:45' } })

    await user.click(submit())
    await waitFor(() => expect(bridge.startDownload).toHaveBeenCalled())
    const [request] = bridge.startDownload.mock.calls[0]
    expect(request.when).toEqual({ kind: 'at', at: nextStartAt('23:45') })
    expect(useAppStore.getState().selectedId).toBeNull()
  })

  it('says when the schedule will hold it past its time, and goes back to Now', async () => {
    // Downloads only from 02:00 to 06:00.
    useAppStore.setState({
      downloadSchedule: { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true, startMinute: 120 }
    } as never)
    open({ probe: HTTP })
    const user = userEvent.setup()
    await user.click(choice('At a time'))
    expect(screen.getByText(/outside your download schedule/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '03:00' } })
    expect(screen.queryByText(/outside your download schedule/)).toBeNull()
    await user.click(choice('Now'))
    expect(screen.queryByLabelText('Start time')).toBeNull()
  })
})
