import type { NetworkStatus } from '@shared/types'

const STATUS_TEXT: Record<Exclude<NetworkStatus, 'on'>, string> = {
  off: 'Off',
  offline: 'Not connected',
  unreachable: 'Can’t reach server',
  failed: 'Failed',
  limit: 'Data limit reached'
}

/** What a network that isn't simply on says: in a download's details, and in the list's tooltip. */
export function networkStatusText(
  status: Exclude<NetworkStatus, 'on'>,
  transfer: 'http' | 'torrent'
): string {
  return status === 'unreachable' && transfer === 'torrent'
    ? 'Can’t reach peers'
    : STATUS_TEXT[status]
}
