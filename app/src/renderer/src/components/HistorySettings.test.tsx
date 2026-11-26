import type { HistoryEntry } from '@shared/history'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { HistorySettings } from './HistorySettings'

const entry = (id: string, inList: boolean): HistoryEntry => ({
  id,
  kind: 'http',
  name: `${id}.iso`,
  link: `https://example.com/${id}.iso`,
  host: 'example.com',
  size: 1,
  startedAt: 1,
  ended: 'completed',
  inList,
  path: `/Users/test/Downloads/${id}.iso`,
  file: 'on_disk'
})

const initial = useAppStore.getState()
let entries: HistoryEntry[]
let changed: () => void = () => {}
const historyEntries = vi.fn(() => Promise.resolve(entries))
const forgetHistory = vi.fn(() => Promise.resolve(2))
const updateSettings = vi.fn(() => Promise.resolve())
const onHistoryChanged = vi.fn((callback: () => void) => {
  changed = callback
  return () => {}
})

beforeEach(() => {
  entries = [entry('a', false), entry('b', false), entry('c', true)]
  window.mergelane = {
    ...window.mergelane,
    historyEntries,
    forgetHistory,
    updateSettings,
    onHistoryChanged
  } as unknown as typeof window.mergelane
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

async function show(): Promise<void> {
  render(<HistorySettings />)
  await act(async () => {})
}

describe('Duplicates and history', () => {
  it('keeps history forever unless chosen otherwise, and saves the choice', async () => {
    await show()
    const keep = screen.getByRole('group', { name: 'Keep download history' })
    expect(within(keep).getByRole('button', { name: 'Forever' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    await userEvent.click(within(keep).getByRole('button', { name: '30 days' }))
    expect(useAppStore.getState().historyKeep).toBe('30d')
    expect(updateSettings).toHaveBeenLastCalledWith({ historyKeep: '30d' })
    await userEvent.click(within(keep).getByRole('button', { name: 'Forever' }))
    expect(updateSettings).toHaveBeenLastCalledWith({ historyKeep: undefined })
    expect(
      screen.getByText(
        'History is stored only on this computer. Removing a download from the list doesn’t remove it from history.'
      )
    ).toBeTruthy()
  })

  it('clears what is no longer in the list, after a second click, and says so', async () => {
    await show()
    expect(
      screen.getByText(
        'Forgets the 2 downloads no longer in the list. Files on disk aren’t touched.'
      )
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
    const confirm = screen.getByRole('group', { name: 'Confirm clearing history' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep' }))
    expect(forgetHistory).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Clear history…' }))
    entries = [entry('c', true)]
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(forgetHistory).toHaveBeenCalledOnce()
    expect(screen.getByText('History cleared. Everything in the list stays.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear history…' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('counts one, and reads again when History changes', async () => {
    entries = [entry('a', false)]
    await show()
    expect(
      screen.getByText(
        'Forgets the 1 download no longer in the list. Files on disk aren’t touched.'
      )
    ).toBeTruthy()
    entries = []
    await act(async () => changed())
    expect(
      screen.getByText(
        'Forgets the 0 downloads no longer in the list. Files on disk aren’t touched.'
      )
    ).toBeTruthy()
  })

  it('counts none when the main process can’t be asked', async () => {
    historyEntries.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(screen.getByRole('button', { name: 'Clear history…' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})
