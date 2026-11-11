import type { NetworkPreference, NetworkRole, NetworkStatus } from './types'

// Networks › each network's role for Mergelane's own downloads (ADR-0045): Use, Standby or Don't
// use. What a saved or sent role may hold, and what the roles, the download's own choice and
// routing (ADR-0040) together make of each of a download's networks.

/** A network's role, as its saved preference has it: 'use' unless it says otherwise. */
export function roleOf(preference: NetworkPreference | undefined): NetworkRole {
  return preference?.role === 'standby' || preference?.role === 'never' ? preference.role : 'use'
}

/** A role as saved, or as the renderer sends it: only one of the two that are kept, else none
 * ('use' is the default, so it is never saved). */
export function sanitizeRole(value: unknown): Exclude<NetworkRole, 'use'> | undefined {
  return value === 'standby' || value === 'never' ? value : undefined
}

/** Networks in the order a download that runs over one network picks them: Use, then Standby,
 * then Don't use. Otherwise in the order given. */
export function byRole<T>(networks: readonly T[], role: (network: T) => NetworkRole): T[] {
  const rank: Record<NetworkRole, number> = { use: 0, standby: 1, never: 2 }
  return networks
    .map((network, index) => ({ network, index }))
    .sort((a, b) => rank[role(a.network)] - rank[role(b.network)] || a.index - b.index)
    .map(({ network }) => network)
}

/** What one download knows of one of its networks when it looks again (DownloadManager.reconcile). */
export interface NetworkFacts {
  id: string
  /** The download's own choice. */
  enabled: boolean
  /** Its status until now. */
  status: NetworkStatus
  /** On this Mac now, or not yet known to be gone. */
  connected: boolean
  /** It has used up its data for the period. */
  atLimit: boolean
  role: NetworkRole
}

/** Statuses that are only about whether it's used, not how it's doing: once nothing holds it back
 * any more, it's on again. */
const HELD_BACK: ReadonlySet<NetworkStatus> = new Set([
  'off',
  'offline',
  'limit',
  'routed',
  'standby',
  'unused'
])

/** Statuses of a network that is trying to carry the download. */
const TRYING: ReadonlySet<NetworkStatus> = new Set(['on', 'unreachable'])

/**
 * Each network's status now, in the order given.
 *
 * - Routing (`route`, from routeFor) decides alone while it names a network: roles don't apply.
 * - Otherwise the download's own choice, then Don't use, then whether it's connected and within
 *   its data limit.
 * - A Standby network then waits ('standby') while one of the download's Use networks is trying to
 *   carry it: on, or connected but not getting through yet (which keeps trying). One that is off,
 *   gone, at its limit or failed doesn't count, so the standby network takes over.
 */
export function networkStatuses(
  networks: readonly NetworkFacts[],
  route: ReadonlySet<string> | null
): NetworkStatus[] {
  const first = networks.map((network): NetworkStatus => {
    const wanted = route ? route.has(network.id) : network.enabled
    if (!wanted) return route ? 'routed' : 'off'
    if (!route && network.role === 'never') return 'unused'
    if (!network.connected) return 'offline'
    if (network.atLimit) return 'limit'
    return HELD_BACK.has(network.status) ? 'on' : network.status
  })
  if (route) return first
  const useCarries = networks.some(
    (network, index) => network.role === 'use' && TRYING.has(first[index])
  )
  if (!useCarries) return first
  return first.map((status, index) =>
    networks[index].role === 'standby' && (TRYING.has(status) || status === 'failed')
      ? 'standby'
      : status
  )
}
