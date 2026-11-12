import type { TrayNetwork } from '@shared/trayFlyout'
import { useAppStore } from '../store/useAppStore'
import { networkSummaries } from '../utils/dashboard'
import { useNetworkVisuals } from './useNetworkVisuals'

/** Every network, live: its tile, name and speed, or that it's out, as the window's sidebar shows them
 * (components/WindowChrome.tsx). The notification-area flyout on Windows shows the same
 * (hooks/useTrayStatus.ts). */
export function useNetworkLanes(): TrayNetwork[] {
  const interfaces = useAppStore((store) => store.interfaces)
  const downloads = useAppStore((store) => store.downloads)
  const visual = useNetworkVisuals()
  return networkSummaries(interfaces, Object.values(downloads), {}, {}).map((network) => {
    const look = visual(network.id, network.kind, network.osName)
    return {
      id: network.id,
      kind: network.kind,
      name: look.name,
      color: look.solid,
      onColor: look.onSolid,
      speed: network.speed,
      out: network.condition === 'offline'
    }
  })
}
