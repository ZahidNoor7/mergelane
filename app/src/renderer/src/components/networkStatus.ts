import type { NetworkRole, NetworkStatus } from '@shared/types'

/** What a Standby network does, said where it is shown. */
export const STANDBY_HINT = 'Standby: used only when no network set to Use is connected'

// A network's role for downloads (ADR-0045), as Networks and New download say it.

/** Each role's name and what it does, in the menu's order. */
export const ROLE_CHOICES: { role: NetworkRole; label: string; hint: string }[] = [
  { role: 'use', label: 'Use', hint: 'Downloads use it.' },
  {
    role: 'standby',
    label: 'Standby',
    hint: 'Used only when no network set to Use is connected, like a phone’s data plan kept as a backup.'
  },
  { role: 'never', label: 'Don’t use', hint: 'Downloads never use it.' }
]

export function roleLabel(role: NetworkRole): string {
  return ROLE_CHOICES.find((choice) => choice.role === role)!.label
}

const STATUS_TEXT: Record<Exclude<NetworkStatus, 'on'>, string> = {
  off: 'Off',
  offline: 'Not connected',
  unreachable: 'Can’t reach server',
  failed: 'Failed',
  limit: 'Data limit reached',
  routed: 'Not used for downloads: they go over another network',
  standby: STANDBY_HINT,
  unused: 'Not used: set to Don’t use on Networks'
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
