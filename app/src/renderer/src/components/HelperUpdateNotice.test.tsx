import type { SystemMergeSnapshot } from '@shared/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { HelperUpdateNotice } from './HelperUpdateNotice'

function snapshot(patch: Partial<SystemMergeSnapshot> = {}): SystemMergeSnapshot {
  return {
    installed: true,
    reachable: true,
    state: 'off',
    links: [],
    appVersion: '0.3.3',
    helperVersion: '0.3.2',
    helperOutdated: true,
    events: [],
    outages: [],
    ...patch
  }
}

const initial = useAppStore.getState()
let current: SystemMergeSnapshot
const systemMerge = vi.fn(() => Promise.resolve(current))
const installSystemMerge = vi.fn(() => Promise.resolve(snapshot({ helperOutdated: false })))

beforeEach(() => {
  current = snapshot()
  window.mergelane = {
    ...window.mergelane,
    systemMerge,
    installSystemMerge
  } as typeof window.mergelane
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

async function show(): Promise<void> {
  render(<HelperUpdateNotice />)
  await act(async () => {})
}
const notice = (): HTMLElement | null => screen.queryByRole('status', { name: 'Helper update' })

describe('the helper update notice', () => {
  it('offers the update at launch, and one click asks macOS', async () => {
    await show()
    expect(notice()?.textContent).toContain('Update the helper to match Mergelane 0.3.3.')
    expect(notice()?.textContent).toContain('Your Mac asks for your password.')
    let finish: (value: SystemMergeSnapshot) => void = () => {}
    installSystemMerge.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await userEvent.click(screen.getByRole('button', { name: 'Update…' }))
    expect(installSystemMerge).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Updating…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Later' }).hasAttribute('disabled')).toBe(true)
    await act(async () => finish(snapshot({ helperOutdated: false, helperVersion: '0.3.3' })))
    expect(notice()).toBeNull()
  })

  it('says why an update failed, and can be tried again', async () => {
    installSystemMerge.mockImplementationOnce(() =>
      Promise.resolve(snapshot({ error: 'The password prompt was closed.' }))
    )
    await show()
    await userEvent.click(screen.getByRole('button', { name: 'Update…' }))
    expect(screen.getByText('The password prompt was closed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update…' })).toBeTruthy()
    // A request that fails outright leaves it as it was.
    installSystemMerge.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await userEvent.click(screen.getByRole('button', { name: 'Update…' }))
    expect(screen.getByRole('button', { name: 'Update…' })).toBeTruthy()
  })

  it('is let go with Later, for this launch', async () => {
    await show()
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(notice()).toBeNull()
    expect(installSystemMerge).not.toHaveBeenCalled()
  })

  it('says nothing when there is nothing to update, or nobody uses system merge', async () => {
    for (const patch of [{ helperOutdated: false }, { installed: false }]) {
      current = snapshot(patch)
      await show()
      expect(notice()).toBeNull()
      cleanup()
    }
    systemMerge.mockImplementationOnce(() => Promise.reject(new Error('no helper')))
    await show()
    expect(notice()).toBeNull()
  })

  it('leaves it to Networks, which says the same with more', async () => {
    useAppStore.setState({ screen: 'networks' })
    await show()
    expect(notice()).toBeNull()
  })

  it('looks again when the window comes back to the front', async () => {
    current = snapshot({ helperOutdated: false })
    await show()
    expect(notice()).toBeNull()
    current = snapshot()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(notice()).not.toBeNull()
    expect(systemMerge).toHaveBeenCalledTimes(2)
  })
})
