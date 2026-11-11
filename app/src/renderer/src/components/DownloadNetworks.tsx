import type {
  DownloadNetwork,
  DownloadState,
  HttpBlockState,
  HttpStreamState,
  NzbSegmentState,
  StreamSegmentState
} from '@shared/types'
import { cn } from 'cn'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useFormatSpeed, useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import type { NetworkVisual } from '../theme'
import {
  describeError,
  formatBytes,
  groupByNetwork,
  networkActive,
  type HttpNetworkGroup,
  type NetworkGroup,
  type TorrentNetworkGroup
} from '../utils/format'
import { networkStatusText } from './networkStatus'
import { NetworkEditPopover } from './NetworkEditPopover'
import { NetworkTile } from './NetworkTile'
import { SpeedText } from './SpeedText'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// A download's networks, as the final design's details pane lists them
// (design-system/mergelane/redesign/prototype.html, Inspector, "By network"): each network's tile,
// name and what it carried, its share of the download and its speed. Kept from the old network
// table: the switch for each network, its name and colour (the pencil), its speed limit, a proxy,
// what's stopping it, and its streams or peers one by one.

/** A block a stream can hold: an HTTP chunk, an NZB's article, or a video's segment. */
type Block = HttpBlockState | NzbSegmentState | StreamSegmentState

const ROW =
  'grid grid-cols-[auto_minmax(0,1fr)_3.25rem_minmax(5.5rem,auto)] items-center gap-x-3 border-b border-rule py-2 last:border-b-0'

/** A share as the list shows it: 0% for nothing, <1% for a sliver, never past 100%. */
function shareOf(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) return '0%'
  const percent = Math.min(100, Math.round((part / whole) * 100))
  return percent === 0 ? '<1%' : `${percent}%`
}

/** A network's name, interface and pencil, on the row's first line. */
function NetworkName({
  network,
  visual,
  editable
}: {
  network: DownloadNetwork
  visual: NetworkVisual
  editable: boolean
}): React.JSX.Element {
  const proxy = useAppStore((store) => store.networkPreferences[network.id]?.proxy)
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight font-[600]">
      <span className="truncate">{visual.name}</span>
      <span className="shrink-0 font-mono text-[11px] font-normal text-ink-3">{network.id}</span>
      {proxy?.enabled && proxy.host && <Badge>Proxy, {proxy.type.toUpperCase()}</Badge>}
      {editable && (
        <NetworkEditPopover
          interfaceId={network.id}
          interfaceKind={network.kind}
          osName={network.label}
        />
      )}
    </p>
  )
}

/** Every network a running, waiting or paused download can use, each switched on or off for it. */
export function LiveNetworks({ download }: { download: DownloadState }): React.JSX.Element {
  const networkVisual = useNetworkVisuals()
  const groups = groupByNetwork(download)
  const carried = groups.reduce((sum, group) => sum + group.bytesDownloaded, 0)
  return (
    <ul aria-label="Networks" className="flex flex-col">
      {groups.map((group) => (
        <LiveNetwork
          key={group.id}
          group={group}
          visual={networkVisual(group.id, group.kind, group.label)}
          share={shareOf(group.bytesDownloaded, carried)}
          running={download.status === 'downloading'}
          blocks={download.kind === 'torrent' ? undefined : download.blocks}
          usenet={download.kind === 'nzb'}
          onSwitch={(enabled) =>
            void window.mergelane.setDownloadNetwork(download.id, group.id, enabled)
          }
        />
      ))}
    </ul>
  )
}

