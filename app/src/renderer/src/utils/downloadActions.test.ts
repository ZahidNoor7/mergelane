import type { DownloadState, FinishedDownload } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  availableActions,
  failureAction,
  headerActions,
  isPlanned,
  manageAction,
  manageActions,
  rowAction,
  splitToolbar,
  type DownloadItem
} from './downloadActions'

function download(fields: Partial<DownloadState> & Record<string, unknown>): DownloadState {
  return {
    id: 'x',
    kind: 'http',
    url: 'https://files.example.com/x.zip',
    fileName: 'x.zip',
    status: 'downloading',
    bytesDownloaded: 0,
    ...fields
  } as unknown as DownloadState
}

const finished = (fields: Record<string, unknown> = {}): FinishedDownload =>
  ({
    id: 'f',
    kind: 'http',
    url: 'https://files.example.com/f.zip',
    status: 'completed',
    unitsWritten: 1,
    ...fields
  }) as unknown as FinishedDownload

const ids = (items: DownloadItem[]): string[][] =>
  availableActions(items).map((group) => group.map(({ id }) => id))

describe('a download added to the queue or for later (ADR-0044)', () => {
  const held = download({ status: 'queued', held: true })
  const timed = download({ status: 'queued', startAt: 1 })
  const waiting = download({ status: 'queued' })

  it('is planned; one only waiting for room isn’t', () => {
    expect(isPlanned(held)).toBe(true)
    expect(isPlanned(timed)).toBe(true)
    expect(isPlanned(waiting)).toBe(false)
    expect(isPlanned(download({ status: 'paused', held: true }))).toBe(false)
    expect(isPlanned(finished())).toBe(false)
  })

  it('offers Start now first, on its row, its screen and the toolbar', () => {
    expect(rowAction(held)).toBe('start')
    expect(rowAction(waiting)).toBe('pause')
    expect(headerActions(timed)).toEqual(['start', 'pause', 'reveal'])
    expect(ids([timed])[0]).toEqual(['start', 'pause', 'reveal'])
    expect(splitToolbar(availableActions([held])).buttons.map(({ id }) => id)).toEqual([
      'start',
      'pause'
    ])
  })

  it('with others selected, starts only the planned ones', () => {
    const [first] = availableActions([held, waiting])
    expect(first.find(({ id }) => id === 'start')?.targets).toEqual([held])
    expect(first.find(({ id }) => id === 'pause')?.targets).toEqual([held, waiting])
  })
})

describe('what else each download offers', () => {
  it('a running one pauses or cancels; a paused one resumes', () => {
    expect(rowAction(download({}))).toBe('pause')
    expect(rowAction(download({ status: 'paused' }))).toBe('resume')
    expect(manageAction(download({}))).toBe('cancel')
    expect(manageActions(download({ status: 'paused' }))).toEqual(['cancel'])
  })

  it('a failed one is retried, fixed or started again', () => {
    const expired = download({ status: 'error', error: 'HTTP 403 Forbidden' })
    expect(failureAction(download({ status: 'error', bytesDownloaded: 5 }))).toBe('retry')
    expect(failureAction(download({ status: 'error', resumable: false, bytesDownloaded: 5 }))).toBe(
      'again'
    )
    expect(rowAction(download({ status: 'error' }))).toBe('again')
    expect(['fix', 'again']).toContain(failureAction(expired))
    expect(manageAction(download({ status: 'error' }))).toBe('remove')
  })

  it('a finished one opens, shows, goes from the list or to the Trash', () => {
    expect(headerActions(finished())).toEqual(['open', 'reveal'])
    expect(manageActions(finished())).toEqual(['remove', 'trash'])
    // Its file gone: nothing to open, show or trash.
    expect(headerActions(finished({ missing: true }))).toEqual([])
    expect(manageActions(finished({ missing: true }))).toEqual(['remove'])
    // A torrent's folder whose files were never listed can't be trashed by name.
    expect(manageActions(finished({ kind: 'torrent', folder: true }))).toEqual(['remove'])
    expect(manageActions(download({ status: 'cancelled' }))).toEqual([])
    expect(rowAction(finished())).toBeNull()
  })

  it('offers single-download actions only for one, and trackers for a torrent', () => {
    const torrent = download({ kind: 'torrent', url: 'magnet:?xt=urn:btih:abc' })
    expect(ids([torrent])[0]).toContain('trackers')
    expect(ids([finished(), finished({ id: 'g' })]).flat()).toEqual(['copy', 'remove', 'trash'])
    expect(ids([download({ url: 'file:///x.torrent' })]).flat()).not.toContain('copy')
  })

  it('splits the toolbar into its two buttons and the rest', () => {
    const { buttons, more } = splitToolbar(availableActions([download({})]))
    expect(buttons.map(({ id }) => id)).toEqual(['pause', 'cancel'])
    expect(more.map((group) => group.map(({ id }) => id))).toEqual([['reveal'], ['copy']])
  })
})
