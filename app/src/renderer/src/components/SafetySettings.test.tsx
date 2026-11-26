import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { SafetySettings } from './SafetySettings'

const initial = useAppStore.getState()
const updateSettings = vi.fn(() => Promise.resolve())

beforeEach(() => {
  window.mergelane = { ...window.mergelane, updateSettings } as typeof window.mergelane
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

describe('If something goes wrong', () => {
  it('says progress is saved every 2 seconds, and that it is always on', () => {
    render(<SafetySettings />)
    const group = screen.getByRole('region', { name: 'If something goes wrong' })
    expect(group.textContent).toContain(
      'Downloads survive crashes, power cuts and links that stop working.'
    )
    expect(within(group).getByText('Save progress every 2 seconds')).toBeTruthy()
    expect(
      within(group).getByText(
        'Each chunk is written and its place in the file recorded together. After a crash, a force quit or a power cut, downloads resume from the last save.'
      )
    ).toBeTruthy()
    expect(within(group).getByText('Always on')).toBeTruthy()
  })

  it('picks up fresh links from the browser unless turned off, and saves the choice', async () => {
    render(<SafetySettings />)
    const fresh = screen.getByRole('switch', { name: 'Pick up fresh links from the browser' })
    expect(fresh.getAttribute('aria-checked')).toBe('true')
    expect(
      screen.getByText(
        'When a link expires, click the same download again in a browser with the extension. Mergelane continues the stopped download instead of starting over.'
      )
    ).toBeTruthy()
    await userEvent.click(fresh)
    expect(useAppStore.getState().catchFreshLinks).toBe(false)
    expect(updateSettings).toHaveBeenLastCalledWith({ catchFreshLinks: false })
    await userEvent.click(fresh)
    expect(useAppStore.getState().catchFreshLinks).toBe(true)
    // On is the default, so nothing is kept for it.
    expect(updateSettings).toHaveBeenLastCalledWith({ catchFreshLinks: undefined })
  })
})
