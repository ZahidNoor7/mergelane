import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { ThemeToggle } from './ThemeToggle'

// jsdom has no matchMedia: a stand-in whose answer the test sets and can change.
function stubDarkMode(initial: boolean): { setDark: (dark: boolean) => void } {
  let dark = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && dark
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
  }))
  return {
    setDark: (next) => {
      dark = next
      act(() => listeners.forEach((listener) => listener()))
    }
  }
}

describe('ThemeToggle', () => {
  const updateSettings = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    window.mergelane = { ...window.mergelane, updateSettings } as typeof window.mergelane
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    updateSettings.mockClear()
  })

  it('on Auto, offers the opposite of what the Mac shows, and follows the Mac', () => {
    const mac = stubDarkMode(true)
    useAppStore.setState({ themeSource: 'system' })
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
    mac.setDark(false)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
  })

  it('switches from what is shown to the other mode, and saves it', async () => {
    stubDarkMode(true)
    useAppStore.setState({ themeSource: 'system' })
    render(<ThemeToggle />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(useAppStore.getState().themeSource).toBe('light')
    expect(updateSettings).toHaveBeenCalledWith({ themeSource: 'light' })
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
  })

  it('shows a saved choice whatever the Mac is in', () => {
    stubDarkMode(false)
    useAppStore.setState({ themeSource: 'dark' })
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
  })
})

describe('setAppearanceTheme', () => {
  it('picks the palette on the page and saves it', () => {
    const updateSettings = vi.fn(() => Promise.resolve())
    window.mergelane = { ...window.mergelane, updateSettings } as typeof window.mergelane
    useAppStore.getState().setAppearanceTheme('sandstone')
    expect(document.documentElement.dataset.palette).toBe('sandstone')
    expect(document.documentElement.classList.contains('mergelane-theme-fade')).toBe(true)
    expect(useAppStore.getState().appearanceTheme).toBe('sandstone')
    expect(updateSettings).toHaveBeenCalledWith({ appearanceTheme: 'sandstone' })
  })
})
