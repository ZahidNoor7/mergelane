import type { SpeedUnit } from './types'

// Sizes and speeds as words, shared by the window (renderer/src/utils/format.ts) and the menu bar
// (main/menuBar.ts), so both say the same thing. Sizes count in 1024s; speeds in 1,000s, in the unit chosen in
// Settings (ADR-0071).

export const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  // Under 1 byte (a slow speed averaged over a few seconds) is still bytes, not a unit below them.
  let exponent = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  )
  let value = bytes / 1024 ** exponent
  if (exponent < UNITS.length - 1 && Number(value.toFixed(exponent === 0 ? 0 : 1)) >= 1024) {
    exponent += 1
    value = bytes / 1024 ** exponent
  }
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${UNITS[exponent]}`
}

/** The three units a speed is shown in (ADR-0071). */
export const SPEED_UNITS: readonly SpeedUnit[] = ['kb', 'bytes', 'bits']

/** What each unit is called where it is chosen: the unit it shows. */
export const SPEED_UNIT_LABELS: Record<SpeedUnit, string> = {
  kb: 'KB/s',
  bytes: 'MB/s',
  bits: 'Mbps'
}

const clean = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/** A figure in MB/s or Mbps: whole from 100 up, where a tenth would only jitter; one decimal from 1; two below 1
 * and three below a hundredth, so a slow speed still reads in the chosen unit rather than as 0. Nothing is "0". */
function decimal(value: number): string {
  if (value === 0) return '0'
  if (value >= 99.95) return value.toFixed(0)
  if (value >= 0.995) return value.toFixed(1)
  if (value >= 0.00995) return value.toFixed(2)
  return value.toFixed(3)
}

/** Whole KB/s, with thousands set apart: "27,900". */
function kilo(bytesPerSec: number): string {
  return Math.round(bytesPerSec / 1e3).toLocaleString('en-US')
}

/** A speed in the chosen unit, and only that unit (ADR-0071, ADR-0072), counted in 1,000s as macOS counts: KB/s,
 * MB/s or Mbps. 8 Mbps is 1 MB/s is 1,000 KB/s. */
export function formatSpeed(bytesPerSec: number, unit: SpeedUnit): string {
  const bytes = clean(bytesPerSec)
  if (unit === 'kb') return `${kilo(bytes)} KB/s`
  if (unit === 'bits') return `${decimal((bytes * 8) / 1e6)} Mbps`
  return `${decimal(bytes / 1e6)} MB/s`
}

/** Download and upload in the chosen unit, said once, as the menu bar shows them (the design's menu bar item,
 * ADR-0067): "↓27.9 ↑2.8 MB/s". */
export function formatSpeedPair(down: number, up: number, unit: SpeedUnit): string {
  const figure = (bytesPerSec: number): string => {
    const text = formatSpeed(bytesPerSec, unit)
    return text.slice(0, text.lastIndexOf(' '))
  }
  return `↓${figure(down)} ↑${figure(up)} ${SPEED_UNIT_LABELS[unit]}`
}
