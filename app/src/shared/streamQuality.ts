import type { StreamVariant } from './types'

/** A stream quality as people name it: its picture height ("1080p"), or for a stream that doesn't
 * say, its bit rate ("2.5 Mbps", "128 kbps"). */
export function streamQualityLabel(variant: Pick<StreamVariant, 'height' | 'bandwidth'>): string {
  if (variant.height !== undefined && variant.height > 0) return `${variant.height}p`
  const kbps = variant.bandwidth / 1000
  if (kbps >= 1000) return `${Number((kbps / 1000).toFixed(1))} Mbps`
  return `${Math.max(1, Math.round(kbps))} kbps`
}
