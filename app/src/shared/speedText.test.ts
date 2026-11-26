import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatSpeed,
  formatSpeedPair,
  SPEED_UNIT_LABELS,
  SPEED_UNITS,
  formatPercent
} from './speedText'

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
  // The three units (ADR-0071), each shown only in itself (ADR-0072), counted in 1,000s as macOS counts.
  // 8 Mbps is 1 MB/s is 1,000 KB/s.
  it('KB/s: always KB/s, whole, thousands set apart', () => {
    expect(formatSpeed(0, 'kb')).toBe('0 KB/s')
    expect(formatSpeed(46_000, 'kb')).toBe('46 KB/s')
    expect(formatSpeed(499, 'kb')).toBe('0 KB/s')
    expect(formatSpeed(27_900_000, 'kb')).toBe('27,900 KB/s')
  })

  it('MB/s: always MB/s, however slow; more decimals as it slows, whole from 100', () => {
    expect(formatSpeed(120_000_000, 'bytes')).toBe('120 MB/s')
    // 99.96 MB/s is whole rather than "100.0".
    expect(formatSpeed(99_960_000, 'bytes')).toBe('100 MB/s')
    expect(formatSpeed(2_500_000, 'bytes')).toBe('2.5 MB/s')
    expect(formatSpeed(1_000_000, 'bytes')).toBe('1.0 MB/s')
    // Just under 1 MB/s rounds to "1.0", not "1.00".
    expect(formatSpeed(999_600, 'bytes')).toBe('1.0 MB/s')
    expect(formatSpeed(993_000, 'bytes')).toBe('0.99 MB/s')
    expect(formatSpeed(46_000, 'bytes')).toBe('0.05 MB/s')
    expect(formatSpeed(10_000, 'bytes')).toBe('0.01 MB/s')
    expect(formatSpeed(2_000, 'bytes')).toBe('0.002 MB/s')
    expect(formatSpeed(0, 'bytes')).toBe('0 MB/s')
  })

  it('Mbps: always Mbps, the same way', () => {
    expect(formatSpeed(0, 'bits')).toBe('0 Mbps')
    expect(formatSpeed(125_000, 'bits')).toBe('1.0 Mbps')
    expect(formatSpeed(1_250_000, 'bits')).toBe('10.0 Mbps')
    expect(formatSpeed(15_000_000, 'bits')).toBe('120 Mbps')
    // A slow link stays in Mbps rather than switching to Kbps.
    expect(formatSpeed(13_250, 'bits')).toBe('0.11 Mbps')
    expect(formatSpeed(250, 'bits')).toBe('0.002 Mbps')
    expect(formatSpeed(1.25e9, 'bits')).toBe('10000 Mbps')
  })

  it('treats a missing or broken speed as nothing', () => {
    for (const unit of SPEED_UNITS) {
      const zero = formatSpeed(0, unit)
      expect(formatSpeed(Number.NaN, unit)).toBe(zero)
      expect(formatSpeed(-5, unit)).toBe(zero)
      expect(formatSpeed(Number.POSITIVE_INFINITY, unit)).toBe(zero)
    }
  })

  it('one speed reads the same in every unit, and only in that unit', () => {
    expect([formatSpeed(1e6, 'kb'), formatSpeed(1e6, 'bytes'), formatSpeed(1e6, 'bits')]).toEqual([
      '1,000 KB/s',
      '1.0 MB/s',
      '8.0 Mbps'
    ])
    for (const speed of [0, 300, 46_000, 993_000, 2_500_000, 120_000_000]) {
      expect(formatSpeed(speed, 'kb')).toMatch(/ KB\/s$/)
      expect(formatSpeed(speed, 'bytes')).toMatch(/ MB\/s$/)
      expect(formatSpeed(speed, 'bits')).toMatch(/ Mbps$/)
    }
  })
})

describe('the units', () => {
  it('are the design’s three, named as they are chosen', () => {
    expect(SPEED_UNITS.map((unit) => SPEED_UNIT_LABELS[unit])).toEqual(['KB/s', 'MB/s', 'Mbps'])
  })
})

describe('formatSpeedPair', () => {
  it('says download and upload in the chosen unit, once, as the design’s menu bar does', () => {
    expect(formatSpeedPair(27_900_000, 2_800_000, 'bytes')).toBe('↓27.9 ↑2.8 MB/s')
    expect(formatSpeedPair(10_000_000, 100_000, 'bytes')).toBe('↓10.0 ↑0.10 MB/s')
    // Slow both ways: still MB/s.
    expect(formatSpeedPair(46_000, 2_000, 'bytes')).toBe('↓0.05 ↑0.002 MB/s')
    expect(formatSpeedPair(0, 0, 'bytes')).toBe('↓0 ↑0 MB/s')
    expect(formatSpeedPair(120_000_000, 0, 'bytes')).toBe('↓120 ↑0 MB/s')
  })

  it('in KB/s and in Mbps, always that unit', () => {
    expect(formatSpeedPair(27_900_000, 2_800_000, 'kb')).toBe('↓27,900 ↑2,800 KB/s')
    expect(formatSpeedPair(27_900_000, 2_800_000, 'bits')).toBe('↓223 ↑22.4 Mbps')
    expect(formatSpeedPair(46_000, 2_000, 'bits')).toBe('↓0.37 ↑0.02 Mbps')
  })

  it('treats a missing or broken speed as nothing', () => {
    expect(formatSpeedPair(Number.NaN, -5, 'bytes')).toBe('↓0 ↑0 MB/s')
    expect(formatSpeedPair(Number.POSITIVE_INFINITY, 1e6, 'bytes')).toBe('↓0 ↑1.0 MB/s')
  })
})

describe('how far a download is', () => {
  it('rounds to a whole percent, never claiming 100% before the last byte', () => {
    expect(formatPercent(0, 0)).toBe(0)
    expect(formatPercent(37, 100)).toBe(37)
    expect(formatPercent(374, 1000)).toBe(37)
    expect(formatPercent(996, 1000)).toBe(99)
    expect(formatPercent(1000, 1000)).toBe(100)
    expect(formatPercent(1200, 1000)).toBe(100)
  })
})
