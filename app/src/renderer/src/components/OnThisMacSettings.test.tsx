import type { LoginItemState } from '@shared/types'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { OnThisMacSettings } from './OnThisMacSettings'

const initial = useAppStore.getState()
let login: LoginItemState
const loginItem = vi.fn(() => Promise.resolve(login))
const setOpenAtLogin = vi.fn((on: boolean) =>
  Promise.resolve<LoginItemState>({ on, status: on ? 'enabled' : 'not-registered' })
)
const updateSettings = vi.fn(() => Promise.resolve())

beforeEach(() => {
  login = { on: false, status: 'not-registered' }
  window.mergelane = {
    ...window.mergelane,
    loginItem,
    setOpenAtLogin,
    updateSettings
  } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

async function show(): Promise<void> {
  render(<OnThisMacSettings />)
  await act(async () => {})
}
// "Open at login" on a Mac, "Start with Windows" on a PC (the design's Windows 11 study).
const loginSwitch = (): HTMLElement =>
  screen.getByRole('switch', {
    name: window.mergelane.platform === 'win32' ? 'Start with Windows' : 'Open at login'
  })
const hint = (): string => loginSwitch().closest('div.border-b')!.querySelector('p')!.textContent!

describe('On this Mac', () => {
  it('turns Open at login on, and shows what macOS made of it', async () => {
    const user = userEvent.setup()
    await show()
    expect(loginSwitch().getAttribute('aria-checked')).toBe('false')
    expect(hint()).toBe('Starts in the menu bar, so scheduled downloads begin on time.')
    await user.click(loginSwitch())
    expect(setOpenAtLogin).toHaveBeenCalledWith(true)
    expect(loginSwitch().getAttribute('aria-checked')).toBe('true')
    expect(hint()).toBe('Starts in the menu bar, so scheduled downloads begin on time.')
    await user.click(loginSwitch())
    expect(setOpenAtLogin).toHaveBeenLastCalledWith(false)
    expect(loginSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('says when macOS wants approval, or didn’t take it', async () => {
    login = { on: true, status: 'requires-approval' }
    await show()
    expect(hint()).toBe(
      'macOS needs your approval: turn Mergelane on in System Settings › General › Login Items.'
    )
    cleanup()
    login = { on: true, status: 'not-registered' }
    await show()
    expect(hint()).toBe(
      'macOS didn’t take it. Add Mergelane yourself in System Settings › General › Login Items.'
    )
    cleanup()
    login = { on: true, status: 'not-found' }
    await show()
    expect(hint()).toMatch(/^macOS didn’t take it\./)
    cleanup()
    login = { on: false, status: 'not-found' }
    await show()
    expect(hint()).toBe('Starts in the menu bar, so scheduled downloads begin on time.')
  })

  it('can’t be turned on in a build that never registers itself, or before macOS answers', async () => {
    loginItem.mockImplementationOnce(() => new Promise(() => {}))
    render(<OnThisMacSettings />)
    expect(loginSwitch().hasAttribute('data-disabled')).toBe(true)
    expect(hint()).toBe('Starts in the menu bar, so scheduled downloads begin on time.')
    cleanup()
    login = { on: false, status: 'unavailable' }
    await show()
    expect(loginSwitch().hasAttribute('data-disabled')).toBe(true)
    expect(hint()).toBe('Only Mergelane installed from its disk image can open at login.')
  })

  it('a failed change puts the switch back', async () => {
    setOpenAtLogin.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    await userEvent.setup().click(loginSwitch())
    expect(loginSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('an answer after leaving Settings is let go', async () => {
    let answer: (state: LoginItemState) => void = () => {}
    loginItem.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { unmount } = render(<OnThisMacSettings />)
    unmount()
    await act(async () => answer({ on: true, status: 'enabled' }))
    expect(loginItem).toHaveBeenCalledOnce()
    loginItem.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(loginSwitch().hasAttribute('data-disabled')).toBe(true)
  })

  it('turns Mergelane in the menu bar and the notifications off and on, and saves them', async () => {
    const user = userEvent.setup()
    await show()
    const menuBar = screen.getByRole('switch', { name: 'Show Mergelane in the menu bar' })
    const notify = screen.getByRole('switch', { name: 'Notify me when a download finishes' })
    expect(menuBar.closest('div.border-b')!.querySelector('p')!.textContent).toBe(
      'Click its icon to see each network’s speed, and to pause or start downloads.'
    )
    expect(menuBar.getAttribute('aria-checked')).toBe('true')
    expect(notify.getAttribute('aria-checked')).toBe('true')
    await user.click(menuBar)
    await user.click(notify)
    expect(updateSettings).toHaveBeenCalledWith({ menuBarSpeed: false })
    expect(updateSettings).toHaveBeenCalledWith({ notifyWhenDone: false })
    expect(useAppStore.getState()).toMatchObject({ menuBarSpeed: false, notifyWhenDone: false })
    await user.click(menuBar)
    await user.click(notify)
    expect(updateSettings).toHaveBeenCalledWith({ menuBarSpeed: undefined })
    expect(updateSettings).toHaveBeenCalledWith({ notifyWhenDone: undefined })
  })

  it('the speed beside the icon: automatic by default, or always, or never (ADR-0069)', async () => {
    const user = userEvent.setup()
    await show()
    const group = screen.getByRole('group', { name: 'Speed beside the icon' })
    const hint = (): string => group.closest('div.border-b')!.querySelector('p')!.textContent!
    const choice = (name: string): HTMLElement => within(group).getByRole('button', { name })
    expect(choice('Automatic').getAttribute('aria-pressed')).toBe('true')
    expect(hint()).toBe(
      'Shows only while 2 or more networks are connected, so it takes no room when there’s nothing to combine. With System merge on, it’s this Mac’s whole speed; otherwise Mergelane’s.'
    )
    await user.click(choice('Always'))
    expect(updateSettings).toHaveBeenLastCalledWith({ menuBarSpeedText: 'on' })
    expect(hint()).toMatch(/^Always shows the download and upload speed beside the icon\./)
    await user.click(choice('Never'))
    expect(updateSettings).toHaveBeenLastCalledWith({ menuBarSpeedText: 'off' })
    expect(hint()).toMatch(/^Just the icon\. Click it to see the speeds\./)
    // Automatic is saved as nothing.
    await user.click(choice('Automatic'))
    expect(updateSettings).toHaveBeenLastCalledWith({ menuBarSpeedText: undefined })
    expect(useAppStore.getState().menuBarSpeedText).toBe('auto')

    // Without Mergelane in the menu bar, there's no icon to put it beside.
    await user.click(screen.getByRole('switch', { name: 'Show Mergelane in the menu bar' }))
    expect(hint()).toBe('Turn on Show Mergelane in the menu bar first.')
    expect(
      choice('Always').hasAttribute('disabled') ||
        choice('Always').getAttribute('aria-disabled') === 'true'
    ).toBe(true)
  })
})

describe('On this PC (Windows)', () => {
  beforeEach(() => {
    window.mergelane.platform = 'win32'
  })
  afterEach(() => {
    window.mergelane.platform = 'darwin'
  })

  it('speaks of the PC and the notification area, and where Windows lists startup apps', async () => {
    await show()
    expect(screen.getByRole('region', { name: 'On this PC' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /Show the merged speed/ })).toBeNull()
    expect(hint()).toBe('Starts in the notification area, so scheduled downloads begin on time.')
    expect(screen.queryByRole('switch', { name: 'Open at login' })).toBeNull()
    expect(screen.getByText(/Uses Windows notifications/)).toBeTruthy()
    cleanup()
    login = { on: true, status: 'enabled' }
    await show()
    expect(hint()).toBe(
      'Starts in the notification area, so scheduled downloads begin on time. Windows lists it in Settings › Apps › Startup.'
    )
  })

  it('keeps Mergelane in the notification area when the window closes, the menu bar switch’s setting', async () => {
    const user = userEvent.setup()
    await show()
    const keep = screen.getByRole('switch', {
      name: 'Keep running in the notification area when I close the window'
    })
    expect(keep.getAttribute('aria-checked')).toBe('true')
    expect(keep.closest('div.border-b')!.querySelector('p')!.textContent).toBe(
      'Downloads carry on. Point at the Mergelane icon to see the merged speed; right-click it to exit.'
    )
    await user.click(keep)
    expect(updateSettings).toHaveBeenCalledWith({ menuBarSpeed: false })
    expect(useAppStore.getState().menuBarSpeed).toBe(false)
  })

  it('says only the installed app can open at login', async () => {
    login = { on: false, status: 'unavailable' }
    await show()
    expect(hint()).toBe('Only Mergelane installed with its installer can open at login.')
  })
})
