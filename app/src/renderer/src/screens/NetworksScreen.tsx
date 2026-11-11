import { roleOf } from '@shared/networkRoles'
import type { NetworkInterfaceKind } from '@shared/types'
import { cn } from 'cn'
import {
  ArrowUp,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Gauge,
  Info,
  Plug,
  Unplug
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { LimitsDialog } from '../components/LimitsDialog'
import { NetworkEditPopover } from '../components/NetworkEditPopover'
import { NetworkRoleMenu } from '../components/NetworkRoleMenu'
import { STANDBY_HINT } from '../components/networkStatus'
import { NetworkTile } from '../components/NetworkTile'
import { RoutingPanel } from '../components/RoutingPanel'
import { Sparkline } from '../components/Sparkline'
import { SpeedText } from '../components/SpeedText'
import { SystemMergeSection } from '../components/SystemMergeSection'
import { Button } from '../components/ui/button'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import {
  combinedHistory,
  formatDowntime,
  networkSummaries,
  type NetworkSummary
} from '../utils/dashboard'
import { formatDataUsage } from '../utils/format'

// The Networks place, from the final design (design-system/mergelane/redesign/prototype.html,
// NetworksScreen): every network with what it's doing, its limits and its last minute; system
// merge; the recent dropouts; and what combined speed can't do. It takes over the downloads
// toolbar's networks menu. Speed and data limits are edited in their dialog, opened from here,
// until the Settings screen (M3.1 pull request 5e) takes its general page.
//
// Each network's role for downloads, Use, Standby or Don't use (ADR-0045), is picked on its line,
// where the design's "Use for downloads" switch is.
//
// "Which network carries what" (RoutingPanel) routes downloads (ADR-0040) and torrent uploads
// (ADR-0041); their speed limits, download and upload, are edited in Speed & data limits.

/** What kind of connection a network is, said plainly (the owner's answer 3 in PHASE-3.md: the
 * connection type only, never the Wi-Fi network's name). */
const CONNECTION_TYPE: Record<NetworkInterfaceKind, string> = {
  wifi: 'Wi-Fi',
  usb: 'Tethered over USB',
  ethernet: 'Ethernet',
  bridge: 'Bridge',
  other: 'Other connection'
}

export function NetworksScreen(): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const preferences = useAppStore((store) => store.networkPreferences)
  const usage = useNetworkUsage(true)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const summaries = networkSummaries(interfaces, downloads, preferences, usage)
  const history = combinedHistory(downloads)
  const connected = summaries.filter((network) => network.condition !== 'offline').length
  // New download's pick: what it leaves out (`off`), and what each network's role makes of it.
  const picked = interfaces.filter(
    (iface) => !preferences[iface.id]?.off && roleOf(preferences[iface.id]) !== 'never'
  )
  const used = picked.filter((iface) => roleOf(preferences[iface.id]) === 'use').length
  const standby = picked.length - used
  const openLimits = (page: string | null): void => {
    setLimitsPage(page)
    setLimitsOpen(true)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="window-drag flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em]">
            Networks
          </h1>
          <p className="truncate text-[12px] leading-snug text-ink-3">
            {interfaces.length === 0
              ? 'No network connected'
              : `${connected} of ${summaries.length} connected. New downloads use ${
                  used === interfaces.length ? 'all of them' : `${used} of them`
                }${standby > 0 ? `, ${standby} more on standby` : ''}.`}
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => openLimits(null)}>
          <Gauge data-icon="inline-start" />
          Speed &amp; data limits
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="flex max-w-[860px] flex-col gap-8 px-4 pt-3 pb-8">
          {summaries.length === 0 ? (
            <p className="py-6 text-[13px] leading-[1.6] text-ink-2">
              No networks connected. Join a Wi-Fi network, plug in Ethernet, or connect your phone
              using USB tethering.
            </p>
          ) : (
            <ul aria-label="Networks" className="flex flex-col">
              {summaries.map((network) => (
                <NetworkLine
                  key={network.id}
                  network={network}
                  history={history[network.id] ?? []}
                  used={usage[network.id] ?? 0}
                  onLimits={() => openLimits(network.id)}
                />
              ))}
            </ul>
          )}

          <RoutingPanel networks={summaries} />

          <section
            aria-labelledby="networks-merge"
            className="flex flex-col gap-2 overflow-hidden rounded-[14px] bg-card shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <div className="px-4 pt-4">
              <h2 id="networks-merge" className="text-[14px] font-[650]">
                Other apps
              </h2>
              <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">
                Mergelane’s own downloads use every network without this. System merge lets other
                apps’ connections use them too.
              </p>
            </div>
            <SystemMergeSection open />
          </section>

          <Dropouts />

          <aside className="flex gap-3 rounded-[14px] bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <div className="flex max-w-[62ch] flex-col gap-1">
              <p className="text-[13.5px] font-[620]">One connection always uses one network.</p>
              <p className="text-[12.5px] leading-[1.6] text-ink-2">
                Only apps that open several connections get combined speed. Mergelane’s own
                downloads always open several; a video call or a single-connection download stays on
                one network.
              </p>
            </div>
          </aside>
        </div>
      </div>

      <LimitsDialog
        open={limitsOpen}
        showSchedule={false}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </div>
  )
}

