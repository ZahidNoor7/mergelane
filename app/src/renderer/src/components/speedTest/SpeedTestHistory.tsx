import type { SpeedTestRun } from '@shared/speedTest'
import { cn } from 'cn'
import { useState } from 'react'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import type { NetworkVisual } from '../../theme'
import { useAppStore } from '../../store/useAppStore'
import { formatSpeed } from '../../utils/format'
import {
  downloadTrend,
  formatMs,
  formatWhen,
  scopeLabel,
  testedNetworks
} from '../../utils/speedTest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button, buttonVariants } from '../ui/button'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

// Past speed tests (ADR-0064), newest first: pick one to see its results above; pick a network to
// see only the tests that measured it, with its download speed across them.

const ALL = '*'

/** A run's headline figures: the total's, or the first finished network's. */
function headline(run: SpeedTestRun): {
  download?: number
  upload?: number
  latency?: number
} {
  if (run.combined) {
    return {
      download: run.combined.downloadBytesPerSec,
      upload: run.combined.uploadBytesPerSec,
      latency:
        run.combined.latencyMs ?? run.links.find((link) => link.latencyMs !== undefined)?.latencyMs
    }
  }
  const link = run.links.find((each) => each.status === 'done') ?? run.links[0]
  return {
    download: link?.downloadBytesPerSec,
    upload: link?.uploadBytesPerSec,
    latency: link?.latencyMs
  }
}

export function SpeedTestHistory({
  runs,
  shownId,
  onShow,
  onClear,
  disabled = false
}: {
  runs: SpeedTestRun[]
  shownId: string | null
  onShow: (id: string) => void
  onClear: () => Promise<void>
  disabled?: boolean
}): React.JSX.Element {
  const unit = useAppStore((store) => store.speedUnit)
  const networkVisual = useNetworkVisuals()
  const [filter, setFilter] = useState(ALL)
  const [confirming, setConfirming] = useState(false)
  // When the view opened: "Today" and "Yesterday" are said from then.
  const [now] = useState(() => Date.now())
  const networks = testedNetworks(runs)
  const visualOf = (id: string): NetworkVisual => {
    const link = networks.find((each) => each.networkId === id)
    return networkVisual(id, link?.kind ?? 'other', link?.name ?? id)
  }
  const shown =
    filter === ALL
      ? runs
      : runs.filter((run) => run.links.some((link) => link.networkId === filter))
  const trend = filter === ALL ? [] : downloadTrend(runs, filter)
  const top = Math.max(1, ...trend)

  return (
    <section aria-labelledby="speed-history" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="speed-history" className="flex-1 text-[14px] font-[650]">
          History
        </h2>
        {runs.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Clear history…
          </Button>
        )}
      </div>

      {runs.length === 0 ? (
        <p className="py-2 text-[12.5px] text-ink-3">
          No tests yet. Start one above; each test is kept here for 90 days.
        </p>
      ) : (
        <>
          {networks.length > 1 && (
            <ToggleGroup
              aria-label="Show tests of"
              value={[filter]}
              onValueChange={(values) => {
                if (values[0] !== undefined) setFilter(values[0])
              }}
              size="xs"
              spacing={0.5}
              className="flex-wrap"
            >
              <ToggleGroupItem value={ALL}>All tests</ToggleGroupItem>
              {networks.map((link) => (
                <ToggleGroupItem key={link.networkId} value={link.networkId}>
                  {visualOf(link.networkId).name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {trend.length > 1 && (
            <figure className="flex flex-col gap-1">
              <div
                role="img"
                aria-label={`${visualOf(filter).name}’s download speed in its last ${trend.length} tests, oldest first: ${trend
                  .map((speed) => formatSpeed(speed, unit))
                  .join(', ')}`}
                className="flex h-10 items-end gap-1"
              >
                {trend.map((speed, index) => (
                  <span
                    key={index}
                    className="w-3 rounded-t-[3px]"
                    style={{
                      height: `${Math.max(8, (speed / top) * 100)}%`,
                      background: visualOf(filter).solid
                    }}
                  />
                ))}
              </div>
              <figcaption className="text-[12px] text-ink-3">
                Download speed, oldest to newest
              </figcaption>
            </figure>
          )}

          <ul aria-label="Past tests" className="flex flex-col">
            {shown.map((run) => {
              const { download, upload, latency } = headline(run)
              const selected = run.id === shownId
              return (
                <li key={run.id} className="border-b border-rule last:border-b-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onShow(run.id)}
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-[8px] px-2 py-2 text-left outline-offset-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-[var(--focus)] @min-[560px]:grid-cols-[minmax(0,1fr)_repeat(3,6.5rem)]',
                      selected && 'bg-selected hover:bg-selected'
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-[600]">
                        {formatWhen(run.startedAt, now)}
                      </span>
                      <span className="truncate text-[12px] text-ink-3">
                        {scopeLabel(run.scope)}
                        {run.status === 'failed' ? ', failed' : ''}
                        {run.scope === 'link' && run.links.length > 0
                          ? `: ${run.links.map((link) => visualOf(link.networkId).name).join(', ')}`
                          : ''}
                      </span>
                    </span>
                    <Figure
                      label="Download"
                      text={download === undefined ? '—' : formatSpeed(download, unit)}
                    />
                    <Figure
                      label="Upload"
                      text={upload === undefined ? '—' : formatSpeed(upload, unit)}
                      wide
                    />
                    <Figure label="Ping" text={formatMs(latency)} wide />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear speed test history?</AlertDialogTitle>
            <AlertDialogDescription>
              Every past test is removed from this Mac. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                setConfirming(false)
                void onClear()
              }}
            >
              Clear history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** One figure of a past test, under its name; upload and ping only in a wide view. */
function Figure({
  label,
  text,
  wide = false
}: {
  label: string
  text: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <span className={cn('flex flex-col items-end', wide && 'hidden @min-[560px]:flex')}>
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <span className="figures text-[13px] font-[600]">{text}</span>
    </span>
  )
}
