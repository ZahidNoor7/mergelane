import {
  SPEED_HISTORY_SECONDS,
  type DownloadState,
  type SystemMergeLink,
  type SystemMergeSnapshot
} from '@shared/types'
import { CircleCheck, CirclePause, Gauge, Plug, Plus, TriangleAlert, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Confluence, PLACEHOLDER_LANES } from '../components/Confluence'
import { DashboardToday } from '../components/DashboardToday'
import { UsagePanel } from '../components/UsagePanel'
import { LimitsDialog } from '../components/LimitsDialog'
import { Sparkline } from '../components/Sparkline'
import { SystemMergeSection } from '../components/SystemMergeSection'
import { ThroughputChart } from '../components/ThroughputChart'
import { Button } from '../components/ui/button'
import { useFormatSpeed, useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useMergeLanes } from '../hooks/useMergeLanes'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals, type ResolveNetworkVisual } from '../hooks/useNetworkVisuals'
import { useSystemMerge } from '../hooks/useSystemMerge'
import { useAppStore } from '../store/useAppStore'
import { NETWORK_COLOR_SWATCHES } from '../theme'
import {
  activeDownloads,
  appendLinkSamples,
  combinedHistory,
  formatDowntime,
  networkSummaries,
  type NetworkCondition,
  type NetworkEvent,
  type NetworkSummary
} from '../utils/dashboard'
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatWhen,
  speedTicks,
  wantedBytes
} from '../utils/format'

const isMac = window.mergelane.platform === 'darwin'
const PASTE_SHORTCUT = isMac ? '⌘V' : 'Ctrl+V'
const NEW_SHORTCUT = isMac ? '⌘N' : 'Ctrl+N'

/** The list's group label, so both screens title their sections alike. */
// The design's SectionTitle (prototype.html): sentence case, on a rule.
const sectionLabelClass = 'text-[13px] font-[650] tracking-[-0.005em] text-foreground'
const bodyClass = 'text-[12.5px] leading-[1.6] text-ink-2'

/** README's "What to expect", in the same words: shown where the speeds are, not only in docs. */
const HONEST_LIMITS = [
  {
    title: 'One connection always uses one network.',
    body: 'Combined speed needs several connections at once. Mergelane’s own downloads open several. With system merge on, other apps get faster only if they open several themselves: a video call or a single-connection download won’t.'
  },
  {
    title: 'A network that drops breaks the connections on it.',
    body: 'New connections go to the networks that are left, but a connection already open on the lost one has to reconnect, as it would without Mergelane.'
  },
  {
    title: 'Networks add speed only if they’re separate internet connections.',
    body: 'Two Wi-Fi networks from the same router, or a phone tethered to that same Wi-Fi, share one connection and won’t add speed.'
  },
  {
    title: 'VPNs come first.',
    body: 'While another VPN is on, system merge stays off, or turns itself off, and says why. Downloads in Mergelane keep working where they can.'
  }
]