function NetworkLine({
  network,
  history,
  used,
  onLimits
}: {
  network: NetworkSummary
  history: number[]
  /** What Mergelane has used on it in its data limit's period. */
  used: number
  onLimits: () => void
}): React.JSX.Element {
  const networkVisual = useNetworkVisuals()
  const formatSpeedLimit = useFormatSpeedLimit()
  const preference = useAppStore((store) => store.networkPreferences[network.id])
  const downloads = useAppStore((store) => store.downloads)
  const [hovered, setHovered] = useState<number | null>(null)
  const visual = networkVisual(network.id, network.kind, network.osName)
  const out = network.condition === 'offline'
  const on = !preference?.off
  const role = roleOf(preference)
  const dataLimit = preference?.dataLimit
  const reached = network.condition === 'paused'
  // What its torrents send out over it, for the line under its speed.
  const upload = Object.values(downloads).reduce(
    (sum, download) =>
      download.status === 'downloading'
        ? sum +
          download.networks.reduce(
            (part, each) =>
              each.id === network.id && each.transfer === 'torrent'
                ? part + each.uploadSpeedBytesPerSec
                : part,
            0
          )
        : sum,
    0
  )
  const state = out
    ? { icon: Unplug, text: 'Dropped. Its downloads moved to the other networks.', alert: true }
    : reached
      ? {
          icon: Gauge,
          text: 'Data limit reached. Paused until its period starts again.',
          alert: true
        }
      : network.condition === 'unreachable'
        ? { icon: Unplug, text: 'Connected, but can’t reach the server', alert: true }
        : role === 'never'
          ? { icon: CircleSlash, text: 'Connected, not used for downloads', alert: false }
          : role === 'standby'
            ? network.speed > 0
              ? { icon: CircleDashed, text: 'Standby, carrying downloads', alert: false }
              : { icon: CircleDashed, text: STANDBY_HINT, alert: false }
            : !on
              ? { icon: CircleCheck, text: 'Connected, left out of new downloads', alert: false }
              : network.speed > 0
                ? { icon: CircleCheck, text: 'Connected, carrying downloads', alert: false }
                : { icon: CircleCheck, text: 'Connected, idle', alert: false }
  const StateIcon = state.icon

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-rule py-3 last:border-b-0 @min-[672px]:grid-cols-[auto_minmax(0,1fr)_minmax(7rem,12rem)_auto]">
      <NetworkTile
        kind={network.kind}
        color={visual.solid}
        onColor={visual.onSolid}
        size={34}
        dim={out || !on || role === 'never'}
      />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-[620]">{visual.name}</span>
          <span className="rounded-full bg-sunken px-1.5 py-px font-mono text-[11px] text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]">
            {network.id}
          </span>
          <span className="truncate text-[12px] text-ink-3">{CONNECTION_TYPE[network.kind]}</span>
          {!out && (
            <NetworkEditPopover
              interfaceId={network.id}
              interfaceKind={network.kind}
              osName={network.osName}
            />
          )}
        </p>
        <p
          className={cn(
            'mt-1 flex items-center gap-1.5 text-[12px]',
            state.alert ? 'text-destructive' : 'text-ink-2'
          )}
        >
          <StateIcon aria-hidden className="size-3.5 shrink-0" />
          {state.text}
        </p>
        {(preference?.speedLimit !== undefined || dataLimit !== undefined) && (
          <div
            aria-label={`${visual.name} limits`}
            role="group"
            className="mt-1.5 flex flex-wrap items-center gap-1.5"
          >
            {preference?.speedLimit !== undefined && (
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-sunken px-2 text-[11.5px] font-[600] whitespace-nowrap text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]">
                <Gauge aria-hidden className="size-3" />
                Limit {formatSpeedLimit(preference.speedLimit)}
              </span>
            )}
            {dataLimit !== undefined && (
              <span
                className={cn(
                  'inline-flex h-5 items-center gap-2 rounded-full bg-sunken px-2 text-[11.5px] font-[600] whitespace-nowrap shadow-[inset_0_0_0_1px_var(--border)]',
                  reached ? 'text-destructive' : 'text-ink-2'
                )}
              >
                {formatDataUsage(used, dataLimit)}
                <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-track">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (used / dataLimit) * 100)}%`,
                      background: reached ? 'var(--color-danger)' : visual.solid
                    }}
                  />
                </span>
              </span>
            )}
          </div>
        )}
      </div>
      <div className="hidden @min-[672px]:block">
        <Sparkline
          values={history}
          top={Math.max(1, ...history)}
          color={visual.solid}
          label={`${visual.name}, last minute`}
          hovered={hovered}
          onHover={setHovered}
        />
      </div>
      <div className="flex items-center gap-3">
        <div className="flex min-w-[5.5rem] flex-col items-end">
          <SpeedText
            bytesPerSecond={network.speed}
            dash={out || network.speed === 0}
            className="text-right text-[18px] font-[650]"
          />
          {upload > 0 && (
            <span className="flex items-center gap-1 text-[12px] text-ink-3">
              <ArrowUp aria-label="Uploading" className="size-3" />
              <SpeedText bytesPerSecond={upload} className="text-[12.5px] font-[600] text-ink-2" />
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${visual.name} limits`}
          onClick={onLimits}
        >
          <Gauge />
        </Button>
        {!out && <NetworkRoleMenu networkId={network.id} name={visual.name} />}
      </div>
    </li>
  )
}

/** The last few networks that dropped or came back, newest first. The main process keeps a week
 * of them across restarts (ADR-0042). */
function Dropouts(): React.JSX.Element | null {
  const events = useAppStore((store) => store.networkEvents)
  const networkVisual = useNetworkVisuals()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const shown = events
    .filter((event) => event.change !== 'joined')
    .slice(-4)
    .reverse()
  return (
    <section aria-labelledby="networks-dropouts" className="flex flex-col gap-1">
      <h2 id="networks-dropouts" className="text-[13px] font-[650]">
        Recent network dropouts
      </h2>
      <div role="log" aria-labelledby="networks-dropouts">
        {shown.length === 0 ? (
          <p className="py-2 text-[12.5px] text-ink-3">No network has dropped in the last week.</p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((event) => {
              const back = event.change === 'recovered'
              const Icon = back ? Plug : Unplug
              const name = networkVisual(event.id, event.kind, event.osName).name
              return (
                <li
                  key={`${event.id}-${event.at}`}
                  className="flex items-center gap-2.5 border-b border-rule py-2 text-[12.5px] last:border-b-0"
                >
                  <Icon
                    aria-hidden
                    className={cn('size-3.5 shrink-0', back ? 'text-ink-2' : 'text-destructive')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-[600]">{name}</span>{' '}
                    <span className="font-mono text-[11px] text-ink-3">{event.id}</span>{' '}
                    {back ? (
                      <span className="text-ink-2">
                        {event.whileClosed
                          ? 'came back while Mergelane was closed'
                          : `came back after ${formatDowntime(event.downForMs ?? 0)}`}
                      </span>
                    ) : (
                      <span className="text-destructive">dropped</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-3">
                    {formatAgo(now - event.at)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}
