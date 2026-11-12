import {
  BROWSERS,
  EXTENSION_FOLDER_NAME,
  type BrowsersReport,
  type ExtensionSaved
} from '@shared/browsers'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { ExtensionSettings } from './ExtensionSettings'

const NOW = new Date(2026, 10, 11, 15, 0).getTime()

function report(found: string[], fields: Partial<BrowsersReport> = {}): BrowsersReport {
  return {
    browsers: BROWSERS.map((spec) => ({
      ...spec,
      found: found.includes(spec.id),
      appPath: found.includes(spec.id) ? `/Applications/${spec.app}` : null,
      extensionFolder: spec.kind
        ? `/Users/test/Downloads/${EXTENSION_FOLDER_NAME[spec.kind]}`
        : null,
      contact: null
    })),
    extensionConnected: false,
    extensionVersion: '1.0.0',
    scannedAt: NOW,
    extensionLocation: '/Users/test/Downloads',
    ...fields
  }
}

let answer: BrowsersReport
const browsers = vi.fn(() => Promise.resolve(answer))
/** Where saving puts the extension: the location's folder for its kind. */
let location = '/Users/test/Downloads'
const saved = (id: string): ExtensionSaved => ({
  ok: true,
  folder: `${location}/${id === 'firefox' ? EXTENSION_FOLDER_NAME.firefox : EXTENSION_FOLDER_NAME.chrome}`
})
const saveExtension = vi.fn((id: string) => Promise.resolve(saved(id)))
const revealExtension = vi.fn((id: string) => Promise.resolve(saved(id)))
const chooseExtensionLocation = vi.fn((): Promise<string | null> => Promise.resolve(null))
const openBrowser = vi.fn(() => Promise.resolve())
const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  answer = report(['chrome', 'firefox', 'brave', 'safari'])
  location = '/Users/test/Downloads'
  useAppStore.setState({ homeDir: '/Users/test' })
  window.mergelane = {
    ...window.mergelane,
    browsers,
    saveExtension,
    revealExtension,
    chooseExtensionLocation,
    openBrowser,
    updateSettings
  } as unknown as typeof window.mergelane
})
const initial = useAppStore.getState()
const updateSettings = vi.fn(() => Promise.resolve())
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function show(): Promise<void> {
  render(<ExtensionSettings />)
  await act(async () => {})
}
/** user-event puts in its own clipboard when set up, so the test's goes in after it. */
function setupUser(): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup({ advanceTimers: () => {} })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return user
}

