import { DEFAULT_DOWNLOAD_SCHEDULE, scheduleTime } from '@shared/downloadSchedule'
import type { DownloadSchedule, NetworkInterfaceInfo, UsenetServer } from '@shared/types'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { LimitsDialog } from './LimitsDialog'

// Speed & data limits: what it shows and what Save sends, upload limits included (ADR-0041). The
// schedule's fields and the news server's own window have their own tests; here they are stand-ins.
vi.mock('./ScheduleFields', () => ({
  ScheduleFields: ({
    schedule,
    onChange
  }: {
    schedule: DownloadSchedule
    onChange: (schedule: DownloadSchedule) => void
  }) => (
    <section aria-label="Download schedule">
      <button
        type="button"
        aria-label="Enable download schedule"
        onClick={() => onChange({ ...schedule, enabled: true })}
      >
        Enable
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...schedule, endMinute: schedule.startMinute })}
      >
        Break schedule
      </button>
    </section>
  )
}))
vi.mock('./UsenetServerDialog', () => ({
  UsenetServerDialog: ({ open }: { open: boolean }) => (open ? <p>News server window</p> : null)
}))

const MB = 1024 * 1024
const GB = 1024 ** 3

const iface = (
  id: string,
  displayName: string,
  kind: NetworkInterfaceInfo['kind']
): NetworkInterfaceInfo =>
  ({ id, device: id, displayName, addresses: [], kind }) as NetworkInterfaceInfo

const SERVER: UsenetServer = {
  enabled: true,
  host: 'news.example.org',
  port: 563,
  tls: true,
  username: '',
  connections: 8,
  hasPassword: false
}

const initial = useAppStore.getState()
const updateSettings = vi.fn<(patch: unknown) => Promise<void>>(() => Promise.resolve())
const resetNetworkUsage = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve())
const saveUsenetServer = vi.fn((server: UsenetServer) => Promise.resolve(server))
let usenetServer = vi.fn(() => Promise.resolve<UsenetServer | null>(null))
let usage: Record<string, number> = {}
const onOpenChange = vi.fn()

function Harness({
  start = null,
  showSchedule = false
}: {
  start?: string | null
  showSchedule?: boolean
}): React.JSX.Element {
  const [page, setPage] = useState<string | null>(start)
  return (
    <LimitsDialog
      open
      showSchedule={showSchedule}
      onOpenChange={onOpenChange}
      page={page}
      onPageChange={setPage}
    />
  )
}

const show = (start: string | null = null, showSchedule = false): void => {
  render(<Harness start={start} showSchedule={showSchedule} />)
}
const nav = (name: RegExp): HTMLElement => screen.getByRole('button', { name })
const limit = (label: string): HTMLElement => screen.getByRole('radiogroup', { name: label })
const save = (): HTMLElement => screen.getByRole('button', { name: 'Save' })

