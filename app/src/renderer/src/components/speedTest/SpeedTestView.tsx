import {
  MAX_BYTES_PER_NETWORK,
  speedTestServer,
  type SpeedTestLive,
  type SpeedTestRun,
  type SpeedTestScope
} from '@shared/speedTest'
import type { NetworkInterfaceKind } from '@shared/types'
import { cn } from 'cn'
import { Check, ChevronLeft, CircleAlert, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import { useSpeedTest } from '../../hooks/useSpeedTest'
import { useSystemMerge } from '../../hooks/useSystemMerge'
import { useAppStore } from '../../store/useAppStore'
import { formatBytes, formatSpeed } from '../../utils/format'
import {
  dialMax,
  formatMs,
  noteText,
  PHASES,
  phaseLabel,
  SCOPE_CHOICES
} from '../../utils/speedTest'
import { NetworkTile } from '../NetworkTile'
import { SplitBar } from '../SplitBar'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SpeedGauge } from './SpeedGauge'
import { SpeedTestHistory } from './SpeedTestHistory'
import { SpeedTestResults } from './SpeedTestResults'

// Networks › Speed test (ADR-0064): measure each network on its own, all of them together as
// Mergelane's downloads use them, or what other apps get through system merge. Every figure comes
// from the main process, which measures for real (main/speedTest); nothing here is estimated.

const CONNECTION_TYPE: Record<NetworkInterfaceKind, string> = {
  wifi: 'Wi-Fi',
  usb: 'Tethered over USB',
  ethernet: 'Ethernet',
  bridge: 'Bridge',
  other: 'Other connection'
}

/** The server the test uses, shown by its host. */
function hostOf(server: string): string {
  try {
    return new URL(server).host
  } catch {
    return server
  }
}

const DEFAULT_HOST = 'speed.cloudflare.com'

/** The most one network's test may take, as "200 MB". */
const dataCap = formatBytes(MAX_BYTES_PER_NETWORK).replace('.0 ', ' ')