const rows = (name: string): string[] =>
  within(screen.getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((row) => row.textContent ?? '')

describe('Settings › Browser extensions', () => {
  it('lists the supported browsers on this Mac, and the rest with why', async () => {
    await show()
    expect(rows('Browsers on this Mac')).toEqual([
      'Google ChromeLoad the extension once, by hand.Install…',
      'FirefoxLoad the extension as a temporary add-on, after each Firefox restart.Install…'
    ])
    expect(rows('Other browsers')).toEqual([
      'Microsoft EdgeNot on this Mac. Install it, then scan again.',
      'ChromiumNot on this Mac. Install it, then scan again.',
      'BraveNot supported yet: Brave doesn’t document where it looks for Mergelane’s helper.',
      'VivaldiNot supported yet: Vivaldi doesn’t document where it looks for Mergelane’s helper.',
      'SafariComing in a later version: Safari needs its own kind of extension.'
    ])
    expect(screen.getByRole('status').textContent).toBe(
      'Scanned just now. No browser’s extension has reached Mergelane yet.'
    )
  })

  it('says where the extension is saved, and changes it', async () => {
    const user = setupUser()
    await show()
    const row = screen.getByText('Save the extension in').parentElement!.parentElement!
    expect(row.textContent).toContain('~/Downloads')
    expect(row.textContent).toContain('so leave it in place')
    // Cancelled: nothing changes.
    await user.click(within(row).getByRole('button', { name: 'Change…' }))
    expect(chooseExtensionLocation).toHaveBeenCalledOnce()
    expect(browsers).toHaveBeenCalledOnce()
    // Chosen: the browsers are looked at again, and say the new place.
    chooseExtensionLocation.mockImplementationOnce(() => Promise.resolve('/Users/test/Desktop'))
    answer = { ...report(['chrome', 'firefox']), extensionLocation: '/Users/test/Desktop' }
    await user.click(within(row).getByRole('button', { name: 'Change…' }))
    expect(browsers).toHaveBeenCalledTimes(2)
    expect(screen.getByText('~/Desktop')).toBeTruthy()
    expect(saveExtension).not.toHaveBeenCalled()
  })

  it('saves the extension on Install, then guides loading it in a Chrome-family browser', async () => {
    const user = setupUser()
    await show()
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[0])
    expect(saveExtension).toHaveBeenCalledWith('chrome')
    const dialog = screen.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    expect(within(dialog).getByText(/takes it from a folder on your Mac/)).toBeTruthy()
    expect(
      within(within(dialog).getByRole('list', { name: 'Steps' }))
        .getAllByRole('listitem')
        .map((step) => step.querySelector('span')!.textContent)
    ).toEqual([
      'Mergelane saved the extension in this folder. Keep it there: Chrome loads it from there.',
      'Open Chrome and go to chrome://extensions.',
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ])
    expect(within(dialog).getByText('~/Downloads/Mergelane Extension')).toBeTruthy()
    // Copying the path sits with the step that needs it, after the page's address is pasted.
    const steps = within(dialog).getAllByRole('listitem')
    expect(within(steps[3]).getByText(/press ⌘⇧G, paste the path and press Return/)).toBeTruthy()
    expect(within(steps[3]).getByRole('button', { name: 'Copy path' })).toBeTruthy()
    expect(within(steps[0]).queryByRole('button', { name: 'Copy path' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Show in Finder' }))
    expect(revealExtension).toHaveBeenCalledWith('chrome')
    await user.click(within(dialog).getByRole('button', { name: 'Copy path' }))
    expect(writeText).toHaveBeenLastCalledWith('/Users/test/Downloads/Mergelane Extension')
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenLastCalledWith('chrome://extensions')
    // One "Copied" at a time: the last thing copied.
    expect(within(dialog).getByRole('button', { name: 'Copy path' })).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Open Chrome' }))
    expect(openBrowser).toHaveBeenCalledWith('chrome')
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says Firefox keeps it only until it quits, and copies the manifest’s path', async () => {
    const user = setupUser()
    await show()
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[1])
    expect(saveExtension).toHaveBeenCalledWith('firefox')
    expect(
      screen.getByText(/only keeps an extension that Mozilla hasn’t signed until it quits/)
    ).toBeTruthy()
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    await user.click(within(steps[2]).getByRole('button', { name: 'Copy path' }))
    expect(writeText).toHaveBeenLastCalledWith(
      '/Users/test/Downloads/Mergelane Extension for Firefox/manifest.json'
    )
    // A refused clipboard leaves the button as it was.
    writeText.mockImplementationOnce(() => Promise.reject(new Error('no')))
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('says why the extension couldn’t be saved, and saves it in another folder', async () => {
    const user = setupUser()
    await show()
    saveExtension.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        message: '“Downloads” already has a folder named “Mergelane Extension”.'
      })
    )
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    expect(within(dialog).getByRole('alert').textContent).toBe(
      '“Downloads” already has a folder named “Mergelane Extension”.'
    )
    expect(within(dialog).queryByRole('list', { name: 'Steps' })).toBeNull()
    // Choosing another folder saves it there and shows the steps.
    chooseExtensionLocation.mockImplementationOnce(() => {
      location = '/Users/test/Desktop'
      return Promise.resolve(location)
    })
    await user.click(within(dialog).getByRole('button', { name: 'Choose another folder…' }))
    expect(saveExtension).toHaveBeenCalledTimes(2)
    expect(screen.getByText('~/Desktop/Mergelane Extension')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Steps' })).toBeTruthy()
    // A save that fails outright says so too.
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    saveExtension.mockImplementationOnce(() => Promise.reject(new Error('Disk full')))
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[1])
    expect(screen.getByRole('alert').textContent).toBe('Disk full')
    saveExtension.mockImplementationOnce(() => Promise.reject('odd'))
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[1])
    expect(screen.getByRole('alert').textContent).toBe('odd')
  })

  it('scans again, and says when the extension has reached Mergelane', async () => {
    const user = setupUser()
    await show()
    answer = report(['edge'], { extensionConnected: true, scannedAt: NOW - 12 * 60_000 })
    await user.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(rows('Browsers on this Mac')).toEqual([
      'Microsoft EdgeLoad the extension once, by hand.Install…'
    ])
    expect(screen.getByRole('status').textContent).toBe(
      'Scanned 12 min ago. The extension has reached Mergelane.'
    )
  })

  it('while looking, with nothing supported found, or a copy without the extension', async () => {
    browsers.mockImplementationOnce(() => new Promise(() => {}))
    render(<ExtensionSettings />)
    expect(screen.getByRole('button', { name: 'Looking…' })).toBeTruthy()
    expect(screen.getAllByText('Looking in Applications…')).toHaveLength(2)
    cleanup()
    answer = report(['safari'])
    await show()
    expect(screen.getByText('No supported browser is on this Mac.')).toBeTruthy()
    cleanup()
    answer = report(['chrome'])
    answer.browsers[0].extensionFolder = null
    await show()
    expect(rows('Browsers on this Mac')).toEqual([
      'Google ChromeThe extension isn’t in this copy of Mergelane.'
    ])
    cleanup()
    browsers.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await show()
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeTruthy()
  })
})