function SectionHeading({
  label,
  count,
  children
}: {
  label: string
  count?: number
  /** At the right of the rule: a short summary or a way onward. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule pt-7 pb-2">
      <h2 className={sectionLabelClass}>
        {label}
        {count !== undefined && <span className="figures ml-2 font-[500] text-ink-3">{count}</span>}
      </h2>
      <div className="flex-1" />
      {children}
    </div>
  )
}

/** Every download that isn't finished, everything every network is doing, whether a network
 * dropped, system-wide merging, and what combined speed can and can't do — on one screen. */
export function DashboardScreen(): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  // Polled once a second while the dashboard is open. SystemMergeSection polls its own as well,
  // as it does in the networks menu.
  const { snapshot } = useSystemMerge(true)
  const merging = snapshot?.reachable === true && snapshot.state === 'on'

  // A new screen: say so to a screen reader, and start keyboard focus here.
  useEffect(() => headingRef.current?.focus(), [])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* The window's frame has the way back (the sidebar or the compact bar); the design's
          Toolbar here is only the title (prototype.html, DashboardScreen). */}
      <div className="window-drag flex min-h-14 shrink-0 flex-col justify-center border-b border-rule px-5 py-2.5">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em] outline-none"
        >
          Dashboard
        </h1>
        <p className="truncate text-[12px] leading-snug text-ink-3">
          Every download and network at a glance
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 @container">
        <DashboardHero />
        {/* The design's two columns under the hero: what came in today, and what's running. */}
        <div className="grid gap-x-8 gap-y-2 @min-[768px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <DashboardToday />
          <ActiveDownloadsSection />
        </div>
        <UsagePanel merging={merging} />
        <div className="grid gap-x-8 @min-[900px]:grid-cols-2">
          <NetworksSection
            onOpenLimits={(page) => {
              setLimitsPage(page)
              setLimitsOpen(true)
            }}
          />
          <FailoverSection mergeLinks={merging ? snapshot.links : []} />
        </div>
        <OtherAppsSection snapshot={snapshot} />
        <section aria-label="About combined speed">
          <SectionHeading label="About combined speed" />
          <ul className="grid gap-x-8 gap-y-4 pt-4 @min-[900px]:grid-cols-2">
            {HONEST_LIMITS.map((limit) => (
              <li key={limit.title} className="flex max-w-[62ch] flex-col gap-1">
                <p className="text-[13px] leading-[1.35] font-semibold">{limit.title}</p>
                <p className={bodyClass}>{limit.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <LimitsDialog
        open={limitsOpen}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </div>
  )
}

/** The instrument a download's screen opens on, for every running download at once: each
 * network flowing into one stream, the total, and the last minute split by network. */
function DashboardHero(): React.JSX.Element {
  const formatSpeedLimit = useFormatSpeedLimit()
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const speedLimit = useAppStore((store) => store.speedLimit)
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const networkVisual = useNetworkVisuals()
  const { lanes, summaries, active, progress } = useMergeLanes()
  const running = active.running.length > 0
  const history = combinedHistory(downloads)

  // The chart draws the networks that carried something in the last minute, in the list's order.
  const charted = summaries.filter((network) => history[network.id]?.some((value) => value > 0))
  const speedCap = slowMode
    ? `Slow mode: ${formatSpeedLimit(slowModeSpeed)}`
    : speedLimit !== undefined
      ? `Limited to ${formatSpeedLimit(speedLimit)}`
      : ''

  return (
    <div className="pt-5">
      <div className="flex items-center gap-[14px]">
        <div className="min-w-0 flex-[1.4]">
          <Confluence
            lanes={lanes.length > 0 ? lanes : PLACEHOLDER_LANES}
            idle={!running || lanes.length === 0}
            total={active.totalSpeed}
            caption={
              <span className="flex flex-col gap-0.5">
                <span>{progress}</span>
                {speedCap && <span>{speedCap}</span>}
              </span>
            }
          />
        </div>
        <div className="relative ml-auto max-w-[640px] min-w-0 flex-1">
          <div
            className={`transition-opacity duration-200 ${running ? 'opacity-100' : 'opacity-45'}`}
          >
            <h3 className="text-[12.5px] leading-none font-[620] text-ink-2">Last minute</h3>
            <ThroughputChart
              order={charted.map((network) => {
                const visual = networkVisual(network.id, network.kind, network.osName)
                return { interfaceId: network.id, solid: visual.solid, name: visual.name }
              })}
              historyByInterface={history}
            />
          </div>
          {/* An empty grid alone reads as broken: say what will be drawn there. Not dimmed with
              the chart, so it stays readable. */}
          {charted.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[12px] text-[var(--text-secondary)]">
              Each network’s speed is drawn here while something downloads.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ActiveDownloadsSection(): React.JSX.Element {
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const setScreen = useAppStore((store) => store.setScreen)
  const openDownload = useAppStore((store) => store.openDownload)
  const setFilter = useAppStore((store) => store.setDownloadFilter)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const networkVisual = useNetworkVisuals()
  const active = activeDownloads(downloads)
  const listed = [...active.running, ...active.paused, ...active.queued]
  const waiting = [
    active.paused.length > 0 && `${active.paused.length} paused`,
    active.queued.length > 0 && `${active.queued.length} queued`
  ].filter(Boolean)

  return (
    <section aria-label="Active downloads">
      <SectionHeading label="Downloading" count={active.running.length}>
        {waiting.length > 0 && (
          <span className="font-mono text-[11.5px] leading-none text-muted-foreground">
            {waiting.join(' · ')}
          </span>
        )}
        {active.failed > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-[var(--color-danger)]"
            onClick={() => {
              setFilter('failed')
              setScreen('downloads')
            }}
          >
            <TriangleAlert data-icon="inline-start" aria-hidden />
            {active.failed} need{active.failed === 1 ? 's' : ''} attention
          </Button>
        )}
      </SectionHeading>
      {listed.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-5">
          <p className="text-[14px] font-semibold">Nothing downloading</p>
          <p className={`max-w-[460px] ${bodyClass}`}>
            Paste a link ({PASTE_SHORTCUT}) or drop a .torrent or .nzb anywhere in this window. Each
            download shows here with its speed on every network.
          </p>
          <Button type="button" className="mt-1" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
            <span className="ml-1 font-mono text-[11px] opacity-70">{NEW_SHORTCUT}</span>
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col py-1">
          {listed.map((download) => (
            <ActiveDownloadRow
              key={download.id}
              download={download}
              networkVisual={networkVisual}
              onOpen={() => openDownload(download.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function ActiveDownloadRow({
  download,
  networkVisual,
  onOpen
}: {
  download: DownloadState
  networkVisual: ResolveNetworkVisual
  onOpen: () => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const wanted = wantedBytes(download)
  const known = wanted > 0
  const percent = formatPercent(download.bytesDownloaded, wanted)
  const running = download.status === 'downloading'
  const sizes = known
    ? `${formatBytes(download.bytesDownloaded)} of ${formatBytes(wanted)}`
    : formatBytes(download.bytesDownloaded)
  const detail = running
    ? [
        known && `${percent}%`,
        sizes,
        download.timeLeftSeconds !== undefined && `${formatEta(download.timeLeftSeconds)} left`
      ]
        .filter(Boolean)
        .join(' · ')
    : download.status === 'paused'
      ? known
        ? `Paused at ${percent}% · ${sizes}`
        : `Paused · ${sizes}`
      : `Waiting for a turn · ${sizes}`

  return (
    <li className="group relative -mx-2 flex flex-col gap-1.5 rounded-lg px-2 py-2.5 transition-colors duration-100 focus-within:bg-secondary hover:bg-secondary active:bg-muted">
      <div className="flex min-w-0 items-center gap-3">
        {/* The whole row opens the download: this button's box stretches over it. */}
        <button
          type="button"
          onClick={onOpen}
          className="block min-w-0 truncate text-left font-sans text-[13.5px] leading-tight font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {download.fileName}
        </button>
        <span
          className={`ml-auto shrink-0 font-mono text-[12.5px] leading-none font-medium tabular-nums ${running ? '' : 'text-muted-foreground'}`}
        >
          {running
            ? formatSpeed(download.speedBytesPerSec)
            : download.status === 'paused'
              ? 'Paused'
              : 'Queued'}
        </span>
      </div>
      {/* Each network's share of the file in its color, as in the list. */}
      <div
        role="progressbar"
        aria-label={`${download.fileName} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        aria-valuetext={known ? `${percent}%` : sizes}
        className={`flex h-1 gap-[2px] overflow-hidden rounded-full bg-muted ${running ? '' : 'opacity-40'}`}
      >
        {known &&
          download.networks
            .filter((network) => network.bytesDownloaded > 0)
            .map((network) => (
              <div
                key={network.id}
                className="h-full transition-[width] duration-200 ease-out"
                style={{
                  width: `${Math.min(100, (network.bytesDownloaded / wanted) * 100)}%`,
                  background: networkVisual(network.id, network.kind, network.label).solid
                }}
              />
            ))}
      </div>
      <div className="truncate font-mono text-[11.5px] leading-tight text-muted-foreground">
        {detail}
      </div>
    </li>
  )
}

const CONDITION: Record<
  NetworkCondition,
  { icon: typeof CircleCheck; text: string; alert: boolean }
> = {
  up: { icon: CircleCheck, text: 'Up', alert: false },
  limited: { icon: Gauge, text: 'Limited', alert: false },
  paused: { icon: CirclePause, text: 'Paused: data limit reached', alert: true },
  unreachable: { icon: TriangleAlert, text: 'Can’t reach the server', alert: true },
  offline: { icon: Unplug, text: 'No connection', alert: true }
}

function NetworksSection({
  onOpenLimits
}: {
  onOpenLimits: (page: string | null) => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const formatSpeedLimit = useFormatSpeedLimit()
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesReady = useAppStore((store) => store.interfacesStatus === 'ready')
  const preferences = useAppStore((store) => store.networkPreferences)
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const networkVisual = useNetworkVisuals()
  // Only a network with a data limit needs its usage, to tell whether it's used up.
  const usage = useNetworkUsage(
    Object.values(preferences).some((preference) => preference.dataLimit !== undefined)
  )
  const networks = networkSummaries(interfaces, downloads, preferences, usage)

  return (
    <section aria-label="Networks">
      <SectionHeading label="Networks" count={interfaces.length}>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="-my-1 text-[12px] text-[var(--text-secondary)]"
          onClick={() => onOpenLimits(null)}
        >
          <Gauge data-icon="inline-start" aria-hidden />
          Speed &amp; data limits
        </Button>
      </SectionHeading>
      {networks.length === 0 ? (
        interfacesReady && (
          <div className="flex flex-col items-start gap-2 py-5">
            <p className="text-[14px] font-semibold">No networks connected</p>
            <p className={`max-w-[380px] ${bodyClass}`}>
              Mergelane needs at least one active network. Join a Wi-Fi network, plug in Ethernet,
              or connect your phone using USB tethering.
            </p>
            <div className="mt-1 flex gap-2">
              <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
                Scan again
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => window.mergelane.openNetworkSettings()}
              >
                Network settings
              </Button>
            </div>
          </div>
        )
      ) : (
        <ul className="flex flex-col">
          {networks.map((network) => (
            <NetworkLine
              key={network.id}
              network={network}
              visual={networkVisual(network.id, network.kind, network.osName)}
              speedText={
                network.condition === 'offline'
                  ? '—'
                  : network.speed > 0
                    ? formatSpeed(network.speed)
                    : 'Idle'
              }
              limitText={
                network.speedLimit === undefined
                  ? undefined
                  : `to ${formatSpeedLimit(network.speedLimit)}`
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function NetworkLine({
  network,
  visual,
  speedText,
  limitText
}: {
  network: NetworkSummary
  visual: ReturnType<ResolveNetworkVisual>
  speedText: string
  limitText?: string
}): React.JSX.Element {
  const condition = CONDITION[network.condition]
  const Icon = condition.icon
  return (
    <li
      aria-label={visual.name}
      className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-3 border-b-[0.5px] border-[var(--border-subtle)] py-2.5 last:border-b-0"
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{
          background: visual.solid,
          opacity: network.condition === 'offline' ? 0.35 : 1
        }}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13.5px] leading-tight font-medium">{visual.name}</span>
          {visual.name !== network.osName && (
            <span className="max-w-[110px] shrink-0 truncate rounded-[4px] border-[0.5px] border-border bg-foreground/5 px-1.5 font-mono text-[10.5px] text-muted-foreground">
              {network.osName}
            </span>
          )}
        </div>
        <div
          className={`flex items-center gap-1.5 text-[12px] leading-none ${condition.alert ? 'text-[var(--color-danger)]' : 'text-[var(--text-secondary)]'}`}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {condition.text}
            {network.condition === 'limited' && limitText ? ` ${limitText}` : ''}
          </span>
        </div>
      </div>
      <div
        className={`text-right font-mono text-[12.5px] font-medium whitespace-nowrap tabular-nums ${speedText === 'Idle' || speedText === '—' ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {speedText}
      </div>
    </li>
  )
}

/** Which networks dropped or came back, and what that left: a network the computer lost, as the
 * network list saw it since this window opened, and, while system merge is on, a link its helper
 * finds without internet. */
function FailoverSection({ mergeLinks }: { mergeLinks: SystemMergeLink[] }): React.JSX.Element {
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const interfaces = useAppStore((store) => store.interfaces)
  const events = useAppStore((store) => store.networkEvents)
  const networkVisual = useNetworkVisuals()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(interval)
  }, [])
  // Keep "Just now" honest for an event that has only just arrived.
  const latest = events.at(-1)?.at ?? 0
  const clock = Math.max(now, latest)

  const present = new Set(interfaces.map((iface) => iface.id))
  const name = (event: Pick<NetworkEvent, 'id' | 'kind' | 'osName'>): string =>
    networkVisual(event.id, event.kind, event.osName).name
  // Gone now: dropped and not back, whether the log or a download remembers it.
  const down = new Map<string, string>()
  for (const event of events) {
    if (event.change === 'dropped' && !present.has(event.id)) down.set(event.id, name(event))
    else down.delete(event.id)
  }
  for (const network of networkSummaries(interfaces, downloads, {}, {})) {
    if (network.condition === 'offline') {
      down.set(network.id, name({ id: network.id, kind: network.kind, osName: network.osName }))
    }
  }
  const downNames = [...down.values()]
  const upNames = interfaces.map((iface) => name({ ...iface, osName: iface.displayName }))

  let summary: string
  if (downNames.length > 0) {
    summary = `${listOf(downNames)} ${downNames.length === 1 ? 'is' : 'are'} gone. ${
      upNames.length > 0
        ? `Downloads carry on over ${listOf(upNames)}; connections that were open on the lost network had to reconnect.`
        : 'Downloads wait until a network is back, then pick up where they were.'
    }`
  } else if (interfaces.length === 0) {
    summary = 'No network is connected, so downloads wait until one is.'
  } else if (interfaces.length === 1) {
    summary = `Only ${upNames[0]} is connected, so there’s nothing to fail over to. Connect another network (Wi-Fi, Ethernet or a phone over USB) and downloads carry on over it if one drops.`
  } else {
    summary = `All ${interfaces.length} networks are connected. If one drops, downloads carry on over the others.`
  }

  // A link is one of the computer's networks, by device name.
  const linkName = (link: SystemMergeLink): string => {
    const iface = interfaces.find((candidate) => candidate.id === link.name)
    return iface ? name({ ...iface, osName: iface.displayName }) : link.name
  }
  const offline = mergeLinks.filter((link) => link.state === 'down').map(linkName)
  const mergeNote =
    offline.length === 0
      ? null
      : offline.length === mergeLinks.length
        ? 'System merge: no network has internet right now, so other apps can’t connect.'
        : `System merge: ${listOf(offline)} ${offline.length === 1 ? 'has' : 'have'} no internet, so other apps’ new connections use the other networks.`

  const recent = events.slice(-5).reverse()
  return (
    <section aria-label="Failover">
      <SectionHeading label="Failover" />
      <p className={`max-w-[62ch] pt-3 ${bodyClass}`}>{summary}</p>
      {mergeNote && (
        <p className="flex max-w-[62ch] items-start gap-1.5 pt-2 text-[12.5px] leading-[1.6] text-[var(--color-danger)]">
          <TriangleAlert aria-hidden className="mt-[3px] size-3.5 shrink-0" />
          {mergeNote}
        </p>
      )}
      {/* A log: a screen reader hears each new change once, not every second of the rest. */}
      <div role="log" aria-label="Network changes">
        {recent.length === 0 ? (
          <p className="pt-2 text-[12px] text-muted-foreground">
            No network has dropped since Mergelane opened.
          </p>
        ) : (
          <ul className="flex flex-col pt-2">
            {recent.map((event) => {
              const lost = event.change === 'dropped'
              const Icon = lost ? Unplug : Plug
              return (
                <li
                  key={`${event.id}-${event.at}-${event.change}`}
                  className="flex items-center gap-2 py-1.5 text-[12.5px]"
                >
                  <Icon
                    aria-hidden
                    className={`size-3.5 shrink-0 ${lost ? 'text-[var(--color-danger)]' : 'text-[var(--text-secondary)]'}`}
                  />
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{name(event)}</span>{' '}
                    {lost
                      ? `dropped, ${event.left === 0 ? 'no network left' : `${event.left} left`}`
                      : event.change === 'recovered'
                        ? `came back after ${formatDowntime(event.downForMs ?? 0)}`
                        : 'connected'}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatWhen(event.at, clock)}
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

/** "Wi-Fi", "Wi-Fi and Ethernet", "Wi-Fi, USB and Ethernet". */
function listOf(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** System-wide merging: its switch exactly as the networks menu has it, then each link's merged
 * traffic over the last minute while it's on. */
function OtherAppsSection({
  snapshot
}: {
  snapshot: SystemMergeSnapshot | null
}): React.JSX.Element {
  const [seen, setSeen] = useState(snapshot)
  const [history, setHistory] = useState<Record<string, number[]>>({})
  const on = snapshot?.reachable === true && snapshot.state === 'on'
  // A sample a second, as each snapshot arrives; a fresh start once merging goes off.
  if (snapshot !== seen) {
    setSeen(snapshot)
    setHistory((previous) => (on && snapshot ? appendLinkSamples(previous, snapshot.links) : {}))
  }

  return (
    <section aria-label="Other apps">
      <SectionHeading label="Other apps" />
      <p className={`max-w-[62ch] pt-3 ${bodyClass}`}>
        Mergelane’s own downloads use every network without this. System merge lets other apps’
        connections use them too.
      </p>
      {/* The section's own top rule would double the well's border. */}
      <div className="mt-3 overflow-hidden rounded-lg border-[0.5px] border-border bg-card [&>*:first-child]:border-t-0">
        <SystemMergeSection open />
        {on && snapshot && snapshot.links.length > 0 ? (
          <MergedTraffic links={snapshot.links} history={history} />
        ) : (
          snapshot?.reachable &&
          !on && (
            <p className="border-t-[0.5px] border-border px-4 py-3 text-[12px] text-muted-foreground">
              While it’s on, each network’s merged traffic shows here.
            </p>
          )
        )}
      </div>
    </section>
  )
}

function MergedTraffic({
  links,
  history
}: {
  links: SystemMergeLink[]
  history: Record<string, number[]>
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const speedUnit = useAppStore((store) => store.speedUnit)
  const interfaces = useAppStore((store) => store.interfaces)
  const downloads = useAppStore((store) => store.downloads)
  const networkVisual = useNetworkVisuals()
  const [hovered, setHovered] = useState<{ link: string; index: number } | null>(null)

  // A link is one of the computer's networks, by device name: it keeps that network's color. One
  // the window doesn't know takes the next color no network has, a gone one a download still
  // lists included, so a network dropping doesn't repaint the links.
  const known = new Map(
    interfaces.map((iface) => [iface.id, networkVisual(iface.id, iface.kind, iface.displayName)])
  )
  const taken = new Set([
    ...[...known.values()].map((visual) => visual.colorId),
    ...Object.values(downloads).flatMap((download) =>
      download.networks.map(
        (network) => networkVisual(network.id, network.kind, network.label).colorId
      )
    )
  ])
  const spare = NETWORK_COLOR_SWATCHES.filter((swatch) => !taken.has(swatch.id))
  let nextSpare = 0
  const charts = links.map((link) => {
    const visual = known.get(link.name)
    const values = history[link.name] ?? []
    return {
      link,
      values,
      peak: Math.max(0, ...values),
      name: visual?.name ?? link.name,
      solid:
        visual?.solid ??
        (spare[nextSpare++] ?? NETWORK_COLOR_SWATCHES[links.indexOf(link) % 8]).solid
    }
  })
  // One scale for every link, so their heights compare.
  const { top } = speedTicks(Math.max(0, ...charts.map((chart) => chart.peak)), speedUnit)

  return (
    <section
      aria-label="Merged traffic by network"
      className="flex flex-col gap-3 border-t-[0.5px] border-border px-4 py-3"
    >
      <p className="text-[11.5px] text-muted-foreground">
        Merged download traffic, last {SPEED_HISTORY_SECONDS} seconds
      </p>
      <ul className="grid gap-x-6 gap-y-3 @min-[900px]:grid-cols-2">
        {charts.map(({ link, values, peak, name, solid }) => {
          const index = hovered?.link === link.name ? hovered.index : null
          return (
            <li key={link.name} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2 text-[12px]">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: solid }}
                />
                <span className="truncate font-medium">{name}</span>
                {link.state !== 'up' && (
                  <span className="flex shrink-0 items-center gap-1 text-[var(--color-danger)]">
                    <TriangleAlert aria-hidden className="size-3" />
                    {link.state === 'down' ? 'No internet' : 'Checking'}
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {index !== null
                    ? `${values.length - 1 - index === 0 ? 'now' : `${values.length - 1 - index}s ago`} ${formatSpeed(values[index])}`
                    : `peak ${formatSpeed(peak)}`}
                </span>
              </div>
              <Sparkline
                values={values}
                top={top}
                color={solid}
                label={`${name}: ${formatSpeed(link.rxBps)} merged now, peak ${formatSpeed(peak)} in the last minute`}
                hovered={index}
                onHover={(next) =>
                  setHovered(next === null ? null : { link: link.name, index: next })
                }
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
