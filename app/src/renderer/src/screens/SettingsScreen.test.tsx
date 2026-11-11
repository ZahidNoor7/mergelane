import type { NetworkInterfaceInfo } from '@shared/types'
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { useGlassAttributes } from '../hooks/useGlassAttributes'
import { useSettingsShortcut } from '../hooks/useSettingsShortcut'
import { useAppStore } from '../store/useAppStore'
import { SettingsScreen } from './SettingsScreen'

// The dialogs have their own tests end to end; here they are stand-ins that show they were opened.
vi.mock('../components/LimitsDialog', () => ({
  LimitsDialog: ({ open, showSchedule }: { open: boolean; showSchedule: boolean }) =>
    open ? <div role="dialog">{showSchedule ? 'Schedule' : 'Limits'}</div> : null
}))
vi.mock('../components/UsenetServerDialog', () => ({
  UsenetServerDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Usenet</div> : null
}))

const MB = 1024 * 1024
const initial = useAppStore.getState()
let dark = false
let observed: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
const usenetServer = vi.fn(() =>
  Promise.resolve({ enabled: true, host: 'news.example.com', connections: 8 } as unknown)
)

function show(): void {
  render(
    <TooltipProvider>
      <SettingsScreen />
    </TooltipProvider>
  )
}
const section = async (name: string): Promise<void> => {
  await userEvent.setup().click(
    within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
      name
    })
  )
}

beforeEach(() => {
  dark = false
  observed = []
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark
    },
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
    usenetServer,
    chooseDestinationFolder: vi.fn(() => Promise.resolve('/Users/test/Films'))
  } as unknown as typeof window.mergelane
  useAppStore.setState({
    screen: 'settings',
    settingsSection: 'general',
    interfaces: [
      {
        id: 'en0',
        device: 'en0',
        displayName: 'Wi-Fi',
        addresses: [],
        kind: 'wifi'
      } as NetworkInterfaceInfo
    ],
    downloads: {},
    homeDir: '/Users/test',
    destinationDir: '/Users/test/Downloads'
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings, General', () => {
  it('shows speeds in the units chosen, with slow mode and the total speed', async () => {
    useAppStore.setState({ speedLimit: 5 * MB, slowModeSpeed: 2 * MB })
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
    expect(screen.getByText(/Megabytes per second/)).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mbps' }))
    expect(useAppStore.getState().speedUnit).toBe('bits')
    expect(screen.getByText(/Megabits per second/)).toBeTruthy()
    expect(screen.getByText(/All downloads together are limited to/)).toBeTruthy()
    await user.click(screen.getByRole('switch', { name: 'Slow mode' }))
    expect(useAppStore.getState().slowMode).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Change…' }))
    expect(screen.getByRole('dialog').textContent).toBe('Limits')
    cleanup()
    useAppStore.setState({ speedLimit: undefined })
    show()
    expect(screen.getByText('No limit on all downloads together.')).toBeTruthy()
  })
})

describe('Settings, Appearance', () => {
  it('picks light, dark or Auto, and a theme, with previews of the mode shown', async () => {
    useAppStore.setState({ themeSource: 'system', appearanceTheme: 'porcelain' })
    show()
    await section('Appearance')
    expect(screen.getByText('Follows your Mac, which is light right now.')).toBeTruthy()
    expect(screen.getByText(/Previews show the light version/)).toBeTruthy()
    const user = userEvent.setup()
    await user.click(
      within(screen.getByRole('group', { name: 'Light or dark' })).getByRole('button', {
        name: 'Dark'
      })
    )
    expect(useAppStore.getState().themeSource).toBe('dark')
    expect(screen.getByText('Always dark, whatever your Mac uses.')).toBeTruthy()
    expect(screen.getByText(/Previews show the dark version/)).toBeTruthy()
    const themes = within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio')
    expect(themes).toHaveLength(7)
    await user.click(screen.getByRole('radio', { name: /^Sage/ }))
    expect(useAppStore.getState().appearanceTheme).toBe('sage')
    // Network colours in this theme.
    expect(screen.getByText('Wi-Fi')).toBeTruthy()
    cleanup()
    dark = true
    useAppStore.setState({ themeSource: 'system', interfaces: [] })
    show()
    expect(screen.getByText('Follows your Mac, which is dark right now.')).toBeTruthy()
    expect(screen.getByText('No network connected.')).toBeTruthy()
  })
})