beforeEach(() => {
  usage = {}
  usenetServer = vi.fn(() => Promise.resolve<UsenetServer | null>(null))
  window.mergelane = {
    ...window.mergelane,
    updateSettings,
    resetNetworkUsage,
    saveUsenetServer,
    usenetServer: () => usenetServer(),
    networkUsage: () => Promise.resolve(usage)
  } as unknown as typeof window.mergelane
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  useAppStore.setState({
    interfaces: [iface('en0', 'Wi-Fi', 'wifi'), iface('en7', 'iPhone', 'usb')],
    networkPreferences: {}
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('All downloads', () => {
  it('sets a total upload limit beside the download one, and saves only what changed', async () => {
    const user = userEvent.setup()
    show()
    expect(nav(/All downloads/).textContent).toContain('No limit')
    const uploads = limit('Total upload speed')
    await user.click(within(uploads).getByRole('radio', { name: 'Limit to' }))
    const field = within(uploads).getByRole('textbox', { name: 'Total upload speed, in MB/s' })
    expect((field as HTMLInputElement).value).toBe('2')
    await user.clear(field)
    await user.type(field, '3')
    expect(nav(/All downloads/).textContent).toContain('Upload limit 3 MB/s')
    // Not a number: kept as typed, the limit as it was.
    await user.type(field, 'x')
    expect(nav(/All downloads/).textContent).toContain('Upload limit 3 MB/s')

    await user.click(save())
    expect(updateSettings).toHaveBeenCalledWith({ uploadLimit: 3 * MB })
    expect(useAppStore.getState().uploadLimit).toBe(3 * MB)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('no limit keeps the number for when a limit is chosen again', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ uploadLimit: 5 * MB, speedLimit: 8 * MB })
    show()
    const uploads = limit('Total upload speed')
    await user.click(within(uploads).getByRole('radio', { name: 'No limit' }))
    expect(within(uploads).getByRole('textbox')).toHaveProperty('disabled', true)
    await user.click(within(uploads).getByRole('radio', { name: 'Limit to' }))
    expect((within(uploads).getByRole('textbox') as HTMLInputElement).value).toBe('5')
    expect(nav(/All downloads/).textContent).toContain('Limit 8 MB/s')
  })

  it('slow mode, downloads at once and the schedule join the same save', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ downloadsAtOnce: 2 })
    show()
    await user.click(screen.getByRole('switch'))
    expect(nav(/All downloads/).textContent).toContain('Slow mode on')
    await user.clear(screen.getByRole('textbox', { name: 'Slow mode speed, in MB/s' }))
    await user.type(screen.getByRole('textbox', { name: 'Slow mode speed, in MB/s' }), '1')
    await user.click(screen.getByRole('button', { name: 'Increase simultaneous downloads' }))
    await user.click(screen.getByRole('button', { name: 'Increase simultaneous downloads' }))
    await user.click(screen.getByRole('button', { name: 'Decrease simultaneous downloads' }))
    expect(screen.getByRole('status', { name: 'Downloads at once' }).textContent).toBe('3')
    await user.click(screen.getByRole('button', { name: 'Enable download schedule' }))
    // In the Mac's own time format, as the dialog writes it.
    const { startMinute, endMinute } = DEFAULT_DOWNLOAD_SCHEDULE
    expect(nav(/All downloads/).textContent).toContain(
      `${scheduleTime(startMinute)}–${scheduleTime(endMinute)}`
    )
    await user.click(save())
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ slowMode: true, slowModeSpeed: MB, downloadsAtOnce: 3 })
    )
  })

  it('resets every general setting, the upload limit included, once confirmed', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ uploadLimit: 5 * MB })
    show()
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm.textContent).toContain('total speed, total upload speed, slow mode')
    await user.click(within(confirm).getByRole('button', { name: 'Reset to defaults' }))
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toHaveProperty(
      'disabled',
      true
    )
    await user.click(save())
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ uploadLimit: undefined }))
  })

  it('a schedule that can’t run blocks Save; a failed save keeps the dialog open', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Break schedule' }))
    expect(screen.getByText('Check schedule times, repeat days and end date.')).toBeTruthy()
    expect(save()).toHaveProperty('disabled', true)

    cleanup()
    updateSettings.mockRejectedValueOnce(new Error('Disk full'))
    show()
    await user.click(save())
    expect(await screen.findByText(/Disk full/)).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opened for the schedule, it goes straight to it', async () => {
    show(null, true)
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Enable download schedule')
    )
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