function LiveNetwork({
  group,
  visual,
  share,
  running,
  blocks,
  usenet,
  onSwitch
}: {
  group: NetworkGroup
  visual: NetworkVisual
  share: string
  running: boolean
  blocks?: Block[]
  usenet: boolean
  onSwitch: (enabled: boolean) => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const formatSpeedLimit = useFormatSpeedLimit()
  const speedLimit = useAppStore((store) => store.networkPreferences[group.id]?.speedLimit)
  const [expanded, setExpanded] = useState(false)
  const active = running && networkActive(group)
  const connections = group.transfer === 'http' ? group.streams : group.peers
  const noun = group.transfer === 'torrent' ? 'peer' : usenet ? 'connection' : 'stream'
  const failed = group.status === 'failed'
  return (
    <li className="border-b border-rule last:border-b-0">
      <div
        className={cn(
          ROW,
          'grid-cols-[auto_auto_minmax(0,1fr)_3.25rem_minmax(5.5rem,auto)] border-b-0'
        )}
      >
        <Checkbox
          checked={group.enabled}
          onCheckedChange={(checked) => onSwitch(checked)}
          aria-label={`Use ${visual.name}`}
          className="data-checked:border-transparent"
          style={group.enabled ? { background: visual.solid, color: visual.onSolid } : undefined}
        />
        <NetworkTile
          kind={group.kind}
          color={visual.solid}
          onColor={visual.onSolid}
          size={22}
          dim={!group.enabled || group.status === 'offline'}
        />
        <div className="min-w-0">
          <NetworkName network={group} visual={visual} editable />
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-ink-3">
            {group.status !== 'on' && (
              <Tooltip disabled={!group.error}>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={group.error ? 0 : undefined}
                      className={cn('rounded-sm outline-none', failed && 'text-destructive')}
                    >
                      {networkStatusText(group.status, group.transfer)}
                    </span>
                  }
                />
                <TooltipContent>{group.error && describeError(group.error)}</TooltipContent>
              </Tooltip>
            )}
            <span>
              {group.transfer === 'torrent'
                ? `${formatBytes(group.bytesDownloaded)} received, ${formatBytes(group.bytesUploaded)} sent`
                : formatBytes(group.bytesDownloaded)}
            </span>
            {connections.length > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="inline-flex items-center gap-0.5 rounded-sm text-ink-2 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {connections.length} {noun}
                {connections.length === 1 ? '' : 's'}
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'size-3 transition-transform duration-150',
                    expanded && 'rotate-180'
                  )}
                />
              </button>
            )}
            {speedLimit !== undefined && <span>limit {formatSpeedLimit(speedLimit)}</span>}
          </p>
        </div>
        <span className="figures text-right text-[14px] font-[600]">{share}</span>
        <span className="flex flex-col items-end">
          <span className="sr-only">Downloading at </span>
          <SpeedText
            bytesPerSecond={group.speedBytesPerSec}
            dash={!active}
            className="text-right text-[14px] font-[600]"
          />
          {/* A torrent's network uploads too: always said, so that's plain. */}
          {group.transfer === 'torrent' && (
            <span className="figures text-[12px] text-ink-3">
              <span aria-hidden>↑ </span>
              <span className="sr-only">Uploading at </span>
              {group.uploadSpeedBytesPerSec > 0 ? formatSpeed(group.uploadSpeedBytesPerSec) : '—'}
            </span>
          )}
        </span>
      </div>
      {expanded &&
        (group.transfer === 'http' ? (
          <StreamList group={group} visual={visual} blocks={blocks} usenet={usenet} />
        ) : (
          <PeerList group={group} visual={visual} />
        ))}
    </li>
  )
}

function streamProgress(
  stream: HttpStreamState,
  blocks?: Block[]
): { block: Block | undefined; done: boolean; percent: number } {
  const block = stream.currentBlockIndex == null ? undefined : blocks?.[stream.currentBlockIndex]
  const done = stream.status === 'completed' || block?.status === 'completed'
  const size = block?.rangeEnd == null ? 0 : block.rangeEnd - block.rangeStart + 1
  const downloaded = block?.bytesDownloaded ?? stream.bytesDownloaded
  return {
    block,
    done,
    percent: done ? 100 : size > 0 ? Math.min(100, (downloaded / size) * 100) : 0
  }
}

const CONNECTION =
  'grid grid-cols-[auto_minmax(0,1fr)_3.25rem_minmax(5.5rem,auto)] items-center gap-x-3 py-1.5 text-[12px]'

function Lit({ on, visual }: { on: boolean; visual: NetworkVisual }): React.JSX.Element {
  return (
    <span
      className="ml-1.5 size-1.5 rounded-full"
      style={{ background: on ? visual.solid : 'var(--icon-muted)', opacity: on ? 1 : 0.4 }}
    />
  )
}

/** A network's streams (or a Usenet download's connections): the chunk each holds, how far it is
 * through it, its share and speed. */
