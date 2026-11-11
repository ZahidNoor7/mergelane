import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPTURE_RULES, keptBy, minBytesOf, sanitizeCaptureRules } from './captureRules'

const MB = 1024 * 1024
const file = (
  fileName: string,
  size: number | null = 5 * MB,
  kind = 'http'
): { kind: string; fileName: string; size: number | null } => ({
  kind,
  fileName,
  size
})

describe('capture rules', () => {
  it('default to the design’s: over 1 MB; video, archives, disk images and apps', () => {
    expect(DEFAULT_CAPTURE_RULES).toEqual({
      capture: true,
      minSize: '1mb',
      types: ['video', 'archive', 'disk', 'app'],
      videoButton: true
    })
    expect(sanitizeCaptureRules(undefined)).toEqual(DEFAULT_CAPTURE_RULES)
  })

  it('keep what’s valid, field by field, in the offered order', () => {
    expect(
      sanitizeCaptureRules({
        capture: false,
        minSize: '100mb',
        types: ['doc', 'image', 'video', 'nonsense'],
        videoButton: false
      })
    ).toEqual({ capture: false, minSize: '100mb', types: ['video', 'doc'], videoButton: false })
    expect(sanitizeCaptureRules({ capture: 'yes', minSize: '5mb', types: 'video' })).toEqual(
      DEFAULT_CAPTURE_RULES
    )
    expect(sanitizeCaptureRules({ types: [] }).types).toEqual([])
  })

  it('size in bytes', () => {
    expect([minBytesOf('any'), minBytesOf('1mb'), minBytesOf('10mb'), minBytesOf('100mb')]).toEqual(
      [0, MB, 10 * MB, 100 * MB]
    )
  })

  it('send the picked types and unknown ones, over the minimum; keep the rest', () => {
    const rules = DEFAULT_CAPTURE_RULES
    expect(keptBy(rules, file('movie.mkv'))).toBeNull()
    expect(keptBy(rules, file('firmware.bin'))).toBeNull()
    expect(keptBy(rules, file('no-extension'))).toBeNull()
    expect(keptBy(rules, file('report.pdf'))).toBe('a type Mergelane doesn’t take')
    expect(keptBy(rules, file('photo.jpg'))).toBe('a type Mergelane doesn’t take')
    expect(keptBy(rules, file('tiny.zip', 1000))).toBe('smaller than the minimum size')
    // A size the server doesn't give isn't held against it.
    expect(keptBy(rules, file('unknown.zip', null))).toBeNull()
    // A video link is a video whatever its name; torrents and news files aren't sorted by type.
    expect(keptBy(rules, file('index.m3u8', null, 'stream'))).toBeNull()
    expect(keptBy({ ...rules, types: [] }, file('x.torrent', null, 'torrent'))).toBeNull()
    expect(keptBy({ ...rules, types: [] }, file('x.nzb', null, 'nzb'))).toBeNull()
    expect(keptBy({ ...rules, capture: false }, file('movie.mkv'))).toBe(
      'sending downloads to Mergelane is off'
    )
    expect(keptBy({ ...rules, minSize: 'any' }, file('tiny.zip', 10))).toBeNull()
  })
})
