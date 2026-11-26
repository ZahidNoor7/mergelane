import type { DownloadState } from '@shared/types'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store/useAppStore'
import { FreshLinkPanel, RELINKED_NOTE_MS, RelinkedNote } from './FreshLink'

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 26, 12).getTime()

function expired(fields: Record<string, unknown> = {}): DownloadState {
  return {
    id: 'e',
    kind: 'http',
    url: 'https://cdn.example.com/s/ab/film.mkv?Expires=1&Signature=x',
    fileName: 'film.mkv',
    destinationPath: '/Users/test/Downloads/film.mkv',
    totalBytes: 100 * MB,
    bytesDownloaded: 37 * MB,
    speedBytesPerSec: 0,
    status: 'error',
    error: 'The link stopped working. Paste a fresh one to carry on.',
    problem: { kind: 'link-expired', at: NOW },
    startedAt: NOW - 60_000,
    networks: [],
    streams: [],
    blocks: [],
    peakStreams: 0,
    totalBlocks: 100,
    blockSizeBytes: MB,
    ...fields
  } as unknown as DownloadState
}

const initial = useAppStore.getState()
const relinkDownload = vi.fn<(id: string, url: string) => Promise<void>>(() => Promise.resolve())

beforeEach(() => {
  window.mergelane = { ...window.mergelane, relinkDownload } as typeof window.mergelane
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.useRealTimers()
})

const field = (): HTMLElement => screen.getByRole('textbox', { name: 'Fresh link' })

describe('the fresh link panel', () => {
  it('says where it stopped and that a fresh signed link carries it on', () => {
    render(<FreshLinkPanel download={expired()} />)
    const panel = screen.getByRole('form', { name: 'The link expired at 37%' })
    expect(panel.textContent).toContain(
      'Links from cdn.example.com are signed and stop working after a while.'
    )
    expect(panel.textContent).toContain('Mergelane carries on from 37.0 MB.')
    expect(panel.textContent).toContain('It checks the size and the file itself first')
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
  })

  it('says so plainly for a link that isn’t signed', () => {
    render(<FreshLinkPanel download={expired({ url: 'https://files.example.org/film.mkv' })} />)
    expect(screen.getByRole('form').textContent).toContain(
      'The link from files.example.org stopped working.'
    )
  })

  it('refuses what isn’t a link, without asking the main process', async () => {
    render(<FreshLinkPanel download={expired()} />)
    await userEvent.type(field(), 'not a link')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'That isn’t a link. Paste an address that starts with https://'
    )
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(relinkDownload).not.toHaveBeenCalled()
    // Typing again clears it.
    await userEvent.type(field(), 'x')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hands a link over to be checked, and says what the main process found', async () => {
    let fail: (error: Error) => void = () => {}
    relinkDownload.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject))
    )
    render(<FreshLinkPanel download={expired()} />)
    await userEvent.type(field(), '  https://cdn.example.com/s/cd/other.mkv?sig=2  ')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(relinkDownload).toHaveBeenCalledWith('e', 'https://cdn.example.com/s/cd/other.mkv?sig=2')
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
    await act(async () =>
      fail(
        new Error(
          "Error invoking remote method 'download:relink': Error: That link is for other.mkv, not this download. Add it as a new download instead."
        )
      )
    )
    expect(screen.getByRole('alert').textContent).toBe(
      'That link is for other.mkv, not this download. Add it as a new download instead.'
    )
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('takes a fresh link quietly: the download carries on and the panel goes', async () => {
    render(<FreshLinkPanel download={expired()} />)
    await userEvent.type(field(), 'https://cdn.example.com/s/ef/film.mkv?sig=3{Enter}')
    expect(relinkDownload).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers the download page, and the browser’s own way when it is on', () => {
    render(
      <FreshLinkPanel
        download={expired({ pageUrl: 'https://cdn.example.com/files', fromBrowser: 'Chrome' })}
      />
    )
    const page = screen.getByRole('link', { name: 'Open the download page' })
    expect(page.getAttribute('href')).toBe('https://cdn.example.com/files')
    expect(page.getAttribute('target')).toBe('_blank')
    expect(screen.getByText(/Click the download again there/)).toBeTruthy()
  })

  it('names the browser when there is no page, and says nothing of it when turned off', () => {
    const { unmount } = render(<FreshLinkPanel download={expired({ fromBrowser: 'Chrome' })} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/Click the download again in Chrome/)).toBeTruthy()
    unmount()
    useAppStore.setState({ catchFreshLinks: false })
    render(<FreshLinkPanel download={expired({ fromBrowser: 'Chrome' })} />)
    expect(screen.queryByText(/Click the download again/)).toBeNull()
  })
})

describe('after a fresh link took over', () => {
  it('says it was the same file and where it carried on, for a while', async () => {
    vi.useFakeTimers({ now: NOW })
    const relinked = expired({
      status: 'downloading',
      relinked: { at: NOW, fromBytes: 37 * MB }
    })
    render(<RelinkedNote download={relinked} />)
    expect(screen.getByRole('status').textContent).toBe(
      'Same file: the size and the bytes already downloaded match. Continuing from 37%.'
    )
    await act(async () => {
      vi.advanceTimersByTime(RELINKED_NOTE_MS + 10)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says nothing for one that was never relinked, or long ago', () => {
    vi.useFakeTimers({ now: NOW })
    const { unmount } = render(<RelinkedNote download={expired({ status: 'downloading' })} />)
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    render(
      <RelinkedNote
        download={expired({ relinked: { at: NOW - RELINKED_NOTE_MS - 1, fromBytes: MB } })}
      />
    )
    expect(screen.queryByRole('status')).toBeNull()
  })
})
