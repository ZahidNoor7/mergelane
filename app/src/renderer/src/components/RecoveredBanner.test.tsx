import type { RecoveryNote } from '@shared/recovery'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecoveredBanner } from './RecoveredBanner'

const MB = 1024 * 1024

let note: RecoveryNote | null
const recovery = vi.fn(() => Promise.resolve(note))
const dismissRecovery = vi.fn(() => Promise.resolve())

beforeEach(() => {
  note = { count: 1, agoMs: 1_000, lostBytes: MB }
  window.mergelane = {
    ...window.mergelane,
    recovery,
    dismissRecovery
  } as typeof window.mergelane
})
afterEach(() => {
  vi.clearAllMocks()
})

async function show(): Promise<void> {
  render(<RecoveredBanner />)
  await act(async () => {})
}
const banner = (): HTMLElement | null =>
  screen.queryByRole('status', { name: 'Mergelane recovered after quitting unexpectedly' })

describe('the recovery banner', () => {
  it('shows the note from the main process, and Dismiss forgets it there too', async () => {
    await show()
    expect(recovery).toHaveBeenCalledOnce()
    expect(banner()?.textContent).toContain(
      '1 download picked up from the last save, 1 s before it quit. 1.0 MB fetched again; nothing else was lost.'
    )
    expect(banner()?.getAttribute('aria-atomic')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(banner()).toBeNull()
    expect(dismissRecovery).toHaveBeenCalledOnce()
  })

  it('shows nothing after a clean quit', async () => {
    note = null
    await show()
    expect(banner()).toBeNull()
  })

  it('shows nothing when the main process can not be asked', async () => {
    recovery.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(banner()).toBeNull()
  })

  it('a dismissal that fails to reach the main process still hides it', async () => {
    dismissRecovery.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(banner()).toBeNull()
  })

  it('an answer that arrives after it is gone changes nothing', async () => {
    let answer: (value: RecoveryNote | null) => void = () => {}
    recovery.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { unmount } = render(<RecoveredBanner />)
    unmount()
    await act(async () => answer({ count: 1 }))
    expect(banner()).toBeNull()
  })
})
