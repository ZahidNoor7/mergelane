import type { ConfluenceLane } from '../components/Confluence'
import { useAppStore } from '../store/useAppStore'
import {
  activeDownloads,
  networkSummaries,
  type ActiveDownloads,
  type NetworkSummary
} from '../utils/dashboard'
import { formatEta, groupByNetwork, networkActive } from '../utils/format'
import { useNetworkVisuals } from './useNetworkVisuals'

/** Every network as a Confluence lane across all running downloads, as the Dashboard and the
 * download list draw them: as thick as its speed while it carries bytes, in words otherwise. With
 * what is running, and a line saying so ("2 downloading, about 3m left"). */
export function useMergeLanes(): {
  lanes: ConfluenceLane[]
  summaries: NetworkSummary[]
  active: ActiveDownloads
  progress: string
} {
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const interfaces = useAppStore((store) => store.interfaces)
  const networkVisual = useNetworkVisuals()

  const active = activeDownloads(downloads)
  const carrying = new Set(
    active.running.flatMap((download) =>
      groupByNetwork(download)
        .filter(networkActive)
        .map((group) => group.id)
    )
  )
  const summaries = networkSummaries(interfaces, downloads, {}, {})
  const lanes = summaries.map((network): ConfluenceLane => {
    const visual = networkVisual(network.id, network.kind, network.osName)
    return {
      id: network.id,
      interfaceName: network.id,
      name: visual.name,
      color: visual.solid,
      speed: network.speed,
      on: carrying.has(network.id),
      down: network.condition === 'offline',
      limited: network.condition === 'limited',
      note:
        network.condition === 'paused'
          ? 'Data limit reached'
          : network.condition === 'unreachable'
            ? 'Can’t reach the server'
            : 'Idle'
    }
  })
  const count = active.running.length
  const progress =
    count > 0
      ? `${count} downloading${active.etaSeconds === undefined ? '' : `, about ${formatEta(active.etaSeconds)} left`}`
      : 'Nothing downloading'
  return { lanes, summaries, active, progress }
}
