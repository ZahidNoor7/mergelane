import type { HistoryEntry } from '@shared/history'
import type { DownloadState } from '@shared/types'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { HistoryScreen } from './HistoryScreen'

const NOW = new Date(2026, 10, 26, 15, 0).getTime()
const DAY = 86_400_000
const MB = 1024 * 1024

const entry = (fields: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'x',
  kind: 'http',
  name: 'arch.iso',
  link: 'https://geo.mirror.pkgbuild.com/iso/arch.iso',
  host: 'geo.mirror.pkgbuild.com',
  size: 1300 * MB,
  startedAt: NOW - 3600_000,
  completedAt: NOW - 3000_000,
  ended: 'completed',
  inList: false,
  path: '/Users/test/Downloads/arch.iso',
  file: 'on_disk',
  ...fields
})

const ENTRIES = [
  entry({ id: 'arch' }),
  entry({
    id: 'inkscape',
    name: 'Inkscape-1.5-arm64.dmg',
    host: 'inkscape.org',
    link: 'https://inkscape.org/Inkscape-1.5-arm64.dmg',
    file: 'missing',
    startedAt: NOW - 23 * DAY
  }),
  entry({
    id: 'stopped',
    name: 'film.mkv',
    ended: 'cancelled',
    file: 'stopped',
    startedAt: NOW - 2 * DAY
  }),
  entry({ id: 'listed', name: 'fonts.zip', inList: true, startedAt: NOW - 120 * DAY })
]

const live = {
  id: 'live',
  kind: 'http',
  url: 'https://cdn.example.com/big.iso?Expires=1&Signature=x',
  fileName: 'big.iso',
  destinationPath: '/Users/test/Downloads/big.iso',
  totalBytes: 100 * MB,
  bytesDownloaded: 37 * MB,
  status: 'downloading',
  startedAt: NOW - 60_000
} as unknown as DownloadState

const initial = useAppStore.getState()
let changed: () => void = () => {}
const historyEntries = vi.fn(() => Promise.resolve(ENTRIES))
const historyLink = vi.fn((id: string) =>
  Promise.resolve<string | null>(`https://full/${id}?sig=1`)
)
const revealHistoryEntry = vi.fn(() => Promise.resolve(true))
const onHistoryChanged = vi.fn((callback: () => void) => {
  changed = callback
  return () => {}
})
const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
  window.mergelane = {
    ...window.mergelane,
    historyEntries,
    historyLink,
    revealHistoryEntry,
    onHistoryChanged
  } as unknown as typeof window.mergelane
  useAppStore.setState({ downloads: { live } })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function show(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<HistoryScreen />)
  await act(async () => {})
  return user
}
const names = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((item) => item.querySelector('span.truncate')?.textContent ?? '')

