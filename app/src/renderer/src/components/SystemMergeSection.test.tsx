import type { SystemMergeRemoval, SystemMergeSnapshot } from '@shared/types'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemMergeSection } from './SystemMergeSection'

// The System merge section (and its hook, useSystemMerge) against a stand-in for the preload
// bridge: what each helper state shows, what each control sends, and "Remove helper…" with its
// confirmation and the three ways it can end (ADR-0046). The e2e suite drives the same section
// against a fake daemon (e2e/systemMerge.spec.ts).

function snapshot(patch: Partial<SystemMergeSnapshot> = {}): SystemMergeSnapshot {
  return {
    installed: true,
    reachable: true,
    state: 'off',
    links: [],
    appVersion: '0.3.0',
    helperVersion: '0.3.0',
    helperOutdated: false,
    autoResume: false,
    events: [],
    outages: [],
    ...patch
  }
}

type Bridge = {
  systemMerge: ReturnType<typeof vi.fn>
  setSystemMerge: ReturnType<typeof vi.fn>
  installSystemMerge: ReturnType<typeof vi.fn>
  removeSystemMerge: ReturnType<typeof vi.fn>
  setSystemMergeAutoResume: ReturnType<typeof vi.fn>
}

let bridge: Bridge
let current: SystemMergeSnapshot

beforeEach(() => {
  current = snapshot()
  bridge = {
    systemMerge: vi.fn(async () => current),
    setSystemMerge: vi.fn(
      async (on: boolean) => (current = snapshot({ state: on ? 'on' : 'off' }))
    ),
    installSystemMerge: vi.fn(async () => current),
    removeSystemMerge: vi.fn(),
    setSystemMergeAutoResume: vi.fn(
      async (enabled: boolean) => (current = snapshot({ autoResume: enabled }))
    )
  }
  Object.assign(window.mergelane, bridge)
})

afterEach(() => {
  vi.useRealTimers()
  for (const key of Object.keys(bridge))
    delete (window.mergelane as unknown as Record<string, unknown>)[key]
})

async function section(): Promise<HTMLElement> {
  render(<SystemMergeSection open />)
  return screen.findByRole('region', { name: 'System merge' })
}

