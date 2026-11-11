import { ArrowDown, Route, TriangleAlert, Waypoints } from 'lucide-react'
import { useId } from 'react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import type { NetworkSummary } from '../utils/dashboard'
import { NetworkTile } from './NetworkTile'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Networks › Which network carries what, from the final design (prototype.html, RoutingPanel; ADR-0040):
// every download over one chosen network, the running ones included, or over all of them; and what
// happens while the chosen one is gone. The design's "Uploads use" row comes with M3.5b.

export function RoutingPanel({ networks }: { networks: NetworkSummary[] }): React.JSX.Element {
  const routing = useAppStore((store) => store.routing)
  const setRouting = useAppStore((store) => store.setRouting)
  const networkVisual = useNetworkVisuals()
  const fallbackId = useId()
  const pinned = routing.down === 'all' ? null : networks.find((each) => each.id === routing.down)
  const name = pinned ? networkVisual(pinned.id, pinned.kind, pinned.osName).name : routing.down
  const gone = routing.down !== 'all' && (!pinned || pinned.condition === 'offline')
  const hint =
    routing.down === 'all'
      ? 'Every download is split across the networks it has on. This is the merge.'
      : `Every download goes over ${name} only, the running ones included. A download’s own network choice waits until this is back on All networks.`
  const note = !gone
    ? null
    : routing.fallback
      ? `${name} isn’t connected, so downloads use their other networks meanwhile.`
      : `${name} isn’t connected. Downloads wait until it’s back.`

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
        Send every download over one network, for example Ethernet, and keep the others free.
      </p>
      <div className="flex flex-col gap-2 border-b border-rule py-3">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13.5px] font-[600]">
            <ArrowDown aria-hidden className="size-3.5" />
            Downloads use
          </span>
          <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">{hint}</p>
        </div>
        <div className="overflow-x-auto [scrollbar-width:none]">
          <ToggleGroup
            aria-label="Downloads use"
            value={[routing.down]}
            onValueChange={(values) => {
              if (values[0] !== undefined) setRouting({ down: values[0] })
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
      <div className="flex items-start justify-between gap-4 py-3">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={fallbackId} className="text-[13.5px] font-[600]">
            Use the other networks if the chosen one drops
          </label>
          <p className="text-[12.5px] leading-[1.5] text-ink-2">
            Off: downloads wait for the chosen network to come back.
          </p>
        </div>
        <Switch
          id={fallbackId}
          checked={routing.fallback}
          onCheckedChange={(fallback) => setRouting({ fallback })}
        />
      </div>
    </section>
  )
}