describe('History', () => {
  it('lists every download, the ones in the list live, in groups by when, newest first', async () => {
    await show()
    expect(screen.getByRole('heading', { name: 'History' })).toBeTruthy()
    expect(screen.getByText('5 downloads, 3 no longer in the list')).toBeTruthy()
    expect(screen.getAllByRole('region').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Today',
      'Earlier this week',
      'Earlier this month',
      'Older'
    ])
    expect(names()).toEqual([
      'big.iso',
      'arch.iso',
      'film.mkv',
      'Inkscape-1.5-arm64.dmg',
      'fonts.zip'
    ])
    // What each says of itself.
    const row = (name: string): HTMLElement =>
      screen.getAllByRole('listitem').find((item) => item.textContent?.includes(name))!
    expect(row('big.iso').textContent).toContain('In the list, 37%')
    expect(row('big.iso').textContent).toContain('cdn.example.com')
    expect(row('arch.iso').textContent).toContain('Not in the list')
    expect(row('Inkscape').textContent).toContain('File moved or deleted')
    expect(row('film.mkv').textContent).toContain('Stopped, partial file removed')
    expect(row('fonts.zip').textContent).not.toContain('Not in the list')
  })

  it('filters by what is on disk, not in the list, or missing, with counts', async () => {
    const user = await show()
    const filter = screen.getByRole('group', { name: 'Show in history' })
    expect(within(filter).getByRole('button', { name: /^All/ }).textContent).toBe('All5')
    await user.click(within(filter).getByRole('button', { name: /^File missing/ }))
    expect(names()).toEqual(['Inkscape-1.5-arm64.dmg'])
    await user.click(within(filter).getByRole('button', { name: /^Not in the list/ }))
    expect(names()).toEqual(['arch.iso', 'film.mkv', 'Inkscape-1.5-arm64.dmg'])
    await user.click(within(filter).getByRole('button', { name: /^On disk/ }))
    expect(names()).toEqual(['arch.iso', 'fonts.zip'])
  })

  it('searches names, sites and links, and says when nothing matches', async () => {
    const user = await show()
    const search = screen.getByRole('searchbox', { name: 'Search history' })
    await user.type(search, 'inkscape')
    expect(names()).toEqual(['Inkscape-1.5-arm64.dmg'])
    await user.clear(search)
    await user.type(search, 'nothing-like-it')
    expect(screen.getByRole('status').textContent).toContain(
      'Nothing in your history matches “nothing-like-it”'
    )
    await user.click(screen.getByRole('button', { name: 'Show all history' }))
    expect(names()).toHaveLength(5)
    await user.type(search, 'arch{Escape}')
    expect(names()).toHaveLength(5)
    await user.type(search, 'arch')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(names()).toHaveLength(5)
  })

  it('downloads again from the whole link, in New download; shows the file; copies the link', async () => {
    const user = await show()
    await user.click(screen.getByRole('button', { name: 'Download arch.iso again' }))
    expect(historyLink).toHaveBeenCalledWith('arch')
    expect(useAppStore.getState()).toMatchObject({
      newDownloadOpen: true,
      draftUrl: 'https://full/arch?sig=1'
    })
    await user.click(screen.getByRole('button', { name: 'Show arch.iso in Finder' }))
    expect(revealHistoryEntry).toHaveBeenCalledWith('arch')
    expect(
      screen
        .getByRole('button', { name: 'Show Inkscape-1.5-arm64.dmg in Finder' })
        .hasAttribute('disabled')
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Copy the link for arch.iso' }))
    expect(writeText).toHaveBeenCalledWith('https://full/arch?sig=1')
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeTruthy()
    // Two seconds later it says Copy link again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link copied' })).toBeNull())
  })

  it('falls back to the link it shows when the keychain won’t open the whole one', async () => {
    historyLink.mockImplementation(() => Promise.resolve(null))
    const user = await show()
    await user.click(screen.getByRole('button', { name: 'Download arch.iso again' }))
    expect(useAppStore.getState().draftUrl).toBe('https://geo.mirror.pkgbuild.com/iso/arch.iso')
    await user.click(screen.getByRole('button', { name: 'Copy the link for arch.iso' }))
    expect(writeText).toHaveBeenCalledWith('https://geo.mirror.pkgbuild.com/iso/arch.iso')
    historyLink.mockImplementation((id: string) => Promise.resolve(`https://full/${id}?sig=1`))
  })

  it('a live one goes to the list; History reads again when told', async () => {
    const user = await show()
    await user.click(screen.getByRole('button', { name: 'Show in list' }))
    expect(useAppStore.getState()).toMatchObject({ screen: 'downloads', selectedId: 'live' })
    historyEntries.mockImplementationOnce(() => Promise.resolve([entry({ id: 'only' })]))
    await act(async () => changed())
    expect(names()).toEqual(['big.iso', 'arch.iso'])
  })

  it('says how long it keeps, and leads to its settings', async () => {
    useAppStore.setState({ historyKeep: '30d' })
    const user = await show()
    expect(
      screen.getByText(/Kept for 30 days, only on this Mac. Removing a download from the list/)
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'History settings' }))
    expect(useAppStore.getState()).toMatchObject({
      screen: 'settings',
      settingsSection: 'downloads'
    })
  })

  it('a link that expired says so; an empty history says there is nothing', async () => {
    useAppStore.setState({
      downloads: {
        live: {
          ...live,
          status: 'error',
          problem: { kind: 'link-expired', at: NOW }
        } as DownloadState
      }
    })
    historyEntries.mockImplementationOnce(() => Promise.resolve([]))
    const user = await show()
    expect(screen.getByText('Link expired')).toBeTruthy()
    await user.click(
      within(screen.getByRole('group', { name: 'Show in history' })).getByRole('button', {
        name: /^On disk/
      })
    )
    expect(screen.getByRole('status').textContent).toContain('Nothing here')
  })
})