describe('which browsers have connected', () => {
  it('says when each one last reached Mergelane, its extension, and when it’s out of date', async () => {
    answer = report(['chrome', 'edge', 'firefox'], { extensionConnected: true })
    answer.browsers[0].contact = { at: NOW - 5 * 60_000, extension: '1.0.0' }
    answer.browsers[1].contact = { at: NOW - 60 * 60_000, extension: '0.9.0' }
    answer.browsers[3].contact = { at: NOW - 2 * 60_000 }
    await show()
    const clock = new Date(NOW - 60 * 60_000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    })
    expect(rows('Browsers on this Mac')).toEqual([
      'Google ChromeReached Mergelane 5 min ago, extension 1.0.0.Install again…',
      `Microsoft EdgeReached Mergelane today ${clock}, extension 0.9.0. Restart Edge to use 1.0.0.Install again…`,
      'FirefoxReached Mergelane 2 min ago.Install again…'
    ])
  })
})

describe('what the extension does', () => {
  it('shows the rules and saves each change for every browser', async () => {
    const user = setupUser()
    await show()
    const group = screen.getByRole('region', { name: 'What the extension does' })
    const types = within(group).getByRole('group', { name: 'File types' })
    expect(
      within(types)
        .getAllByRole('button')
        .map((button) => `${button.textContent}:${button.getAttribute('aria-pressed')}`)
    ).toEqual([
      'Video:true',
      'Audio:false',
      'Archives:true',
      'Disk images:true',
      'Apps and installers:true',
      'Documents:false'
    ])
    await user.click(within(types).getByRole('button', { name: 'Documents' }))
    expect(updateSettings).toHaveBeenLastCalledWith({
      captureRules: expect.objectContaining({ types: ['video', 'archive', 'disk', 'app', 'doc'] })
    })
    await user.click(within(types).getByRole('button', { name: 'Video' }))
    expect(useAppStore.getState().captureRules.types).toEqual(['archive', 'disk', 'app', 'doc'])
    await user.click(within(group).getByRole('button', { name: '100 MB' }))
    expect(useAppStore.getState().captureRules.minSize).toBe('100mb')
    await user.click(within(group).getByRole('switch', { name: 'List the videos on a page' }))
    expect(useAppStore.getState().captureRules.videoButton).toBe(false)
    // Off: the rest waits, greyed out.
    await user.click(within(group).getByRole('switch', { name: 'Send downloads to Mergelane' }))
    expect(useAppStore.getState().captureRules.capture).toBe(false)
    expect(
      (within(types).getByRole('button', { name: 'Audio' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('Settings › Browser extensions on Windows', () => {
  afterEach(() => {
    window.mergelane.platform = 'darwin'
  })

  it('speaks of this PC and File Explorer, and how to reach the folder in the picker', async () => {
    window.mergelane.platform = 'win32'
    const user = setupUser()
    await show()
    expect(screen.getByRole('list', { name: 'Browsers on this PC' })).toBeTruthy()
    expect(rows('Other browsers')).toContain(
      'Microsoft EdgeNot on this PC. Install it, then scan again.'
    )
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    expect(within(dialog).getByText(/takes it from a folder on your PC/)).toBeTruthy()
    expect(
      within(dialog).getByText(/click its address bar, paste the path and press Enter/)
    ).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Show in File Explorer' }))
    expect(revealExtension).toHaveBeenCalledWith('chrome')
  })
})