describe('SystemMergeSection', () => {
  it('says it is checking until the first snapshot arrives', async () => {
    bridge.systemMerge.mockReturnValue(new Promise(() => {}))
    render(<SystemMergeSection open />)
    expect(screen.getByText('Checking system merge…')).toBeTruthy()
  })

  it('asks nothing while closed', () => {
    render(<SystemMergeSection open={false} />)
    expect(bridge.systemMerge).not.toHaveBeenCalled()
  })

  it('switches merging on, and shows each link’s merged traffic', async () => {
    const region = await section()
    expect(within(region).getByRole('status').textContent).toMatch(/^Off\./)
    current = snapshot({
      state: 'on',
      links: [
        { name: 'en0', state: 'up', rxBps: 2_000_000, txBps: 1000, activeFlows: 3 },
        { name: 'en5', state: 'down', rxBps: 0, txBps: 0, activeFlows: 0 },
        { name: 'en7', state: 'unknown', rxBps: 0, txBps: 0, activeFlows: 0 }
      ]
    })
    bridge.setSystemMerge.mockResolvedValueOnce(current)
    await userEvent.click(within(region).getByRole('switch', { name: 'System merge' }))
    expect(bridge.setSystemMerge).toHaveBeenCalledWith(true)
    const traffic = await within(region).findByRole('list', { name: 'Merged traffic per network' })
    expect(within(traffic).getByText(/no internet/)).toBeTruthy()
    expect(within(traffic).getByText(/checking/)).toBeTruthy()
  })

  it('shows a refusal as an alert, and a reason while on as news', async () => {
    current = snapshot({ error: 'Another VPN is on.' })
    const region = await section()
    expect(within(region).getByRole('alert').textContent).toBe('Another VPN is on.')
    current = snapshot({ state: 'on', reason: 'Back on after a crash.' })
    bridge.setSystemMerge.mockResolvedValueOnce(current)
    await userEvent.click(within(region).getByRole('switch', { name: 'System merge' }))
    await within(region).findByText('Back on after a crash.')
    expect(within(region).queryByRole('alert')).toBeNull()
  })

  it('offers the install without the helper, and no removal', async () => {
    current = snapshot({ installed: false, reachable: false })
    const region = await section()
    expect(within(region).getByText('Needs a one-time install of a small helper.')).toBeTruthy()
    expect(within(region).queryByRole('button', { name: /Remove helper/ })).toBeNull()
    let finish: (value: SystemMergeSnapshot) => void = () => {}
    bridge.installSystemMerge.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    await userEvent.click(within(region).getByRole('button', { name: 'Install' }))
    expect(within(region).getByRole('button', { name: 'Installing…' })).toBeTruthy()
    await act(async () => finish(snapshot()))
    expect(await within(region).findByRole('button', { name: 'Remove helper…' })).toBeTruthy()
  })

  it('says when an installed helper isn’t running', async () => {
    current = snapshot({ reachable: false })
    const region = await section()
    expect(within(region).getByRole('status').textContent).toBe("Mergelane's helper isn't running.")
    // A stuck helper can still be removed.
    expect(within(region).getByRole('button', { name: 'Remove helper…' })).toBeTruthy()
  })

  it('offers the update for an out-of-date helper', async () => {
    current = snapshot({ reachable: false, helperOutdated: true, helperVersion: '0.1.0' })
    const region = await section()
    expect(within(region).getByRole('status').textContent).toBe('Off until the helper is updated.')
    const banner = within(region).getByRole('group', { name: "Mergelane's helper is out of date" })
    expect(banner.textContent).toContain('The helper is 0.1.0; this app is 0.3.0.')
    bridge.installSystemMerge.mockReturnValueOnce(new Promise(() => {}))
    await userEvent.click(within(banner).getByRole('button', { name: 'Update' }))
    expect(within(banner).getByRole('button', { name: 'Updating…' })).toBeTruthy()
  })

  it('says a newer helper is needed when the versions match but a method is missing', async () => {
    current = snapshot({ helperOutdated: true, autoResume: undefined })
    const region = await section()
    expect(within(region).getByText('This app needs a newer helper.')).toBeTruthy()
    expect(within(region).getByText('Needs the updated helper.')).toBeTruthy()
  })

  it('turns auto-resume on', async () => {
    const region = await section()
    await userEvent.click(
      within(region).getByRole('switch', { name: 'Turn back on after a crash' })
    )
    expect(bridge.setSystemMergeAutoResume).toHaveBeenCalledWith(true)
    await waitFor(() =>
      expect(
        within(region)
          .getByRole('switch', { name: 'Turn back on after a crash' })
          .getAttribute('aria-checked')
      ).toBe('true')
    )
  })

  it('lists recent dropouts, newest first', async () => {
    const now = Date.now()
    const at = (seconds: number): string => new Date(now - seconds * 1000).toISOString()
    current = snapshot({
      outages: [
        { link: 'en5', kind: 'down', at: at(150), reason: 'probe-failed', backAt: at(110) },
        { link: 'en7', kind: 'gone', at: at(30), reason: 'lost' },
        { link: 'en9', kind: 'down', at: at(7200), reason: 'probe-failed', backAt: at(7100) }
      ]
    })
    const region = await section()
    const rows = within(
      within(region).getByRole('list', { name: 'Recent network dropouts' })
    ).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'en7 disconnected just now · still out',
      'en5 dropped 2 min ago · back after 40s'
    ])
  })

  it('lists older dropouts while merging is on', async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    current = snapshot({
      state: 'on',
      outages: [{ link: 'en5', kind: 'down', at: yesterday.toISOString(), reason: 'probe-failed' }]
    })
    const region = await section()
    expect(
      within(region).getByRole('list', { name: 'Recent network dropouts' }).textContent
    ).toMatch(/^en5 dropped yesterday /)
  })

  it('keeps polling while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await section()
    const calls = bridge.systemMerge.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(2100))
    expect(bridge.systemMerge.mock.calls.length).toBeGreaterThanOrEqual(calls + 2)
  })
})

