import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  customRangeInvalid,
  dayInput,
  fileTypeOf,
  filtersActive,
  matchesFilters,
  NO_FILTERS,
  parseDay,
  type DownloadFilters,
  type Filterable
} from './downloadFilters'

// Local calendar times, so the tests hold in any time zone.
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime()
const NOW = at(2026, 11, 11, 15)
const item = (fileName: string, startedAt = NOW, kind = 'http'): Filterable => ({
  kind,
  fileName,
  startedAt
})
const filters = (patch: Partial<DownloadFilters>): DownloadFilters => ({ ...NO_FILTERS, ...patch })

describe('fileTypeOf', () => {
  it('reads the type from the extension, in any case', () => {
    expect(fileTypeOf(item('report.PDF'))).toBe('doc')
    expect(fileTypeOf(item('photo.heic'))).toBe('image')
    expect(fileTypeOf(item('film.mkv'))).toBe('video')
    expect(fileTypeOf(item('song.flac'))).toBe('audio')
    expect(fileTypeOf(item('backup.tar.gz'))).toBe('archive')
    expect(fileTypeOf(item('ubuntu.iso'))).toBe('disk')
    expect(fileTypeOf(item('Installer.dmg'))).toBe('app')
  })

  it('calls a video link’s download a video, and anything else unknown other', () => {
    expect(fileTypeOf(item('Talk', NOW, 'stream'))).toBe('video')
    expect(fileTypeOf(item('Some folder'))).toBe('other')
    expect(fileTypeOf(item('.hidden'))).toBe('other')
    expect(fileTypeOf(item('data.bin'))).toBe('other')
  })
})

describe('matchesFilters', () => {
  it('lets everything through with no filters', () => {
    expect(matchesFilters(item('a.bin', 0), NO_FILTERS, NOW)).toBe(true)
  })

  it('keeps only the chosen types; an unknown type never matches one', () => {
    const docsOrImages = filters({ types: ['doc', 'image'] })
    expect(matchesFilters(item('a.pdf'), docsOrImages, NOW)).toBe(true)
    expect(matchesFilters(item('a.png'), docsOrImages, NOW)).toBe(true)
    expect(matchesFilters(item('a.zip'), docsOrImages, NOW)).toBe(false)
    expect(matchesFilters(item('a.bin'), docsOrImages, NOW)).toBe(false)
  })

  it('counts whole calendar days for today, yesterday, 7 and 30 days', () => {
    const today = filters({ date: 'today' })
    expect(matchesFilters(item('a', at(2026, 11, 11, 0)), today, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 11, 10, 23)), today, NOW)).toBe(false)

    const yesterday = filters({ date: 'yesterday' })
    expect(matchesFilters(item('a', at(2026, 11, 10, 0)), yesterday, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 11, 11, 0)), yesterday, NOW)).toBe(false)
    expect(matchesFilters(item('a', at(2026, 11, 9, 23)), yesterday, NOW)).toBe(false)

    const week = filters({ date: '7d' })
    expect(matchesFilters(item('a', at(2026, 11, 5, 0)), week, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 11, 4, 23)), week, NOW)).toBe(false)

    const month = filters({ date: '30d' })
    expect(matchesFilters(item('a', at(2026, 10, 13, 0)), month, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 10, 12, 23)), month, NOW)).toBe(false)
  })

  it('includes both days of a custom range, and leaves either end open when empty', () => {
    const range = filters({ date: 'custom', from: '2026-11-01', to: '2026-11-03' })
    expect(matchesFilters(item('a', at(2026, 11, 1, 0)), range, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 11, 3, 23)), range, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 10, 31, 23)), range, NOW)).toBe(false)
    expect(matchesFilters(item('a', at(2026, 11, 4, 0)), range, NOW)).toBe(false)

    const from = filters({ date: 'custom', from: '2026-11-01' })
    expect(matchesFilters(item('a', at(2030, 1, 1)), from, NOW)).toBe(true)
    const to = filters({ date: 'custom', to: '2026-11-01' })
    expect(matchesFilters(item('a', 0), to, NOW)).toBe(true)
    expect(matchesFilters(item('a', at(2026, 11, 2)), to, NOW)).toBe(false)
  })

  it('ignores a backwards custom range until it is fixed, but still filters by type', () => {
    const backwards = filters({ date: 'custom', from: '2026-11-05', to: '2026-11-01' })
    expect(customRangeInvalid(backwards)).toBe(true)
    expect(matchesFilters(item('a.pdf', 0), backwards, NOW)).toBe(true)
    expect(matchesFilters(item('a.zip', 0), { ...backwards, types: ['doc'] }, NOW)).toBe(false)
    expect(customRangeInvalid(filters({ date: 'custom', from: '2026-11-01' }))).toBe(false)
    expect(
      customRangeInvalid(filters({ date: 'today', from: '2026-11-05', to: '2026-11-01' }))
    ).toBe(false)
  })
})

describe('days and counts', () => {
  it('reads and writes date fields on this Mac’s calendar', () => {
    expect(dayInput(at(2026, 3, 7))).toBe('2026-03-07')
    expect(parseDay('2026-03-07')).toBe(new Date(2026, 2, 7).getTime())
    expect(parseDay('')).toBeNull()
    expect(parseDay('7 March')).toBeNull()
  })

  it('says whether any filter is on, and how many', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false)
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
    expect(filtersActive(filters({ date: 'today' }))).toBe(true)
    expect(filtersActive(filters({ types: ['doc'] }))).toBe(true)
    expect(activeFilterCount(filters({ date: '7d', types: ['doc', 'image'] }))).toBe(3)
  })
})
