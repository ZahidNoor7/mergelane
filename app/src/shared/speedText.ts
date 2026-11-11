import type { SpeedUnit } from './types'

// Sizes and speeds as words, shared by the window (renderer/src/utils/format.ts) and the menu bar
// (main/menuBar.ts), so both say the same thing.

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

const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']

/** Bits count in thousands, as internet plans and speed tests do — not the 1024s of formatBytes. */
export function formatSpeed(bytesPerSec: number, unit: SpeedUnit): string {
  if (unit === 'bytes') return `${formatBytes(bytesPerSec)}/s`
  const bits = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec * 8 : 0
  let exponent = bits < 1 ? 0 : Math.min(Math.floor(Math.log10(bits) / 3), BIT_UNITS.length - 1)
  // Whole numbers from 100 up: Mbps runs about 8x the digits of MB/s, so "943.2" would only jitter.
  const digits = (value: number): number => (exponent === 0 || value >= 99.95 ? 0 : 1)
  let value = bits / 1000 ** exponent
  if (exponent < BIT_UNITS.length - 1 && Number(value.toFixed(digits(value))) >= 1000) {
    exponent += 1
    value = bits / 1000 ** exponent
  }
  return `${value.toFixed(digits(value))} ${BIT_UNITS[exponent]}`
}
