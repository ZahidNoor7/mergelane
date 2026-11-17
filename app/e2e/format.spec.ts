import { expect, test } from '@playwright/test'
import {
  describeError,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  speedTicks
} from '../src/renderer/src/utils/format'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

test.describe('formatting @smoke', () => {
  test('a percentage reads 100 only once every byte is in', () => {
    expect(formatPercent(10 * GiB - 5 * MiB, 10 * GiB)).toBe(99)
    expect(formatPercent(999, 1000)).toBe(99)
    expect(formatPercent(1000, 1000)).toBe(100)
    expect(formatPercent(994, 1000)).toBe(99)
    expect(formatPercent(500, 1000)).toBe(50)
    expect(formatPercent(0, 0)).toBe(0)
  })

  test('a size under a byte is still bytes; a speed is always in the unit chosen (ADR-0072)', () => {
    expect(formatBytes(0.5)).toBe('1 B')
    expect(formatSpeed(1 / 3, 'bytes')).toBe('0.000 MB/s')
    expect(formatSpeed(1 / 3, 'kb')).toBe('0 KB/s')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  test('a speed axis for a sub-byte speed is finite, and its lines say different speeds', () => {
    const { top, ticks } = speedTicks(0.5, 'bytes')
    expect(Number.isFinite(top)).toBe(true)
    expect(top).toBeGreaterThanOrEqual(0.5)
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) expect(tick.label).toMatch(/^0\.01 MB\/s$/)
    // A few KB/s: round steps, each line its own figure, in the unit chosen.
    expect(speedTicks(2_600, 'kb').ticks.map((tick) => tick.label)).toEqual([
      '1 KB/s',
      '2 KB/s',
      '3 KB/s'
    ])
    expect(speedTicks(46_000, 'bytes').ticks.map((tick) => tick.label)).toEqual([
      '0.02 MB/s',
      '0.04 MB/s',
      '0.06 MB/s'
    ])
    // In every unit.
    expect(speedTicks(27_900_000, 'kb').ticks.map((tick) => tick.label)).toEqual([
      '10,000 KB/s',
      '20,000 KB/s',
      '30,000 KB/s'
    ])
    expect(speedTicks(27_900_000, 'bytes').ticks.map((tick) => tick.label)).toEqual([
      '10 MB/s',
      '20 MB/s',
      '30 MB/s'
    ])
    // 223.2 Mbps.
    expect(speedTicks(27_900_000, 'bits').ticks.map((tick) => tick.label)).toEqual([
      '100 Mbps',
      '200 Mbps',
      '300 Mbps'
    ])
  })

  test('a countdown never reads 60s', () => {
    expect(formatEta(0.2)).toBe('1s')
    expect(formatEta(58.2)).toBe('59s')
    expect(formatEta(59.01)).toBe('1m 0s')
    expect(formatEta(59.5)).toBe('1m 0s')
    expect(formatEta(61)).toBe('1m 1s')
  })

  test('a name with TLS or SSL in it isn’t read as a certificate problem', () => {
    const certificate = /security certificate/
    expect(describeError(new Error('unable to verify the first certificate'))).toMatch(certificate)
    expect(describeError(new Error('certificate has expired'))).toMatch(certificate)
    expect(
      describeError(
        new Error('Client network socket disconnected before secure TLS connection was established')
      )
    ).toMatch(certificate)
    expect(describeError(new Error('Windows can’t save a file named Thesis: TLS 1.3.pdf'))).toBe(
      'Windows can’t save a file named Thesis: TLS 1.3.pdf'
    )
    expect(
      describeError(new Error('No selected network has an address compatible with ssl.example.com'))
    ).toBe('No selected network has an address compatible with ssl.example.com')
  })
})
