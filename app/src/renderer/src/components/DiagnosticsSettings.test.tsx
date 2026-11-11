import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDiagnosticsMenu } from '../hooks/useNetworks'
import { useAppStore } from '../store/useAppStore'
import { DiagnosticsSettings } from './DiagnosticsSettings'

const initial = useAppStore.getState()
let answer: () => Promise<{ fileName: string } | null>
const saveDiagnostics = vi.fn(() => answer())
const revealDiagnostics = vi.fn(() => Promise.resolve())
let menuListener: (() => void) | null = null
const onSaveDiagnosticsRequested = vi.fn((callback: () => void) => {
  menuListener = callback
  return () => {
    menuListener = null
  }
})

beforeEach(() => {
  answer = () => Promise.resolve({ fileName: 'Mergelane-Diagnostics-2026-11-11-1430.zip' })
  window.mergelane = {
    ...window.mergelane,
    saveDiagnostics,
    revealDiagnostics,
    onSaveDiagnosticsRequested
  } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

const status = (): string => screen.getByRole('status').textContent!
const saveButton = (): HTMLElement =>
  screen.getByRole('button', { name: /Save Diagnostics|Saving/ })

describe('Settings › General › Troubleshooting', () => {
  it('says what a bundle holds, saves one, and shows it in the Finder', async () => {
    const user = userEvent.setup()
    render(<DiagnosticsSettings />)
    expect(screen.getByRole('region', { name: 'Troubleshooting' })).toBeTruthy()
    expect(screen.getByText(/Mergelane never sends it anywhere/)).toBeTruthy()
    expect(status()).toBe('')
    expect(screen.queryByRole('button', { name: 'Show in Finder' })).toBeNull()

    await user.click(saveButton())
    expect(saveDiagnostics).toHaveBeenCalledTimes(1)
    expect(status()).toBe('Saved as Mergelane-Diagnostics-2026-11-11-1430.zip.')
    await user.click(screen.getByRole('button', { name: 'Show in Finder' }))
    expect(revealDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('while saving, the button waits and a second press does nothing', async () => {
    let finish: (value: { fileName: string } | null) => void = () => {}
    answer = () => new Promise((resolve) => (finish = resolve))
    const user = userEvent.setup()
    render(<DiagnosticsSettings />)
    await user.click(saveButton())
    expect(saveButton().textContent).toBe('Saving…')
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true)
    expect(status()).toBe('Saving the diagnostics…')
    await act(() => useAppStore.getState().saveDiagnostics())
    expect(saveDiagnostics).toHaveBeenCalledTimes(1)
    // Cancelled in the dialog: back to how it was.
    await act(async () => finish(null))
    expect(status()).toBe('')
    expect(saveButton().textContent).toBe('Save Diagnostics…')
  })

  it('says why a save failed, without Electron’s wrapping', async () => {
    answer = () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'diagnostics:save': Error: The diagnostics couldn’t be saved there. Choose another folder."
        )
      )
    const user = userEvent.setup()
    render(<DiagnosticsSettings />)
    await user.click(saveButton())
    expect(status()).toBe('The diagnostics couldn’t be saved there. Choose another folder.')
    expect(screen.getByRole('status').className).toContain('text-destructive')
  })

  it('the app menu’s Save Diagnostics… opens Settings › General and saves one', async () => {
    useAppStore.setState({ screen: 'downloads', settingsSection: 'updates' })
    const { unmount } = renderHook(() => useDiagnosticsMenu())
    expect(onSaveDiagnosticsRequested).toHaveBeenCalledTimes(1)
    await act(async () => menuListener!())
    expect(useAppStore.getState().screen).toBe('settings')
    expect(useAppStore.getState().settingsSection).toBe('general')
    expect(saveDiagnostics).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().diagnostics).toEqual({
      status: 'saved',
      fileName: 'Mergelane-Diagnostics-2026-11-11-1430.zip'
    })
    unmount()
    expect(menuListener).toBeNull()
  })
})
