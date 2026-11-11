import type { Release } from '@shared/releases'
import type { UpdateState } from '@shared/types'
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasUpdate, useUpdates } from '../hooks/useUpdates'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../utils/format'
import { UpdateNotice } from './UpdateNotice'
import { UpdateSettings } from './UpdateSettings'

const NOW = new Date(2026, 10, 20, 15, 0).getTime()

const RELEASE: Release = {
  version: '0.3.0',
  prerelease: false,
  publishedAt: new Date(2026, 10, 19, 12).getTime(),
  pageUrl: 'https://github.com/ZahidNoor7/mergelane/releases/tag/v0.3.0',
  notes: {
    summary: 'Updates arrive in the app.',
    items: ['Settings › Updates', 'A sidebar notice']
  },
  dmg: { name: 'Mergelane-0.3.0-arm64.dmg', size: 238_836_052, url: 'https://x/dmg' },
  checksumsUrl: 'https://x/SHA256SUMS'
}

const state = (fields: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle',
  version: '0.2.0',
  channel: 'stable',
  autoCheck: true,
  lastChecked: null,
  latest: null,
  skipped: null,
  error: null,
  ...fields
})

const api = {
  checkForUpdates: vi.fn(() => Promise.resolve(state())),
  setUpdatePreferences: vi.fn(() => Promise.resolve()),
  skipUpdate: vi.fn(() => Promise.resolve()),
  openReleasePage: vi.fn(() => Promise.resolve())
}

const initial = useAppStore.getState()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.mergelane = { ...window.mergelane, ...api } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.useRealTimers()
  vi.clearAllMocks()
})

const show = (update: UpdateState | null): void => {
  useAppStore.setState({ update })
  render(<UpdateSettings />)
}
const card = (): HTMLElement => screen.getByRole('status')

