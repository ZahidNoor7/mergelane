import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  countsBy,
  grouped,
  hostOf,
  isHistoryKeep,
  keepSince,
  matches,
  plainLink,
  shows,
  type HistoryEntry
} from './history'

const NOW = new Date(2026, 10, 26, 15, 0).getTime()
const DAY = 86_400_000

const entry = (fields: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'x',
  kind: 'http',
  name: 'arch-2026.11.01-x86_64.iso',
  link: 'https://geo.mirror.pkgbuild.com/iso/arch.iso',
  host: 'geo.mirror.pkgbuild.com',
  size: 1,
  startedAt: NOW,
  inList: false,
  path: '/Users/test/Downloads/arch.iso',
  file: 'on_disk',
  ended: 'completed',
  ...fields
})

describe('how long history is kept', () => {
  it('forgets what started before 30 days or a year ago, or nothing', () => {
    expect(keepSince('forever', NOW)).toBeNull()
    expect(keepSince('30d', NOW)).toBe(NOW - 30 * DAY)
    expect(keepSince('1y', NOW)).toBe(NOW - 365 * DAY)
  })

  it('knows its three settings', () => {
    expect(['30d', '1y', 'forever'].every(isHistoryKeep)).toBe(true)
    expect(isHistoryKeep('7d')).toBe(false)
  })
})

describe('a link as History shows it', () => {
  it('drops a web link’s query, where a signed link keeps its signature', () => {
    expect(plainLink('https://cdn.example.com/s/a.iso?Expires=1&Signature=x#top')).toBe(
      'https://cdn.example.com/s/a.iso'
    )
    expect(plainLink('http://127.0.0.1:8080/a.bin')).toBe('http://127.0.0.1:8080/a.bin')
  })

  it('keeps anything else as it is', () => {
    const magnet = 'magnet:?xt=urn:btih:abcd&dn=film'
    expect(plainLink(magnet)).toBe(magnet)
    expect(plainLink('/Users/test/a.torrent')).toBe('/Users/test/a.torrent')
  })

  it('names a web link’s host, and none for anything else', () => {
    expect(hostOf('https://files.example.org:8443/a.iso')).toBe('files.example.org:8443')
    expect(hostOf('magnet:?xt=urn:btih:abcd')).toBe('')
    expect(hostOf('/Users/test/a.nzb')).toBe('')
  })
})

describe('filters and search', () => {
  it('shows what is on disk, not in the list, or whose file is missing', () => {
    const onDisk = entry({})
    const missing = entry({ file: 'missing' })
    const listed = entry({ inList: true })
    expect(shows(onDisk, 'all') && shows(missing, 'all')).toBe(true)
    expect(shows(onDisk, 'onDisk')).toBe(true)
    expect(shows(missing, 'onDisk')).toBe(false)
    expect(shows(onDisk, 'removed')).toBe(true)
    expect(shows(listed, 'removed')).toBe(false)
    expect(shows(missing, 'missing')).toBe(true)
    expect(shows(onDisk, 'missing')).toBe(false)
  })

  it('searches names, sites and links, every word typed', () => {
    const arch = entry({})
    expect(matches(arch, '')).toBe(true)
    expect(matches(arch, '  ARCH  ')).toBe(true)
    expect(matches(arch, 'pkgbuild iso')).toBe(true)
    expect(matches(arch, 'arch debian')).toBe(false)
    expect(matches(arch, 'iso/arch')).toBe(true)
  })

  it('counts what each filter shows, of what the search matches', () => {
    const entries = [
      entry({ id: 'a' }),
      entry({ id: 'b', file: 'missing', name: 'inkscape.dmg' }),
      entry({ id: 'c', inList: true, ended: undefined, file: 'partial', name: 'film.mkv' })
    ]
    expect(countsBy(entries, '')).toEqual({ all: 3, onDisk: 1, removed: 2, missing: 1 })
    expect(countsBy(entries, 'inkscape')).toEqual({ all: 1, onDisk: 0, removed: 1, missing: 1 })
  })
})

describe('groups by when', () => {
  it('today, yesterday, this week, this month, and older', () => {
    expect(bucketOf(NOW - 3600_000, NOW)).toBe('Today')
    expect(bucketOf(NOW - DAY, NOW)).toBe('Yesterday')
    expect(bucketOf(NOW - 3 * DAY, NOW)).toBe('Earlier this week')
    expect(bucketOf(NOW - 20 * DAY, NOW)).toBe('Earlier this month')
    expect(bucketOf(NOW - 120 * DAY, NOW)).toBe('Older')
  })

  it('lists the matches newest first, in their groups', () => {
    const groups = grouped(
      [
        entry({ id: 'old', startedAt: NOW - 90 * DAY }),
        entry({ id: 'new', startedAt: NOW - 1000 }),
        entry({ id: 'newer', startedAt: NOW - 10 }),
        entry({ id: 'gone', startedAt: NOW - 5 * DAY, file: 'missing' })
      ],
      '',
      'onDisk',
      NOW
    )
    expect(groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ['Today', ['newer', 'new']],
      ['Older', ['old']]
    ])
  })
})
