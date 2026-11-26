import type { QueueEnd } from '@shared/queueEnd'
import type { DownloadState } from '@shared/types'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { AwakeLine, AwakeSettings, QueueDoneNotice } from './QueueEnd'

const T = new Date(2026, 10, 26, 22, 0).getTime()
const initial = useAppStore.getState()
const updateSettings = vi.fn(() => Promise.resolve())
let current: QueueEnd | null
let push: (end: QueueEnd | null) => void = () => {}
const queueEnd = vi.fn(() => Promise.resolve(current))
const cancelQueueEnd = vi.fn(() => Promise.resolve())
const endQueueNow = vi.fn(() => Promise.resolve())
const unsubscribe = vi.fn()
const onQueueEndChanged = vi.fn((callback: (end: QueueEnd | null) => void) => {
  push = callback
  return unsubscribe
})

beforeEach(() => {
  current = null
  window.mergelane = {
    ...window.mergelane,
    updateSettings,
    queueEnd,
    cancelQueueEnd,
    endQueueNow,
    onQueueEndChanged
  } as unknown as typeof window.mergelane
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Settings › General: awake, and the end of the queue', () => {
  it('keeps the Mac awake unless turned off, and saves the choice', async () => {
    render(<AwakeSettings />)
    const awake = screen.getByRole('switch', { name: 'Keep the Mac awake while downloading' })
    expect(awake.getAttribute('aria-checked')).toBe('true')
    expect(
      screen.getByText(
        'Only while something is downloading. The display can still sleep, and the Mac sleeps as usual when the queue is empty.'
      )
    ).toBeTruthy()
    await userEvent.click(awake)
    expect(useAppStore.getState().keepAwake).toBe(false)
    expect(updateSettings).toHaveBeenLastCalledWith({ keepAwake: false })
    await userEvent.click(awake)
    expect(updateSettings).toHaveBeenLastCalledWith({ keepAwake: undefined })
  })

  it('does nothing, sleeps or shuts down when the queue finishes, saying what comes first', async () => {
    render(<AwakeSettings />)
    expect(screen.getByText('The Mac goes back to its usual sleep schedule.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Sleep' }))
    expect(useAppStore.getState().afterQueue).toBe('sleep')
    expect(updateSettings).toHaveBeenLastCalledWith({ afterQueue: 'sleep' })
    expect(screen.getByText('A 60-second countdown comes first, so you can cancel.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Shut down' }))
    expect(
      screen.getByText(
        'A 60-second countdown comes first, so you can cancel. Apps with unsaved work can stop the shutdown.'
      )
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Do nothing' }))
    expect(updateSettings).toHaveBeenLastCalledWith({ afterQueue: undefined })
  })
})

describe('the sidebar’s word', () => {
  const downloading = { a: { id: 'a', status: 'downloading' } as unknown as DownloadState }

  it('says it keeps the Mac awake while something downloads, and what comes after', () => {
    useAppStore.setState({ downloads: downloading })
    const { rerender } = render(<AwakeLine />)
    expect(screen.getByText('Keeping this Mac awake')).toBeTruthy()
    useAppStore.setState({ afterQueue: 'sleep' })
    rerender(<AwakeLine />)
    expect(screen.getByText('Keeping this Mac awake, then sleep')).toBeTruthy()
    useAppStore.setState({ afterQueue: 'shutdown' })
    rerender(<AwakeLine />)
    expect(screen.getByText('Keeping this Mac awake, then shut down')).toBeTruthy()
  })

  it('says nothing when nothing downloads, or when it is turned off', () => {
    const { rerender } = render(<AwakeLine />)
    expect(screen.queryByText(/Keeping/)).toBeNull()
    useAppStore.setState({ downloads: downloading, keepAwake: false })
    rerender(<AwakeLine />)
    expect(screen.queryByText(/Keeping/)).toBeNull()
  })
})

describe('the countdown at the end of the queue', () => {
  const notice = (): HTMLElement | null =>
    screen.queryByRole('alertdialog', { name: 'The queue is done' })

  async function show(): Promise<ReturnType<typeof render>> {
    const view = render(<QueueDoneNotice />)
    await act(async () => {})
    return view
  }

  it('counts down to sleep, and Cancel stops it', async () => {
    vi.useFakeTimers({ now: T, shouldAdvanceTime: true })
    current = { action: 'sleep', endsAt: T + 60_000 }
    await show()
    expect(notice()?.textContent).toContain(
      'Your Mac will sleep in 60 s, as set in Settings › General.'
    )
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(notice()?.textContent).toMatch(/sleep in 5[45] s/)
    expect(screen.getByRole('button', { name: 'Sleep now' })).toBe(document.activeElement)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(notice()).toBeNull()
    expect(cancelQueueEnd).toHaveBeenCalledOnce()
  })

  it('shuts down now when asked, saying unsaved work can stop it and what starts later', async () => {
    current = {
      action: 'shutdown',
      endsAt: Date.now() + 60_000,
      nextStartAt: new Date(2026, 10, 27, 7, 30).getTime()
    }
    await show()
    expect(notice()?.textContent).toContain('Apps with unsaved work can stop the shutdown.')
    expect(notice()?.textContent).toContain('A scheduled download starts at')
    await userEvent.click(screen.getByRole('button', { name: 'Shut down now' }))
    expect(endQueueNow).toHaveBeenCalledOnce()
    expect(notice()).toBeNull()
  })

  it('appears and goes as the main process says, and lets go when it is gone', async () => {
    const { unmount } = await show()
    expect(notice()).toBeNull()
    await act(async () => push({ action: 'sleep', endsAt: Date.now() + 60_000 }))
    expect(notice()).toBeTruthy()
    await act(async () => push(null))
    expect(notice()).toBeNull()
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows nothing when the main process can’t be asked, or answers after it is gone', async () => {
    queueEnd.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(notice()).toBeNull()
    let answer: (end: QueueEnd | null) => void = () => {}
    queueEnd.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const late = render(<QueueDoneNotice />)
    late.unmount()
    await act(async () => answer({ action: 'sleep', endsAt: Date.now() + 1 }))
    expect(notice()).toBeNull()
  })

  it('a click that can’t reach the main process still hides it', async () => {
    cancelQueueEnd.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    endQueueNow.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    current = { action: 'sleep', endsAt: Date.now() + 60_000 }
    const first = await show()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(notice()).toBeNull()
    first.unmount()
    await show()
    await userEvent.click(screen.getByRole('button', { name: 'Sleep now' }))
    expect(notice()).toBeNull()
  })
})
