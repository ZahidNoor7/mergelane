import { DEFAULT_ROUTING } from '@shared/types'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import type { NetworkSummary } from '../utils/dashboard'
import { RoutingPanel } from './RoutingPanel'

const net = (
  id: string,
  osName: string,
  kind: NetworkSummary['kind'],
  condition = 'downloading'
): NetworkSummary => ({ id, osName, kind, condition, speed: 0 }) as NetworkSummary

const NETWORKS = [net('en0', 'Wi-Fi', 'wifi'), net('en5', 'Ethernet', 'ethernet')]
const initial = useAppStore.getState()
const updateSettings = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  window.mergelane = { ...window.mergelane, updateSettings } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const show = (networks = NETWORKS): void => {
  render(<RoutingPanel networks={networks} />)
}
const choice = (): HTMLElement => screen.getByRole('group', { name: 'Downloads use' })

describe('Which network carries what', () => {
  it('offers all networks or each one, starting on all, and saves a choice', async () => {
    const user = userEvent.setup()
    show()
    expect(
      within(choice())
        .getAllByRole('button')
        .map((button) => `${button.textContent}:${button.getAttribute('aria-pressed')}`)
    ).toEqual(['All networks:true', 'Wi-Fi:false', 'Ethernet:false'])
    expect(screen.getByText(/This is the merge\./)).toBeTruthy()
    await user.click(within(choice()).getByRole('button', { name: 'Ethernet' }))
    expect(updateSettings).toHaveBeenLastCalledWith({
      routing: { down: 'en5', up: 'all', fallback: true }
    })
    expect(
      screen.getByText(/Every download goes over Ethernet only, the running ones included\./)
    ).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    // Choosing the one already chosen keeps it.
    await user.click(within(choice()).getByRole('button', { name: 'Ethernet' }))
    expect(useAppStore.getState().routing.down).toBe('en5')
    await user.click(within(choice()).getByRole('button', { name: 'All networks' }))
    expect(useAppStore.getState().routing).toEqual(DEFAULT_ROUTING)
  })

  it('says what happens while the chosen network is gone, with and without fallback', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ routing: { down: 'en5', up: 'all', fallback: true } })
    show([NETWORKS[0], net('en5', 'Ethernet', 'ethernet', 'offline')])
    expect(screen.getByRole('status').textContent).toBe(
      'Ethernet isn’t connected, so downloads use their other networks meanwhile.'
    )
    await user.click(
      screen.getByRole('switch', { name: 'Use the other networks if the chosen one drops' })
    )
    expect(updateSettings).toHaveBeenLastCalledWith({
      routing: { down: 'en5', up: 'all', fallback: false }
    })
    expect(screen.getByRole('status').textContent).toBe(
      'Ethernet isn’t connected. Downloads wait until it’s back.'
    )
  })

  it('a chosen network no download lists any more is named by its id', () => {
    useAppStore.setState({ routing: { down: 'en9', up: 'all', fallback: false } })
    show()
    expect(screen.getByRole('status').textContent).toBe(
      'en9 isn’t connected. Downloads wait until it’s back.'
    )
  })
})

describe('Uploads use', () => {
  const uploads = (): HTMLElement => screen.getByRole('group', { name: 'Uploads use' })

  it('offers all networks or each one, on its own beside downloads, and saves a choice', async () => {
    const user = userEvent.setup()
    show()
    expect(
      within(uploads())
        .getAllByRole('button')
        .map((button) => `${button.textContent}:${button.getAttribute('aria-pressed')}`)
    ).toEqual(['All networks:true', 'Wi-Fi:false', 'Ethernet:false'])
    expect(
      screen.getByText('Torrent uploads go out over the same networks as their downloads.')
    ).toBeTruthy()
    await user.click(within(uploads()).getByRole('button', { name: 'Wi-Fi' }))
    expect(updateSettings).toHaveBeenLastCalledWith({
      routing: { down: 'all', up: 'en0', fallback: true }
    })
    expect(
      screen.getByText('All uploads go out over Wi-Fi, whichever network downloads use.')
    ).toBeTruthy()
    // Downloads stay where they were.
    expect(
      within(choice()).getByRole('button', { name: 'All networks' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.queryByRole('status')).toBeNull()
    await user.click(within(uploads()).getByRole('button', { name: 'All networks' }))
    expect(useAppStore.getState().routing).toEqual(DEFAULT_ROUTING)
  })

  it('says what happens while the chosen network is gone, with and without fallback', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ routing: { down: 'all', up: 'en5', fallback: true } })
    show([NETWORKS[0], net('en5', 'Ethernet', 'ethernet', 'offline')])
    expect(screen.getByRole('status').textContent).toBe(
      'Ethernet isn’t connected, so uploads go out over their downloads’ networks meanwhile.'
    )
    await user.click(
      screen.getByRole('switch', { name: 'Use the other networks if the chosen one drops' })
    )
    expect(updateSettings).toHaveBeenLastCalledWith({
      routing: { down: 'all', up: 'en5', fallback: false }
    })
    expect(screen.getByRole('status').textContent).toBe(
      'Ethernet isn’t connected. Uploads wait until it’s back.'
    )
    expect(
      screen.getByText('Off: transfers wait for the chosen network to come back.')
    ).toBeTruthy()
  })

  it('each direction has its own note when both chosen networks are gone', () => {
    useAppStore.setState({ routing: { down: 'en9', up: 'en8', fallback: false } })
    show()
    expect(screen.getAllByRole('status').map((note) => note.textContent)).toEqual([
      'en9 isn’t connected. Downloads wait until it’s back.',
      'en8 isn’t connected. Uploads wait until it’s back.'
    ])
  })
})
