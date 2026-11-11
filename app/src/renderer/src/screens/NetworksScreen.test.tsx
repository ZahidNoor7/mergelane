import type { DownloadState, NetworkInterfaceInfo } from '@shared/types'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkEditPopover } from '../components/NetworkEditPopover'
import { TooltipProvider } from '../components/ui/tooltip'
import { useAppStore } from '../store/useAppStore'
import { NetworksScreen } from './NetworksScreen'

// The limits dialog and system merge have their own tests end to end; here they are stand-ins.
vi.mock('../components/LimitsDialog', () => ({
  LimitsDialog: ({ open, page }: { open: boolean; page: string | null }) =>
    open ? <div role="dialog">Limits {page ?? 'all'}</div> : null
}))
vi.mock('../components/SystemMergeSection', () => ({
  SystemMergeSection: () => <p>System merge switch</p>
}))

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 11, 15).getTime()

const iface = (
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo => ({
  id,
  device: id,
  displayName,
  addresses: [],
  kind
})

const network = (id: string, fields: Record<string, unknown> = {}): unknown => ({
  id,
  kind: 'wifi',
  label: id,
  enabled: true,
  status: 'on',
  speedBytesPerSec: 0,
  bytesDownloaded: MB,
  transfer: 'http',
  ...fields
})

const running = {
  id: 'd',
  status: 'downloading',
  kind: 'torrent',
  streams: [],
  peers: [],
  speedHistory: { en0: [MB, 2 * MB] },
  networks: [
    network('en0', { speedBytesPerSec: 2 * MB, transfer: 'torrent', uploadSpeedBytesPerSec: MB }),
    // Gone from the Mac: it dropped.
    network('en9', { kind: 'ethernet', label: 'Dock' })
  ]
} as unknown as DownloadState

const initial = useAppStore.getState()
const networkUsage = vi.fn(() => Promise.resolve({ en7: 6 * MB } as Record<string, number>))

function show(): void {
  render(
    <TooltipProvider>
      <NetworksScreen />
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
  window.mergelane = {
    ...window.mergelane,
    networkUsage,
    updateSettings: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.mergelane
  useAppStore.setState({
    interfaces: [
      iface('en0', 'Wi-Fi', 'wifi'),
      iface('en7', 'iPhone', 'usb'),
      iface('en5', 'Ethernet', 'ethernet')
    ],
    downloads: { d: running },
    networkPreferences: {
      en7: { dataLimit: 5 * MB, speedLimit: 2 * MB },
      en5: { off: true }
    },
    networkEvents: []
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('NetworksScreen', () => {
  it('lists every network with its type, what it is doing, its limits and speed', async () => {
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Networks' })).toBeTruthy()
    expect(screen.getByText('3 of 4 connected. New downloads use 2 of them.')).toBeTruthy()
    const rows = within(screen.getByRole('list', { name: 'Networks' })).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    const [wifi, phone, ethernet, dock] = rows
    expect(wifi.textContent).toContain('Wi-Fi')
    expect(wifi.textContent).toContain('Connected, carrying downloads')
    expect(wifi.textContent).toContain('2.0MB/s')
    expect(within(wifi).getByLabelText('Uploading')).toBeTruthy()
    expect(within(wifi).getByRole('img', { name: /last minute/ })).toBeTruthy()
    expect(phone.textContent).toContain('Tethered over USB')
    // Its data used up: paused, with what it used of its limit.
    await waitFor(() => expect(phone.textContent).toContain('Data limit reached'))
    expect(within(phone).getByRole('group', { name: /limits$/ }).textContent).toContain('Limit')
    expect(ethernet.textContent).toContain('Connected, left out of new downloads')
    expect(dock.textContent).toContain('Dropped. Its downloads moved to the other networks.')
    // A network that's gone has nothing to switch.
    expect(within(dock).queryByRole('switch')).toBeNull()
  })

  it('switches a network for new downloads, and opens its limits or all of them', async () => {
    show()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', { name: /^Use .* for new downloads$/, checked: false } as never)
    )
    expect(useAppStore.getState().networkPreferences['en5']?.off).toBeUndefined()
    const wifiSwitch = screen.getAllByRole('switch')[0]
    await user.click(wifiSwitch)
    expect(useAppStore.getState().networkPreferences['en0']?.off).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Wi-Fi limits' }))
    expect(screen.getByRole('dialog').textContent).toBe('Limits en0')
    cleanup()
    show()
    await user.click(screen.getByRole('button', { name: 'Speed & data limits' }))
    expect(screen.getByRole('dialog').textContent).toBe('Limits all')
  })

  it('logs networks that dropped or came back, newest first', () => {
    useAppStore.setState({
      networkEvents: [
        { id: 'en0', osName: 'Wi-Fi', kind: 'wifi', change: 'joined', at: NOW - 600_000, left: 2 },
        {
          id: 'en7',
          osName: 'iPhone',
          kind: 'usb',
          change: 'dropped',
          at: NOW - 120 * 60_000,
          left: 1
        },
        {
          id: 'en7',
          osName: 'iPhone',
          kind: 'usb',
          change: 'recovered',
          at: NOW - 5 * 60_000,
          downForMs: 30_000,
          left: 2
        },
        {
          id: 'en5',
          osName: 'Ethernet',
          kind: 'ethernet',
          change: 'dropped',
          at: NOW - 10_000,
          left: 1
        }
      ]
    })
    show()
    const items = within(screen.getByRole('log')).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Ethernet en5 droppedjust now',
      'iPhone en7 came back after 30s5 min ago',
      'iPhone en7 dropped2 h ago'
    ])
  })

  it('a dropout from before a restart: back while Mergelane was closed, days ago', () => {
    useAppStore.setState({
      networkEvents: [
        {
          id: 'en7',
          osName: 'iPhone',
          kind: 'usb',
          change: 'dropped',
          at: NOW - 3 * 24 * 3600e3,
          left: 1
        },
        {
          id: 'en7',
          osName: 'iPhone',
          kind: 'usb',
          change: 'recovered',
          at: NOW - 30 * 3600e3,
          whileClosed: true,
          left: 2
        }
      ]
    })
    show()
    const items = within(screen.getByRole('log')).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'iPhone en7 came back while Mergelane was closed30 h ago',
      'iPhone en7 dropped3 days ago'
    ])
  })

  it('with no network, says how to get one', () => {
    useAppStore.setState({ interfaces: [], downloads: {} })
    show()
    expect(screen.getByText('No network connected')).toBeTruthy()
    expect(screen.getByText(/Join a Wi-Fi network/)).toBeTruthy()
    expect(screen.getByText('No network has dropped in the last week.')).toBeTruthy()
    expect(screen.getByText('System merge switch')).toBeTruthy()
  })

  it('a network that can’t reach the server says so', () => {
    useAppStore.setState({
      networkPreferences: {},
      downloads: {
        d: {
          ...running,
          kind: 'http',
          networks: [network('en0', { status: 'unreachable' })]
        } as unknown as DownloadState
      }
    })
    show()
    expect(screen.getByText('Connected, but can’t reach the server')).toBeTruthy()
    expect(screen.getByText('3 of 3 connected. New downloads use all of them.')).toBeTruthy()
    expect(screen.getAllByText('Connected, idle')).toHaveLength(2)
  })
})

describe('the network colour picker', () => {
  it('starts on the theme’s colour, pins a colour, and gives it back', async () => {
    useAppStore.setState({ networkPreferences: {} })
    render(
      <TooltipProvider>
        <NetworkEditPopover interfaceId="en0" interfaceKind="wifi" osName="Wi-Fi" />
      </TooltipProvider>
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit Wi-Fi' }))
    const theme = await screen.findByRole('button', { name: 'Theme colour' })
    expect(theme.getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Violet' }))
    expect(theme.getAttribute('aria-pressed')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(useAppStore.getState().networkPreferences['en0']?.colorId).toBe('violet')
    )

    await user.click(screen.getByRole('button', { name: 'Edit Wi-Fi' }))
    expect(
      (await screen.findByRole('button', { name: 'Violet' })).getAttribute('aria-pressed')
    ).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Theme colour' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(useAppStore.getState().networkPreferences['en0']?.colorId).toBeUndefined()
    )
    await act(async () => {})
  })

  it('renames a network, sets its proxy, and keeps nothing on Escape', async () => {
    useAppStore.setState({ networkPreferences: {} })
    render(
      <TooltipProvider>
        <NetworkEditPopover interfaceId="en0" interfaceKind="wifi" osName="Wi-Fi" />
      </TooltipProvider>
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit Wi-Fi' }))
    await user.clear(await screen.findByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Office')
    await user.click(screen.getByRole('checkbox', { name: 'Enable proxy' }))
    await user.click(screen.getByRole('button', { name: 'SOCKS5' }))
    await user.type(screen.getByRole('textbox', { name: 'Host / IP' }), ' proxy.example ')
    await user.type(screen.getByLabelText(/^User/), ' me ')
    await user.type(screen.getByLabelText(/^Password/), 'secret')
    await user.type(screen.getByLabelText(/^Port/), '99999{Enter}')
    await waitFor(() =>
      expect(useAppStore.getState().networkPreferences['en0']).toMatchObject({
        customName: 'Office',
        proxy: {
          enabled: true,
          type: 'socks5',
          host: 'proxy.example',
          port: 1080,
          username: 'me',
          password: 'secret'
        }
      })
    )

    // Opened again, it shows what was saved; SOCKS4 has no password.
    await user.click(screen.getByRole('button', { name: /^Edit Office/ }))
    expect(
      ((await screen.findByRole('textbox', { name: 'Host / IP' })) as HTMLInputElement).value
    ).toBe('proxy.example')
    await user.click(screen.getByRole('button', { name: 'SOCKS4' }))
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).disabled).toBe(true)
    await user.type(screen.getByLabelText(/^Port/), '{Backspace}{Backspace}{Backspace}{Backspace}8')
    await user.keyboard('{Escape}')
    expect(useAppStore.getState().networkPreferences['en0']?.proxy?.type).toBe('socks5')

    // Enter in the name, host or username saves and closes.
    for (const field of [/^Name/, /^Host/, /^User/, /^Password/]) {
      await user.click(screen.getByRole('button', { name: /^Edit Office/ }))
      if (field.source === '^Password')
        await user.click(await screen.findByRole('button', { name: 'HTTP' }))
      await user.type(await screen.findByLabelText(field), '{Enter}')
      await waitFor(() => expect(screen.queryByLabelText(/^Host/)).toBeNull())
    }
  })
})
