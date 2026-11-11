import type { NetworkInterfaceKind } from '@shared/types'
import { EthernetPort, Network, Smartphone, Wifi } from 'lucide-react'

const ICON: Record<NetworkInterfaceKind, typeof Wifi> = {
  wifi: Wifi,
  usb: Smartphone,
  ethernet: EthernetPort,
  bridge: Network,
  other: Network
}

/** A network's icon on a tile in its colour, as in the final design (LinkTile). Decorative: the
 * network's name is always beside it. */
export function NetworkTile({
  kind,
  color,
  onColor,
  size = 28,
  dim = false
}: {
  kind: NetworkInterfaceKind
  color: string
  onColor: string
  size?: number
  /** Off or gone: faded, so it reads as not in use. */
  dim?: boolean
}): React.JSX.Element {
  const Icon = ICON[kind]
  return (
    <span
      aria-hidden
      data-kind={kind}
      className="inline-flex shrink-0 items-center justify-center rounded-[32%] transition-opacity duration-200"
      style={{
        width: size,
        height: size,
        background: color,
        color: onColor,
        opacity: dim ? 0.38 : 1
      }}
    >
      <Icon className="size-[56%]" strokeWidth={2.25} />
    </span>
  )
}
