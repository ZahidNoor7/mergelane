import type { DownloadState } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  describeSegments,
  dirnameOf,
  fileExtensionBadge,
  fileNameFromPath,
  formatDuration,
  formatEta,
  formatSpeedLimit,
  formatSpeedOfLimit,
  linkExpired,
  pathInTorrent,
  sourceOf,
  toDisplayPath
} from './format'

// format.ts joined Vitest's covered list with expired-link recovery (ADR-0078), which changed
// linkExpired; these cover what its other tests (through the components) didn't reach.

describe('a speed against its limit', () => {
  it('shows a dash while nothing moves', () => {
    expect(formatSpeedOfLimit(0, 2_000_000, 'bytes')).toEqual([
      '—',
      formatSpeedLimit(2_000_000, 'bytes')
    ])
  })

  it('says the unit once, the limit’s', () => {
    const [speed, max] = formatSpeedOfLimit(1_500_000, 2_000_000, 'bytes')
    expect(max).toBe(formatSpeedLimit(2_000_000, 'bytes'))
    expect(speed).toBe('1.5')
  })
})

describe('times', () => {
  it('counts down in seconds, minutes, then hours', () => {
    expect(formatEta(0)).toBe('—')
    expect(formatEta(Number.NaN)).toBe('—')
    expect(formatEta(0.2)).toBe('1s')
    expect(formatEta(59.5)).toBe('1m 0s')
    expect(formatEta(125)).toBe('2m 5s')
    expect(formatEta(2 * 3600 + 7 * 60)).toBe('2h 7m')
  })

  it('reads durations as m:ss, or h:mm:ss past an hour', () => {
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3600 + 2 * 60 + 3)).toBe('1:02:03')
  })
})

describe('names and paths', () => {
  it('takes a torrent file’s path inside its folder, and a file’s name', () => {
    expect(pathInTorrent('Album/disc 1/a.flac')).toBe('disc 1/a.flac')
    expect(pathInTorrent('single.iso')).toBe('single.iso')
    expect(fileNameFromPath('/Users/test/Downloads/a.iso')).toBe('a.iso')
    expect(fileNameFromPath('C:\\Users\\test\\a.iso')).toBe('a.iso')
  })

  it('badges a file by its extension, or as a file when it has none', () => {
    expect(fileExtensionBadge('Xcode_16.2.xip')).toBe('XIP')
    expect(fileExtensionBadge('photo.jpeg')).toBe('JPEG')
    expect(fileExtensionBadge('archive.tar.zstd')).toBe('ZSTD')
    expect(fileExtensionBadge('README')).toBe('FILE')
    expect(fileExtensionBadge('.hidden')).toBe('FILE')
    expect(fileExtensionBadge('trailing.')).toBe('FILE')
  })

  it('names a link’s host, or gives back what isn’t a link', () => {
    expect(sourceOf('https://files.example.com:8443/a.iso')).toBe('files.example.com:8443')
    expect(sourceOf('not a link')).toBe('not a link')
  })

  it('finds a path’s folder, on macOS and Windows', () => {
    expect(dirnameOf('/Users/test/a.iso')).toBe('/Users/test')
    expect(dirnameOf('/a.iso')).toBe('/')
    expect(dirnameOf('C:\\a.iso')).toBe('C:\\')
    expect(dirnameOf('C:\\Users\\a.iso')).toBe('C:\\Users')
    expect(dirnameOf('a.iso')).toBe('.')
  })

  it('shortens a path under home to ~, and leaves the rest alone', () => {
    expect(toDisplayPath('/Users/test/Downloads', '/Users/test')).toBe('~/Downloads')
    expect(toDisplayPath('/Users/test', '/Users/test/')).toBe('~')
    expect(toDisplayPath('/Volumes/Disk/a', '/Users/test')).toBe('/Volumes/Disk/a')
    expect(toDisplayPath('/Users/tester/a', '/Users/test')).toBe('/Users/tester/a')
    expect(toDisplayPath('/Users/test/a', '')).toBe('/Users/test/a')
    // Windows paths are told apart without regard to case, and keep their own separators.
    expect(toDisplayPath('c:\\users\\test\\Downloads', 'C:\\Users\\test')).toBe('~\\Downloads')
  })
})

describe('a stream’s progress', () => {
  it('counts the segments in', () => {
    expect(describeSegments([{ status: 'completed' }, { status: 'pending' }])).toBe(
      '1 of 2 segments'
    )
    expect(describeSegments([{ status: 'completed' }])).toBe('1 of 1 segment')
  })
})

describe('a link that stopped working', () => {
  const failed = (fields: Record<string, unknown>): DownloadState =>
    ({ kind: 'http', status: 'error', ...fields }) as unknown as DownloadState

  it('is one the main process saw stop, or whose error says it was refused', () => {
    expect(linkExpired(failed({ problem: { kind: 'link-expired', at: 1 } }))).toBe(true)
    expect(linkExpired(failed({ error: 'Unexpected status 403 for range request' }))).toBe(true)
    expect(linkExpired(failed({ error: 'Not enough disk space' }))).toBe(false)
  })

  it('only for a failed web download', () => {
    const problem = { kind: 'link-expired', at: 1 }
    expect(linkExpired(failed({ status: 'paused', problem }))).toBe(false)
    expect(linkExpired(failed({ kind: 'stream', problem }))).toBe(false)
  })
})
