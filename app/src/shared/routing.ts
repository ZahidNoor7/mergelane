import { DEFAULT_ROUTING, type DownloadRouting } from './types'

// Networks › Which network carries what (ADR-0040 downloads, ADR-0041 uploads): what the setting
// means for the engine, and what a saved or sent one may hold. The design's routeFor (prototype.html).

export type RouteDirection = 'down' | 'up'

/**
 * The networks routing sends `direction` over, or null when each transfer uses its own: the chosen
 * network while it's connected; while it isn't, each transfer's own networks with fallback on, and
 * none (the transfers wait) with it off.
 */
export function routeFor(
  routing: DownloadRouting,
  direction: RouteDirection,
  connected: (networkId: string) => boolean
): ReadonlySet<string> | null {
  const pin = routing[direction]
  if (pin === 'all') return null
  if (connected(pin)) return new Set([pin])
  return routing.fallback ? null : new Set()
}

const pinned = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : 'all'

/** A routing as saved, or as the renderer sends it: anything missing or wrong is its default. Not
 * a record: none at all. */
export function sanitizeRouting(value: unknown): DownloadRouting | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { down, up, fallback } = value as Record<string, unknown>
  return {
    ...DEFAULT_ROUTING,
    down: pinned(down),
    up: pinned(up),
    fallback: fallback !== false
  }
}