describe('Remove helper', () => {
  async function confirmRemoval(result: () => Promise<SystemMergeRemoval>): Promise<HTMLElement> {
    bridge.removeSystemMerge.mockImplementationOnce(result)
    const region = await section()
    await userEvent.click(within(region).getByRole('button', { name: 'Remove helper…' }))
    const dialog = await screen.findByRole('alertdialog', { name: "Remove Mergelane's helper?" })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove helper' }))
    return region
  }

  it('says plainly what removing does, and Cancel leaves the helper alone', async () => {
    const region = await section()
    const button = within(region).getByRole('button', { name: 'Remove helper…' })
    expect(button.getAttribute('aria-describedby')).toBeTruthy()
    expect(within(region).getByText(/Downloads don't need it\./)).toBeTruthy()
    await userEvent.click(button)
    const dialog = await screen.findByRole('alertdialog', { name: "Remove Mergelane's helper?" })
    expect(dialog.textContent).toContain(
      "System merge turns off, and can't be used until you install the helper again."
    )
    expect(dialog.textContent).toContain('Your Mac asks for your administrator password.')
    expect(dialog.textContent).toContain('Downloads keep working on every network.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(bridge.removeSystemMerge).not.toHaveBeenCalled()
  })

  it('removes the helper, says so, and offers the install again', async () => {
    let finish: (value: SystemMergeRemoval) => void = () => {}
    const region = await confirmRemoval(() => new Promise((resolve) => (finish = resolve)))
    expect(bridge.removeSystemMerge).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const removing = within(region).getByRole('button', { name: 'Removing…' }) as HTMLButtonElement
    expect(removing.disabled).toBe(true)
    current = snapshot({ installed: false, reachable: false })
    await act(async () =>
      finish({
        outcome: 'removed',
        message: 'Helper removed. Install it again to use system merge.',
        snapshot: current
      })
    )
    const done = await within(region).findByText(
      'Helper removed. Install it again to use system merge.'
    )
    expect(done.getAttribute('aria-live')).toBe('polite')
    expect(within(region).getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(within(region).queryByRole('button', { name: /Remove helper/ })).toBeNull()
    // The note stays through the polls that follow, and goes with the next request.
    bridge.installSystemMerge.mockReturnValueOnce(new Promise(() => {}))
    await userEvent.click(within(region).getByRole('button', { name: 'Install' }))
    expect(within(region).queryByText(/Helper removed/)).toBeNull()
  })

  it('says when the password prompt was canceled', async () => {
    const region = await confirmRemoval(() =>
      Promise.resolve({
        outcome: 'canceled',
        message: 'Removal canceled. The helper is still installed.',
        snapshot: snapshot()
      })
    )
    const note = await within(region).findByText('Removal canceled. The helper is still installed.')
    expect(note.getAttribute('role')).toBeNull()
    expect(within(region).getByRole('button', { name: 'Remove helper…' })).toBeTruthy()
  })

  it('shows why a removal failed', async () => {
    const region = await confirmRemoval(() =>
      Promise.resolve({
        outcome: 'failed',
        message: "Couldn't remove the helper: launchctl bootout failed",
        snapshot: snapshot()
      })
    )
    expect((await within(region).findByRole('alert')).textContent).toBe(
      "Couldn't remove the helper: launchctl bootout failed"
    )
  })

  it('stays usable when the bridge itself fails', async () => {
    const region = await confirmRemoval(() => Promise.reject(new Error('IPC gone')))
    expect(await within(region).findByRole('button', { name: 'Remove helper…' })).toBeTruthy()
    expect(within(region).queryByRole('alert')).toBeNull()
  })
})