export function SpeedTestView(): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const focus = useAppStore((store) => store.speedTest.networkId)
  const close = useAppStore((store) => store.closeSpeedTest)
  const downloads = useAppStore((store) => store.downloads)
  const networkVisual = useNetworkVisuals()
  const test = useSpeedTest()
  const { live } = test
  // The view says where it is: keyboard focus starts on its title, as on the Dashboard.
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])
  const [picking, setScope] = useState<SpeedTestScope>('link')
  // A test already running when the view opened shows as what it is.
  const scope = live?.scope ?? picking
  // Every connected network unless the view was opened from one.
  const [picked, setPicked] = useState<string[] | null>(focus ? [focus] : null)
  const [shownId, setShownId] = useState<string | null>(null)
  const merge = useSystemMerge(scope === 'system' && !live)
  const running = live !== null
  const chosen = (picked ?? interfaces.map((iface) => iface.id)).filter((id) =>
    interfaces.some((iface) => iface.id === id)
  )
  // Those running pause; those waiting go on waiting (DownloadManager.holdForSpeedTest).
  const active = Object.values(downloads).filter(
    (download) => download.status === 'downloading'
  ).length

  const systemReady = merge.snapshot?.state === 'on'
  const systemWhy = !merge.snapshot
    ? 'Checking system merge…'
    : !merge.snapshot.installed
      ? 'Needs the system-wide helper. Set it up in Networks › Other apps.'
      : merge.snapshot.state !== 'on'
        ? (merge.snapshot.reason ?? 'Turn on system merge in Networks › Other apps first.')
        : null
  const canStart =
    !running && (scope === 'system' ? systemReady : chosen.length > 0 && interfaces.length > 0)

  // The test picked in History; else the one that just ended (kept or not), straight away rather
  // than once History has reloaded; else the newest kept.
  const shown = test.history.find((run) => run.id === shownId) ?? test.last ?? test.history[0]
  const startTest = (): void => {
    setShownId(null)
    void test.start({ scope, networkIds: scope === 'system' ? [] : chosen })
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="window-drag flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={close} className="-ml-2">
          <ChevronLeft data-icon="inline-start" />
          Networks
        </Button>
        <div className="min-w-0 flex-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em] outline-none"
          >
            Speed test
          </h1>
          <p className="truncate text-[12px] leading-snug text-ink-3">
            How fast each network really is, and what they make together.
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="flex max-w-[860px] flex-col gap-8 px-4 pt-4 pb-8">
          <section
            aria-label="Test"
            className="grid gap-6 rounded-[14px] bg-card p-4 shadow-[inset_0_0_0_1px_var(--border)] @min-[672px]:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @min-[672px]:items-start"
          >
            <LivePanel live={live} shown={shown} />
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-2">
                <ToggleGroup
                  aria-label="What to test"
                  value={[scope]}
                  onValueChange={(values) => {
                    if (values[0] !== undefined) setScope(values[0] as SpeedTestScope)
                  }}
                  size="sm"
                  spacing={0.5}
                  disabled={running}
                  className="flex-wrap"
                >
                  {SCOPE_CHOICES.map((choice) => (
                    <ToggleGroupItem key={choice.scope} value={choice.scope}>
                      {choice.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="max-w-[56ch] text-[12.5px] leading-[1.5] text-ink-2">
                  {SCOPE_CHOICES.find((choice) => choice.scope === scope)?.hint}
                </p>
              </div>

              {scope === 'system' ? (
                <p
                  className={cn(
                    'flex items-start gap-1.5 text-[12.5px] leading-[1.5]',
                    systemWhy ? 'text-ink-2' : 'text-ink-3'
                  )}
                >
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {systemWhy ??
                    'With “Keep each site on one network” on, the test reaches one network, as one website would.'}
                </p>
              ) : interfaces.length === 0 ? (
                <p className="text-[12.5px] text-ink-2">
                  No network is connected. Connect one to test it.
                </p>
              ) : (
                <fieldset className="flex flex-col gap-1.5" disabled={running}>
                  <legend className="mb-1 text-[12.5px] font-[620]">Networks</legend>
                  {interfaces.map((iface) => {
                    const visual = networkVisual(iface.id, iface.kind, iface.displayName)
                    const checked = chosen.includes(iface.id)
                    return (
                      <label
                        key={iface.id}
                        className="flex items-center gap-2.5 rounded-[8px] py-1 text-[13px]"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={running}
                          onCheckedChange={(on) =>
                            setPicked(
                              on ? [...chosen, iface.id] : chosen.filter((id) => id !== iface.id)
                            )
                          }
                        />
                        <NetworkTile
                          kind={iface.kind}
                          color={visual.solid}
                          onColor={visual.onSolid}
                          size={22}
                        />
                        <span className="font-[600]">{visual.name}</span>
                        <span className="truncate text-[12px] text-ink-3">
                          {CONNECTION_TYPE[iface.kind]}
                        </span>
                      </label>
                    )
                  })}
                </fieldset>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {running ? (
                  <Button type="button" variant="secondary" onClick={test.cancel}>
                    Stop test
                  </Button>
                ) : (
                  <Button type="button" onClick={startTest} disabled={!canStart}>
                    Start test
                  </Button>
                )}
                <span className="text-[12px] leading-[1.5] text-ink-3">
                  {scope === 'system'
                    ? `Uses up to ${dataCap} in all.`
                    : `Uses up to ${dataCap} on each network. A phone’s share counts against its data plan.`}
                </span>
              </div>
              {!running && active > 0 && (
                <p className="text-[12px] text-ink-3">
                  {active === 1
                    ? 'Your download pauses while the test runs, and resumes after it.'
                    : `Your ${active} downloads pause while the test runs, and resume after them.`}
                </p>
              )}
              {test.error && (
                <p
                  role="alert"
                  className="flex items-center gap-1.5 text-[12.5px] text-destructive"
                >
                  <CircleAlert aria-hidden className="size-3.5 shrink-0" />
                  {test.error}
                </p>
              )}
            </div>
          </section>

          {((live?.results.length ?? 0) > 0 || shown !== undefined) && (
            <SpeedTestResults
              run={live && live.results.length > 0 ? liveRun(live) : (shown ?? null)}
              runs={test.history}
              partial={live !== null && live.results.length > 0}
            />
          )}

          <SpeedTestHistory
            runs={test.history}
            shownId={shown?.id ?? null}
            onShow={setShownId}
            onClear={test.clearHistory}
            disabled={running}
          />

          <ServerNote />
        </div>
      </div>
    </div>
  )
}

/** A test still running, as a run of the networks finished so far. */
function liveRun(live: SpeedTestLive): SpeedTestRun {
  return {
    id: live.runId,
    scope: live.scope,
    server: '',
    startedAt: live.startedAt,
    finishedAt: live.startedAt,
    status: 'done',
    links: live.results,
    notes: []
  }
}

/** The dial, what it's measuring, and the steps of the test. */
function LivePanel({
  live,
  shown
}: {
  live: SpeedTestLive | null
  shown: SpeedTestRun | undefined
}): React.JSX.Element {
  const unit = useAppStore((store) => store.speedUnit)
  const interfaces = useAppStore((store) => store.interfaces)
  const networkVisual = useNetworkVisuals()
  const reading = live?.phase === 'latency' ? 0 : (live?.bytesPerSec ?? 0)

  const network = live?.networkId
    ? interfaces.find((iface) => iface.id === live.networkId)
    : undefined
  const visual = network && networkVisual(network.id, network.kind, network.displayName)
  const color = visual?.solid ?? 'var(--color-accent)'

  // Idle: the last test's download, faded.
  const headline =
    shown?.combined?.downloadBytesPerSec ??
    shown?.links.find((link) => link.downloadBytesPerSec !== undefined)?.downloadBytesPerSec
  const [figure, figureUnit] =
    live?.phase === 'latency'
      ? [live.latencyMs === undefined ? '—' : formatMs(live.latencyMs).split(' ')[0], 'ms ping']
      : live
        ? formatSpeed(live.bytesPerSec, unit).split(' ')
        : headline !== undefined
          ? formatSpeed(headline, unit).split(' ')
          : ['—', unit === 'bits' ? 'Mbps' : 'MB/s']
  const caption = live ? phaseLabel(live.phase) : headline !== undefined ? 'Last download' : 'Ready'
  const doing = !live
    ? ''
    : live.scope === 'system'
      ? 'Testing through system merge'
      : live.scope === 'combined' && !live.networkId
        ? 'Testing every network together'
        : `Testing ${visual?.name ?? live.networkId ?? ''}${
            live.networkIds.length > 1 && live.networkId
              ? ` (${live.networkIds.indexOf(live.networkId) + 1} of ${live.networkIds.length})`
              : ''
          }`
  // The scale only grows during a test, so the arc never jumps back as it rescales.
  const max = dialMax(live ? Math.max(live.peakBytesPerSec, reading) : (headline ?? 0))
  const shares = live ? Object.entries(live.share) : []
  const total = shares.reduce((sum, [, bytes]) => sum + bytes, 0)

  return (
    <div className="flex flex-col gap-3">
      <SpeedGauge
        bytesPerSec={live ? reading : (headline ?? 0)}
        max={max}
        color={color}
        reading={figure}
        unit={figureUnit}
        caption={caption}
        label="Speed"
        valueText={`${caption}: ${figure} ${figureUnit}`}
        dim={!live}
      />
      {live && live.scope !== 'link' && total > 0 && (
        <SplitBar
          label="Each network’s part"
          valueText={shares
            .map(([id, bytes]) => {
              const iface = interfaces.find((each) => each.id === id)
              const name = iface ? networkVisual(id, iface.kind, iface.displayName).name : id
              return `${name} ${Math.round((bytes / total) * 100)}%`
            })
            .join(', ')}
          percent={100}
          segments={shares.map(([id, bytes]) => {
            const iface = interfaces.find((each) => each.id === id)
            return {
              id,
              share: bytes / total,
              color: iface
                ? networkVisual(id, iface.kind, iface.displayName).solid
                : 'var(--track-bg)'
            }
          })}
        />
      )}
      <ol aria-label="Steps" className="flex justify-between gap-2">
        {PHASES.map((phase) => {
          const index = PHASES.indexOf(phase)
          const at = live ? PHASES.indexOf(live.phase) : -1
          const state = !live ? 'waiting' : index < at ? 'done' : index === at ? 'now' : 'waiting'
          return (
            <li
              key={phase}
              aria-current={state === 'now' ? 'step' : undefined}
              className="flex min-w-0 flex-1 flex-col gap-1"
            >
              <span
                className={cn(
                  'flex items-center gap-1 text-[12px] font-[600]',
                  state === 'waiting' ? 'text-ink-3' : 'text-foreground'
                )}
              >
                {state === 'done' && <Check aria-label="Done" className="size-3" />}
                {phaseLabel(phase)}
              </span>
              <span aria-hidden className="h-1 overflow-hidden rounded-full bg-track">
                <span
                  className="block h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-150 motion-reduce:transition-none"
                  style={{
                    width: `${state === 'done' ? 100 : state === 'now' ? Math.round((live?.fraction ?? 0) * 100) : 0}%`
                  }}
                />
              </span>
            </li>
          )
        })}
      </ol>
      <p role="status" className="text-[12.5px] text-ink-2 empty:hidden">
        {live ? `${doing}: ${phaseLabel(live.phase).toLowerCase()}` : ''}
      </p>
      {live && live.pausedDownloads > 0 && (
        <p className="text-[12px] text-ink-3">
          {noteText('downloads-paused', live.pausedDownloads)}
        </p>
      )}
    </div>
  )
}

/** Where the test goes, and a way to change it. */
function ServerNote(): React.JSX.Element {
  // From the store, so it says the server in use however often the view is opened.
  const saved = useAppStore((store) => store.speedTestServer)
  const setSaved = useAppStore((store) => store.setSpeedTestServer)
  const server = saved ?? `https://${DEFAULT_HOST}`
  const [draft, setDraft] = useState(server)
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const save = (value: string | undefined): void => {
    const next = value === undefined ? undefined : speedTestServer(value)
    if (value !== undefined && !next) return setInvalid(true)
    setInvalid(false)
    setDraft(next ?? `https://${DEFAULT_HOST}`)
    setOpen(false)
    setSaved(next)
  }
  const host = hostOf(server)
  return (
    <aside className="flex gap-3 rounded-[14px] bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
      <div className="flex max-w-[62ch] flex-col gap-1.5">
        <p className="text-[13.5px] font-[620]">
          Tests download from and upload to <span className="font-mono text-[12.5px]">{host}</span>.
        </p>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {host === DEFAULT_HOST
            ? 'Cloudflare’s public speed test. It sees your IP address, as any website does. Mergelane sends it nothing else, and only when you start a test.'
            : 'Your own server. It must answer GET /__down?bytes= and POST /__up, as Cloudflare’s does.'}
        </p>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            // Opened again, it starts from the server in use, not an abandoned edit.
            if (next) {
              setDraft(server)
              setInvalid(false)
            }
          }}
        >
          <PopoverTrigger
            render={
              <Button type="button" variant="ghost" size="xs" className="-ml-2.5 self-start">
                Change server…
              </Button>
            }
          />
          <PopoverContent align="start" className="w-80">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                save(draft)
              }}
            >
              <PopoverTitle className="text-[13px] font-[620]">Speed test server</PopoverTitle>
              <Input
                aria-label="Server address"
                aria-invalid={invalid || undefined}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setInvalid(false)
                }}
                className="font-mono text-[12.5px]"
              />
              {invalid && (
                <p className="text-[12px] text-destructive">
                  Enter an address that starts with https:// or http://
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => save(undefined)}>
                  Use Cloudflare
                </Button>
                <Button type="submit" size="sm">
                  Save
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      </div>
    </aside>
  )
}
