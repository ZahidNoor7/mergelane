import { describeStartAt } from '@shared/startAt'
import type { DownloadState } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { activeDetail } from './dashboard'
import { formatEta } from './format'

// The Dashboard's line under each unfinished download (ActiveDownloadRow). The rest of this file
// is tested without a window in e2e/dashboardModel.spec.ts.

const MB = 1024 * 1024
const NOW = new Date(2026, 10, 11, 15).getTime()

function download(fields: Partial<DownloadState> & Record<string, unknown>): DownloadState {
  return {
    id: 'x',
    kind: 'http',
    url: 'https://files.example.com/x.zip',
    fileName: 'x.zip',
    status: 'downloading',
    bytesDownloaded: 4 * MB,
    totalBytes: 10 * MB,
    networks: [],
    ...fields
  } as unknown as DownloadState
}

describe('activeDetail', () => {
  it('a running download: its share, sizes and time left', () => {
    expect(activeDetail(download({ timeLeftSeconds: 90 }), NOW)).toBe(
      `40% · 4.0 MB of 10.0 MB · ${formatEta(90)} left`
    )
    // Size unknown: only what has come in.
    expect(activeDetail(download({ totalBytes: 0 }), NOW)).toBe('4.0 MB')
  })

  it('one whose start time passed while Mergelane was closed says it started late', () => {
    expect(activeDetail(download({ missedStartAt: NOW - 60_000 }), NOW)).toBe(
      '40% · 4.0 MB of 10.0 MB · Started late'
    )
  })

  it('a paused download, with and without a known size', () => {
    expect(activeDetail(download({ status: 'paused' }), NOW)).toBe(
      'Paused at 40% · 4.0 MB of 10.0 MB'
    )
    expect(activeDetail(download({ status: 'paused', totalBytes: 0 }), NOW)).toBe('Paused · 4.0 MB')
  })

  it('one with a start time says when it starts, as its row and details do (ADR-0044)', () => {
    const later = new Date(2026, 10, 11, 23, 30).getTime()
    const tomorrow = new Date(2026, 10, 12, 1).getTime()
    const timed = download({ status: 'queued', bytesDownloaded: 0, startAt: later })
    expect(activeDetail(timed, NOW)).toBe(`${describeStartAt(later, NOW)} · 0 B of 10.0 MB`)
    expect(activeDetail(timed, NOW)).toMatch(/^Starts at /)
    expect(activeDetail({ ...timed, startAt: tomorrow }, NOW)).toMatch(/^Starts tomorrow at /)
    expect(activeDetail(timed, NOW)).not.toContain('Waiting for a turn')
  })

  it('the rest of the queue, added to it or waiting for room, waits for a turn', () => {
    expect(activeDetail(download({ status: 'queued', held: true }), NOW)).toBe(
      'Waiting for a turn · 4.0 MB of 10.0 MB'
    )
    expect(
      activeDetail(download({ status: 'queued', bytesDownloaded: 0, totalBytes: 0 }), NOW)
    ).toBe('Waiting for a turn · 0 B')
  })
})