function StreamList({
  group,
  visual,
  blocks,
  usenet
}: {
  group: HttpNetworkGroup
  visual: NetworkVisual
  blocks?: Block[]
  usenet: boolean
}): React.JSX.Element {
  // A video's blocks are its segments.
  const [name, unit] = usenet
    ? ['Connection', 'Article']
    : blocks?.[0]?.kind === 'stream'
      ? ['Stream', 'Segment']
      : ['Stream', 'Chunk']
  return (
    <ul aria-label={`${visual.name} ${name.toLowerCase()}s`} className="mb-2 ml-9 flex flex-col">
      {group.streams.map((stream, index) => {
        const progress = streamProgress(stream, blocks)
        const active = stream.status === 'downloading'
        const status = progress.done
          ? 'Done'
          : stream.status === 'paused'
            ? 'Paused'
            : stream.status === 'retrying'
              ? 'Retrying…'
              : 'Idle'
        return (
          <li key={stream.id} className="flex flex-col gap-1 border-t border-rule first:border-t-0">
            <div className={CONNECTION}>
              <Lit on={active || progress.done} visual={visual} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="font-[580] whitespace-nowrap">
                  {name} #{index + 1}
                </span>
                {progress.block && (
                  <span className="figures text-ink-3">
                    {unit} #{progress.block.index + 1}
                  </span>
                )}
                {/* A lit dot and a speed say it's fetching; only what isn't the usual gets a word. */}
                {active && (stream.hedge || stream.split) ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<Badge tabIndex={0}>{stream.hedge ? 'Backup' : 'Split'}</Badge>}
                    />
                    <TooltipContent>
                      {stream.hedge
                        ? 'Racing another stream for this chunk, which was running slowly'
                        : 'Fetching the far part of this chunk, so another stream doesn’t have to'}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  !active && (
                    <span
                      className={cn(
                        stream.status === 'retrying' ? 'text-destructive' : 'text-ink-3'
                      )}
                    >
                      {status}
                    </span>
                  )
                )}
              </span>
              <span className="figures text-right text-ink-2">
                {shareOf(stream.bytesDownloaded, group.bytesDownloaded)}
              </span>
              <SpeedText
                bytesPerSecond={stream.speedBytesPerSec}
                dash={!active}
                className="text-right text-[12.5px] font-[600]"
              />
            </div>
            <div
              role="progressbar"
              aria-label={`${name} #${index + 1} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.percent)}
              className="mb-1.5 ml-[18px] h-1 overflow-hidden rounded-full bg-track"
            >
              <div
                aria-hidden
                className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-200"
                style={{ width: `${progress.percent}%`, background: visual.solid }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** A torrent network's peers: their client, share, and what they send and get. */
function PeerList({
  group,
  visual
}: {
  group: TorrentNetworkGroup
  visual: NetworkVisual
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  // What the network's peers have sent between them: each one's share of it.
  const received = group.peers.reduce((sum, peer) => sum + peer.bytesDownloaded, 0)
  return (
    <ul aria-label={`${visual.name} peers`} className="mb-2 ml-9 flex flex-col">
      {group.peers.map((peer) => {
        const receiving = peer.status === 'receiving' && peer.speedBytesPerSec > 0
        return (
          <li key={peer.id} className={cn(CONNECTION, 'border-t border-rule first:border-t-0')}>
            <span role="img" aria-label={receiving ? 'Receiving' : 'Idle'} className="flex">
              <Lit on={receiving} visual={visual} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                {/* Unique in the download: a number is never another peer's. */}
                <span className="font-[580] whitespace-nowrap">Peer #{peer.id + 1}</span>
                {peer.client && <span className="truncate text-ink-3">{peer.client}</span>}
              </span>
              <span className="figures text-ink-3">
                <span className="sr-only">Received </span>
                {formatBytes(peer.bytesDownloaded)}
                {peer.bytesUploaded > 0 && (
                  <>
                    <span aria-hidden>, ↑ </span>
                    <span className="sr-only">, sent </span>
                    {formatBytes(peer.bytesUploaded)}
                  </>
                )}
              </span>
            </span>
            <span className="figures text-right text-ink-2">
              {shareOf(peer.bytesDownloaded, received)}
            </span>
            <span className="figures text-right text-[12.5px] font-[600]">
              <span className="sr-only">Receiving at </span>
              {receiving ? formatSpeed(peer.speedBytesPerSec) : '—'}
              {peer.uploadSpeedBytesPerSec > 0 && (
                <span className="block font-[500] text-ink-3">
                  <span aria-hidden>↑ </span>
                  <span className="sr-only">Sending at </span>
                  {formatSpeed(peer.uploadSpeedBytesPerSec)}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** A finished download's networks that carried part of it: what each brought, and its share. */
export function FinishedNetworks({ networks }: { networks: DownloadNetwork[] }): React.JSX.Element {
  const networkVisual = useNetworkVisuals()
  const carried = networks.filter((network) => network.bytesDownloaded > 0)
  const total = carried.reduce((sum, network) => sum + network.bytesDownloaded, 0)
  return (
    <ul aria-label="Networks" className="flex flex-col">
      {carried.map((network) => {
        const visual = networkVisual(network.id, network.kind, network.label)
        return (
          <li key={network.id} className={ROW}>
            <NetworkTile
              kind={network.kind}
              color={visual.solid}
              onColor={visual.onSolid}
              size={22}
            />
            <div className="min-w-0">
              <NetworkName network={network} visual={visual} editable={false} />
              <p className="figures text-[12px] leading-snug text-ink-3">
                {formatBytes(network.bytesDownloaded)}
                {network.transfer === 'torrent' && network.bytesUploaded > 0 && (
                  <>
                    <span aria-hidden>, ↑ </span>
                    <span className="sr-only">, sent </span>
                    {formatBytes(network.bytesUploaded)}
                  </>
                )}
              </p>
            </div>
            <span className="figures text-right text-[14px] font-[600]">
              {shareOf(network.bytesDownloaded, total)}
            </span>
            <span className="figures text-right text-[14px] text-ink-3">—</span>
          </li>
        )
      })}
    </ul>
  )
}
