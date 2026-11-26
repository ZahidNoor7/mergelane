import type { DuplicateMatch } from '@shared/duplicates'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { DuplicateNotice } from './DuplicateNotice'

const MB = 1024 * 1024
const initial = useAppStore.getState()
const revealHistoryEntry = vi.fn(() => Promise.resolve(true))

beforeEach(() => {
  window.mergelane = { ...window.mergelane, revealHistoryEntry } as typeof window.mergelane
  useAppStore.setState({ homeDir: '/Users/test', newDownloadOpen: true })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

const finished = (fields: Partial<DuplicateMatch> = {}): DuplicateMatch => ({
  id: 'had',
  how: 'link',
  live: false,
  name: 'LibreOffice.dmg',
  host: 'mirror.example.net',
  size: 300 * MB,
  completedAt: Date.now() - 5 * 60_000,
  path: '/Users/test/Downloads/LibreOffice.dmg',
  ...fields
})

describe('the duplicate notice', () => {
  it('says the file is had, where and when, by the same link, and shows it in Finder', async () => {
    render(<DuplicateNotice match={finished()} />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('You already have this file')
    expect(notice.textContent).toContain(
      'Downloaded 5 min ago to ~/Downloads, 300.0 MB. Same link.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
    expect(revealHistoryEntry).toHaveBeenCalledWith('had')
  })

  it('names the other site for the same file there, its SHA-256 matching', () => {
    render(
      <DuplicateNotice match={finished({ how: 'file', completedAt: undefined, path: undefined })} />
    )
    expect(screen.getByRole('status').textContent).toContain(
      'Downloaded, 300.0 MB. Same file from mirror.example.net: the name and size match, and so does the SHA-256 this site publishes.'
    )
  })

  it('one still downloading: how far, and to the list', async () => {
    render(<DuplicateNotice match={finished({ live: true, percent: 42, path: undefined })} />)
    expect(screen.getByRole('status').textContent).toContain('This is already downloading')
    expect(screen.getByRole('status').textContent).toContain(
      'It’s in your list, 42% done. Same link.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Show in list' }))
    expect(useAppStore.getState()).toMatchObject({
      newDownloadOpen: false,
      screen: 'downloads',
      selectedId: 'had'
    })
  })

  it('a live one with no progress yet says 0%', () => {
    render(<DuplicateNotice match={finished({ live: true })} />)
    expect(screen.getByRole('status').textContent).toContain('It’s in your list, 0% done.')
  })
})
