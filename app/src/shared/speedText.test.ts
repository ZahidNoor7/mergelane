import { describe, expect, it } from 'vitest'
import { formatBytes, formatSpeed } from './speedText'

// Shared by the window and the menu bar (ADR-0037), so both say the same thing.

describe('formatBytes', () => {
  it('counts in 1024s, whole bytes, one decimal above', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(0.4)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(3 * 1024 ** 5)).toBe('3072.0 TB')
  })

  it('moves up a unit rather than show 1024.0', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
  })
})

describe('formatSpeed', () => {
  it('in bytes, as formatBytes a second', () => {
    expect(formatSpeed(2.5 * 1024 * 1024, 'bytes')).toBe('2.5 MB/s')
  })

  it('in bits, counting in 1000s, whole numbers from 100', () => {
    expect(formatSpeed(0, 'bits')).toBe('0 bps')
    expect(formatSpeed(Number.POSITIVE_INFINITY, 'bits')).toBe('0 bps')
    expect(formatSpeed(100, 'bits')).toBe('800 bps')
    expect(formatSpeed(1_250_000, 'bits')).toBe('10.0 Mbps')
    expect(formatSpeed(15_000_000, 'bits')).toBe('120 Mbps')
    // 999.92 Kbps would round to "1000 Kbps": it moves up instead.
    expect(formatSpeed(124_990, 'bits')).toBe('1.0 Mbps')
    expect(formatSpeed(1e15, 'bits')).toBe('8000 Tbps')
  })
})