describe('Settings › Updates', () => {
  it('waits for the first answer from the main process', () => {
    show(null)
    expect(screen.getByText('Reading the update settings…')).toBeTruthy()
  })

  it('before any check: the version, the channel, and when checks happen', () => {
    show(state())
    expect(screen.getByText('0.2.0').parentElement!.textContent).toBe(
      'Version 0.2.0, stable channel'
    )
    expect(card().textContent).toBe(
      'Not checked yet' + 'Mergelane checks once a day while it runs.'
    )
    cleanup()
    show(state({ autoCheck: false, lastChecked: NOW - 12 * 60_000, channel: 'beta' }))
    expect(screen.getByText(/beta channel/)).toBeTruthy()
    expect(card().textContent).toBe(
      'Last checked 12 min ago' + 'Automatic checks are off. Check whenever you like.'
    )
    cleanup()
    show(state({ lastChecked: new Date(2026, 10, 9, 8, 0).getTime(), skipped: '0.3.0' }))
    const ninth = new Date(2026, 10, 9).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
    expect(card().textContent).toBe(
      `Last checked ${ninth}` + 'Skipped 0.3.0. You’ll hear about the next one.'
    )
    cleanup()
    show(state({ lastChecked: new Date(2026, 10, 20, 8, 5).getTime() }))
    expect(card().textContent).toMatch(/^Last checked today 08:05/)
  })

  it('checks on request, and shows that it is checking', async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    show(state())
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    act(() => useAppStore.setState({ update: state({ status: 'checking' }) }))
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(card().textContent).toBe('Checking for updates…Asking GitHub for the newest release.')
  })

  it('up to date, or a failed check, in plain words', () => {
    show(state({ status: 'current', channel: 'beta' }))
    expect(card().textContent).toBe('Mergelane is up to date0.2.0 is the newest beta version.')
    cleanup()
    show(state({ status: 'error', error: 'GitHub asked Mergelane to wait. Try again in an hour.' }))
    expect(card().textContent).toBe(
      'Couldn’t check for updatesGitHub asked Mergelane to wait. Try again in an hour.'
    )
    cleanup()
    show(state({ status: 'error' }))
    expect(card().textContent).toBe('Couldn’t check for updates')
  })

  it('a found update: its date, size and what’s new, to get from GitHub or skip', async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    show(state({ status: 'available', latest: RELEASE }))
    const status = card()
    expect(within(status).getByText('Mergelane 0.3.0 is available')).toBeTruthy()
    const released = new Date(2026, 10, 19).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
    expect(
      within(status).getByText(`You have 0.2.0. Released ${released}, ${formatBytes(238_836_052)}.`)
    ).toBeTruthy()
    expect(within(status).getByText('What’s new in 0.3.0')).toBeTruthy()
    expect(within(status).getByText('Updates arrive in the app.')).toBeTruthy()
    expect(
      within(status)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Settings › Updates', 'A sidebar notice'])
    await user.click(within(status).getByRole('button', { name: 'Get it from GitHub' }))
    expect(api.openReleasePage).toHaveBeenCalledOnce()
    await user.click(within(status).getByRole('button', { name: 'Skip this version' }))
    expect(api.skipUpdate).toHaveBeenCalledWith('0.3.0')
  })

  it('a found update without a date, size or notes says only what it has', () => {
    show(
      state({
        status: 'available',
        latest: { ...RELEASE, publishedAt: null, dmg: null, notes: { summary: null, items: [] } }
      })
    )
    expect(within(card()).getByText('You have 0.2.0.')).toBeTruthy()
    expect(screen.queryByText(/What’s new/)).toBeNull()
    cleanup()
    show(
      state({
        status: 'available',
        latest: { ...RELEASE, notes: { summary: null, items: ['One'] } }
      })
    )
    expect(screen.getByRole('listitem').textContent).toBe('One')
    cleanup()
    show(
      state({
        status: 'available',
        latest: { ...RELEASE, notes: { summary: 'Only words', items: [] } }
      })
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('turns automatic checks off and picks the channel', async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    show(state())
    expect(screen.getByText('Tested releases only.')).toBeTruthy()
    await user.click(screen.getByRole('switch', { name: 'Check for updates automatically' }))
    expect(api.setUpdatePreferences).toHaveBeenCalledWith({ autoCheck: false })
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    expect(api.setUpdatePreferences).toHaveBeenCalledWith({ channel: 'beta' })
    cleanup()
    show(state({ channel: 'beta' }))
    expect(screen.getByText(/Beta versions arrive a few weeks early/)).toBeTruthy()
    // Choosing the channel already chosen changes nothing.
    api.setUpdatePreferences.mockClear()
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    expect(api.setUpdatePreferences).not.toHaveBeenCalled()
  })
})

describe('the sidebar’s update notice', () => {
  it('shows a found update, opens Settings › Updates, and hides there', async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    useAppStore.setState({ update: state({ status: 'available', latest: RELEASE }) })
    render(<UpdateNotice />)
    expect(screen.getByRole('status').textContent).toBe(
      'Mergelane 0.3.0 is available.See what’s new'
    )
    await user.click(screen.getByRole('button', { name: 'See what’s new' }))
    expect(useAppStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'updates' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says nothing without an update', () => {
    useAppStore.setState({ update: state({ status: 'current' }) })
    render(<UpdateNotice />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => useAppStore.setState({ update: null }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(hasUpdate(null)).toBe(false)
  })
})

describe('useUpdates', () => {
  it('follows the main process, and opens Settings › Updates from the app menu', async () => {
    let push: (update: UpdateState) => void = () => {}
    let showUpdates: () => void = () => {}
    const stopState = vi.fn()
    const stopShow = vi.fn()
    window.mergelane = {
      ...window.mergelane,
      updateState: vi.fn(() => Promise.resolve(state({ lastChecked: 5 }))),
      onUpdateState: vi.fn((callback: (update: UpdateState) => void) => {
        push = callback
        return stopState
      }),
      onShowUpdates: vi.fn((callback: () => void) => {
        showUpdates = callback
        return stopShow
      })
    } as unknown as typeof window.mergelane
    const { unmount } = renderHook(() => useUpdates())
    await act(async () => {})
    expect(useAppStore.getState().update?.lastChecked).toBe(5)
    act(() => push(state({ status: 'checking' })))
    expect(useAppStore.getState().update?.status).toBe('checking')
    act(() => showUpdates())
    expect(useAppStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'updates' })
    unmount()
    expect(stopState).toHaveBeenCalledOnce()
    expect(stopShow).toHaveBeenCalledOnce()
  })
})
