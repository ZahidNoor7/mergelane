import { BROWSERS, type BrowsersReport } from '@shared/browsers'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSettings } from './ExtensionSettings'

const NOW = new Date(2026, 10, 11, 15, 0).getTime()

function report(found: string[], fields: Partial<BrowsersReport> = {}): BrowsersReport {
  return {
    browsers: BROWSERS.map((spec) => ({
      ...spec,
      found: found.includes(spec.id),
      extensionFolder:
        found.includes(spec.id) && spec.kind
          ? `/Users/test/Mergelane/Browser Extension/${spec.kind}`
          : null
    })),
    extensionConnected: false,
    scannedAt: NOW,
    ...fields
  }
}

let answer: BrowsersReport
const browsers = vi.fn(() => Promise.resolve(answer))
const revealExtension = vi.fn(() => Promise.resolve())
const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  answer = report(['chrome', 'firefox', 'brave', 'safari'])
  window.mergelane = {
    ...window.mergelane,
    browsers,
    revealExtension
  } as unknown as typeof window.mergelane
})
afterEach(() => {
  cleanup()
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

  it('guides a Chrome-family install: the folder in the Finder, the page to open, the steps', async () => {
    const user = setupUser()
    await show()
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    expect(within(dialog).getByText(/takes it from a folder on your Mac/)).toBeTruthy()
    expect(
      within(within(dialog).getByRole('list', { name: 'Steps' }))
        .getAllByRole('listitem')
        .map((step) => step.querySelector('span')!.textContent)
    ).toEqual([
      'Show the extension folder in the Finder.',
      'In Chrome, go to chrome://extensions.',
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ])
    await user.click(within(dialog).getByRole('button', { name: 'Show in Finder' }))
    expect(revealExtension).toHaveBeenCalledWith('chrome')
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('chrome://extensions')
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeTruthy()
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says Firefox keeps it only until it quits', async () => {
    const user = setupUser()
    await show()
    await user.click(screen.getAllByRole('button', { name: 'Install…' })[1])
    expect(
      screen.getByText(/only keeps an extension that Mozilla hasn’t signed until it quits/)
    ).toBeTruthy()
    // A refused clipboard leaves the button as it was.
    writeText.mockImplementationOnce(() => Promise.reject(new Error('no')))
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
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