describe('A network', () => {
  it('sets its upload limit beside its download limit, and says so in the list', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ networkPreferences: { en0: { speedLimit: 4 * MB } } })
    show()
    await user.click(nav(/Wi-Fi/))
    expect(screen.getByText('Limits the combined speed torrents upload at on Wi-Fi.')).toBeTruthy()
    const uploads = limit('Wi-Fi upload speed')
    await user.click(within(uploads).getByRole('radio', { name: 'Limit to' }))
    expect((within(uploads).getByRole('textbox') as HTMLInputElement).value).toBe('1')
    expect(nav(/Wi-Fi/).textContent).toContain('Limit 4 MB/s')
    expect(nav(/Wi-Fi/).textContent).toContain('Upload limit 1 MB/s')
    await user.click(save())
    expect(updateSettings).toHaveBeenCalledWith({
      networkPreferences: { en0: { speedLimit: 4 * MB, uploadLimit: MB } }
    })
  })

  it('removes its speed, upload and data limits together, once confirmed', async () => {
    const user = userEvent.setup()
    useAppStore.setState({ networkPreferences: { en0: { uploadLimit: MB } } })
    show('en0')
    await user.click(screen.getByRole('button', { name: 'Remove limits' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm.textContent).toContain('Wi-Fi’s speed, upload speed and data limits')
    await user.click(within(confirm).getByRole('button', { name: 'Remove limits' }))
    expect(screen.getByRole('button', { name: 'Remove limits' })).toHaveProperty('disabled', true)
    expect(nav(/Wi-Fi/).textContent).toContain('No limit')
  })

  it('a data limit: its period, how much is used, and resetting the usage', async () => {
    const user = userEvent.setup()
    usage = { en7: 3 * GB }
    useAppStore.setState({ networkPreferences: { en7: { dataLimit: 2 * GB } } })
    show('en7')
    await waitFor(() => expect(nav(/iPhone/).textContent).toContain('Data limit reached'))
    expect(screen.getByText(/3\.0 GB of 2\.0 GB this month/)).toBeTruthy()
    expect(screen.getByText(/Resets on/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Week' }))
    expect(screen.getByText(/Weeks start Monday\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.getByText(/Resets tomorrow at midnight/)).toBeTruthy()

    // A reset that fails says why; one that works closes its window.
    resetNetworkUsage.mockRejectedValueOnce(new Error('Can’t write'))
    await user.click(screen.getByRole('button', { name: 'Reset data usage' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm.textContent).toContain('Reset data usage for iPhone?')
    await user.click(within(confirm).getByRole('button', { name: 'Reset data usage' }))
    expect((await within(confirm).findByRole('alert')).textContent).toContain('Can’t write')
    await user.click(within(confirm).getByRole('button', { name: 'Reset data usage' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(resetNetworkUsage).toHaveBeenLastCalledWith('en7')
  })

  it('a data limit under its use lists how much is left, in the list', async () => {
    usage = { en7: GB }
    useAppStore.setState({ networkPreferences: { en7: { dataLimit: 2 * GB } } })
    show()
    await waitFor(() => expect(nav(/iPhone/).textContent).toContain('1.0 of 2 GB'))
  })
})

describe('Usenet', () => {
  it('with no news server, says so and offers to set one up', async () => {
    const user = userEvent.setup()
    show('usenet')
    expect(await screen.findByText('No news server set up')).toBeTruthy()
    expect(nav(/Usenet/).textContent).toContain('No server')
    expect(
      screen.getByRole('switch', { name: /Usenet downloads/ }).getAttribute('aria-disabled')
    ).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Set up server' }))
    expect(screen.getByText('News server window')).toBeTruthy()
  })

  it('switching Usenet off is saved with the server, after the rest', async () => {
    const user = userEvent.setup()
    usenetServer = vi.fn(() => Promise.resolve<UsenetServer | null>(SERVER))
    show('usenet')
    expect(await screen.findByText('news.example.org:563')).toBeTruthy()
    expect(nav(/Usenet/).textContent).toContain('On')
    await user.click(screen.getByRole('switch', { name: /Usenet downloads/ }))
    expect(nav(/Usenet/).textContent).toContain('Off')
    await user.click(save())
    await waitFor(() =>
      expect(saveUsenetServer).toHaveBeenCalledWith({ ...SERVER, enabled: false })
    )
    expect(updateSettings).toHaveBeenCalledWith({})
  })

  it('a news server that can’t be read counts as none', async () => {
    usenetServer = vi.fn(() => Promise.reject(new Error('gone')))
    show('usenet')
    expect(await screen.findByText('No news server set up')).toBeTruthy()
  })
})