describe('Settings, Downloads', () => {
  it('changes where downloads go, how many run, the schedule and the news server', async () => {
    useAppStore.setState({ settingsSection: 'downloads', downloadsAtOnce: 2 })
    show()
    expect(screen.getByText('~/Downloads')).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Change…' })[0])
    await waitFor(() => expect(useAppStore.getState().destinationDir).toBe('/Users/test/Films'))
    await user.click(
      within(screen.getByRole('group', { name: 'Downloads at once' })).getByRole('button', {
        name: '4'
      })
    )
    expect(useAppStore.getState().downloadsAtOnce).toBe(4)
    expect(screen.getByText('Off. Downloads start whenever they’re added.')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Change…' })[1])
    expect(screen.getByRole('dialog').textContent).toBe('Schedule')
    await user.keyboard('{Escape}')
    expect(await screen.findByText('news.example.com, 8 connections')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Change…' })[2])
    expect(screen.getAllByRole('dialog').at(-1)!.textContent).toBe('Usenet')
    await user.click(screen.getByRole('button', { name: 'Open in Networks' }))
    expect(useAppStore.getState().screen).toBe('networks')
  })

  it('says when there’s no news server, or it is off, and when the schedule is on', async () => {
    usenetServer.mockImplementationOnce(() => Promise.reject(new Error('none')))
    useAppStore.setState({
      settingsSection: 'downloads',
      downloadSchedule: {
        enabled: true,
        startMinute: 0,
        endMinute: 60,
        days: [0, 1, 2, 3, 4, 5, 6]
      }
    })
    show()
    expect(await screen.findByText('Not set up. Set one up to download NZB files.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up…' })).toBeTruthy()
    cleanup()
    usenetServer.mockImplementationOnce(() =>
      Promise.resolve({ enabled: false, host: 'news.example.com', connections: 1 } as unknown)
    )
    show()
    expect(
      await screen.findByText(
        'news.example.com, 1 connection. Off: NZB links download as plain files.'
      )
    ).toBeTruthy()
  })
})

describe('Settings, narrow, and ⌘,', () => {
  it('a narrow Settings picks its section from a segmented control', async () => {
    show()
    act(() => observed.forEach((callback) => callback([{ contentRect: { width: 500 } }])))
    const sections = screen.getByRole('group', { name: 'Settings sections' })
    await userEvent.setup().click(within(sections).getByRole('button', { name: 'Downloads' }))
    expect(useAppStore.getState().settingsSection).toBe('downloads')
    // Pressing the one shown keeps it.
    await userEvent.setup().click(within(sections).getByRole('button', { name: 'Downloads' }))
    expect(useAppStore.getState().settingsSection).toBe('downloads')
  })

  it('⌘, opens Settings, and nothing else does', () => {
    useAppStore.setState({ screen: 'downloads' })
    renderHook(() => useSettingsShortcut())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))
    expect(useAppStore.getState().screen).toBe('downloads')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }))
    expect(useAppStore.getState().screen).toBe('settings')
  })
})

describe('Settings, Liquid Glass', () => {
  it('shows the glass look and Reduce transparency for the Liquid Glass theme only', async () => {
    useAppStore.setState({ settingsSection: 'appearance', appearanceTheme: 'porcelain' })
    show()
    expect(screen.queryByRole('region', { name: 'Liquid Glass' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /^Liquid Glass/ }))
    const glass = screen.getByRole('region', { name: 'Liquid Glass' })
    expect(within(glass).getByText('Clear lets more of the desktop show through.')).toBeTruthy()
    await user.click(within(glass).getByRole('button', { name: 'Tinted' }))
    expect(useAppStore.getState().glassLook).toBe('tinted')
    expect(
      within(glass).getByText('Tinted makes the glass thicker, for more contrast.')
    ).toBeTruthy()
    // Pressing the look already chosen keeps it.
    await user.click(within(glass).getByRole('button', { name: 'Tinted' }))
    expect(useAppStore.getState().glassLook).toBe('tinted')
    await user.click(within(glass).getByRole('switch', { name: 'Reduce transparency' }))
    expect(useAppStore.getState().solidGlass).toBe(true)
    expect(window.mergelane.updateSettings).toHaveBeenCalledWith({ solidGlass: true })
    await user.click(within(glass).getByRole('switch', { name: 'Reduce transparency' }))
    expect(window.mergelane.updateSettings).toHaveBeenCalledWith({ solidGlass: undefined })
  })

  it('when the Mac reduces transparency, the switch is on and can’t be turned off', () => {
    dark = true // the stubbed media query answers true to every query here
    useAppStore.setState({ settingsSection: 'appearance', appearanceTheme: 'liquid' })
    show()
    const glass = screen.getByRole('region', { name: 'Liquid Glass' })
    const solid = within(glass).getByRole('switch', { name: 'Reduce transparency' })
    expect(solid.getAttribute('aria-checked')).toBe('true')
    expect(solid.getAttribute('data-disabled')).not.toBeNull()
    expect(within(glass).getByText(/Already on in your Mac’s Accessibility settings/)).toBeTruthy()
  })

  it('marks the page for the glass look and solid glass', () => {
    const { rerender } = renderHook(() => useGlassAttributes())
    const root = document.documentElement
    expect(root.hasAttribute('data-glass')).toBe(false)
    act(() => useAppStore.setState({ glassLook: 'tinted', solidGlass: true }))
    rerender()
    expect(root.getAttribute('data-glass')).toBe('tinted')
    expect(root.hasAttribute('data-solid')).toBe(true)
    act(() => useAppStore.setState({ glassLook: 'clear', solidGlass: false }))
    rerender()
    expect(root.hasAttribute('data-glass')).toBe(false)
    expect(root.hasAttribute('data-solid')).toBe(false)
  })
})
