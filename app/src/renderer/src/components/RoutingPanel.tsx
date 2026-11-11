import type { RouteDirection } from '@shared/routing'
import { ArrowDown, ArrowUp, Route, TriangleAlert, Waypoints } from 'lucide-react'
import { useId } from 'react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import type { NetworkSummary } from '../utils/dashboard'
import { NetworkTile } from './NetworkTile'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Networks › Which network carries what, from the final design (prototype.html, RoutingPanel):
// every download over one chosen network, the running ones included, or over all of them
// (ADR-0040); every torrent upload over one chosen network, whichever network downloads use, or
// over the networks each torrent downloads over (ADR-0041); and what happens while the chosen one
// is gone, one switch for both.

const ROWS: Record<
  RouteDirection,
  {
    label: string
    icon: typeof ArrowDown
    all: string
    pinned: (name: string) => string
    things: string
    meanwhile: string
  }
> = {
  down: {
    label: 'Downloads use',
    icon: ArrowDown,
    all: 'Every download is split across the networks it has on. This is the merge.',
    pinned: (name) =>
      `Every download goes over ${name} only, the running ones included. A download’s own network choice waits until this is back on All networks.`,
    things: 'Downloads',
    meanwhile: 'downloads use their other networks meanwhile'
  },
  up: {
    label: 'Uploads use',
    icon: ArrowUp,
    all: 'Torrent uploads go out over the same networks as their downloads.',
    pinned: (name) => `All uploads go out over ${name}, whichever network downloads use.`,
    things: 'Uploads',
    meanwhile: 'uploads go out over their downloads’ networks meanwhile'
  }
}

function RouteRow({
  direction,
  networks
}: {
  direction: RouteDirection
  networks: NetworkSummary[]
}): React.JSX.Element {
  const routing = useAppStore((store) => store.routing)
  const setRouting = useAppStore((store) => store.setRouting)
  const networkVisual = useNetworkVisuals()
  const row = ROWS[direction]
  const Icon = row.icon
  const pin = routing[direction]
  const pinned = pin === 'all' ? null : networks.find((each) => each.id === pin)
  const name = pinned ? networkVisual(pinned.id, pinned.kind, pinned.osName).name : pin
  const gone = pin !== 'all' && (!pinned || pinned.condition === 'offline')
  const note = !gone
    ? null
    : routing.fallback
      ? `${name} isn’t connected, so ${row.meanwhile}.`
      : `${name} isn’t connected. ${row.things} wait until it’s back.`

  return (
    <div className="flex flex-col gap-2 border-b border-rule py-3">
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[13.5px] font-[600]">
          <Icon aria-hidden className="size-3.5" />
          {row.label}
        </span>
        <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">
          {pin === 'all' ? row.all : row.pinned(name)}
        </p>
      </div>
      <div className="overflow-x-auto [scrollbar-width:none]">
        <ToggleGroup
          aria-label={row.label}
          value={[pin]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setRouting({ [direction]: values[0] })
          }}
        >
          <ToggleGroupItem value="all">
            <Waypoints aria-hidden />
            All networks
          </ToggleGroupItem>
          {networks.map((network) => {
            const visual = networkVisual(network.id, network.kind, network.osName)
            return (
              <ToggleGroupItem key={network.id} value={network.id}>
                <NetworkTile
                  kind={network.kind}
                  color={visual.solid}
                  onColor={visual.onSolid}
                  size={16}
                />
                {visual.name}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
      </div>
      {note && (
        <p role="status" className="flex items-center gap-1.5 text-[12.5px] text-caution">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {note}
        </p>
      )}
    </div>
  )
}

export function RoutingPanel({ networks }: { networks: NetworkSummary[] }): React.JSX.Element {
  const fallback = useAppStore((store) => store.routing.fallback)
  const setRouting = useAppStore((store) => store.setRouting)
  const fallbackId = useId()

  return (
    <section
      aria-labelledby="routing-title"
      className="flex flex-col gap-1 rounded-[14px] bg-card px-4 pt-4 pb-1 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <h2 id="routing-title" className="flex items-center gap-1.5 text-[14px] font-[650]">
        <Route aria-hidden className="size-4" />
        Which network carries what
      </h2>
      <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">
        Send downloads and uploads over different networks, for example downloads over Ethernet and
        uploads off your iPhone’s data plan.
      </p>
      <RouteRow direction="down" networks={networks} />
      <RouteRow direction="up" networks={networks} />
      <div className="flex items-start justify-between gap-4 py-3">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={fallbackId} className="text-[13.5px] font-[600]">
            Use the other networks if the chosen one drops
          </label>
          <p className="text-[12.5px] leading-[1.5] text-ink-2">
            Off: transfers wait for the chosen network to come back.
          </p>
        </div>
        <Switch
          id={fallbackId}
          checked={fallback}
          onCheckedChange={(fallback) => setRouting({ fallback })}
        />
      </div>
    </section>
  )
}
