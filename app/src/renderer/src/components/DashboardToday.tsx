import { DROPOUT_WINDOW_MS, dropoutsSince, fastestToday } from '@shared/networkActivity'
import { useEffect, useState } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { todayTotals } from '../utils/dashboard'
import { formatBytes } from '../utils/format'

// The Dashboard's "Today", from the final design (prototype.html, DashboardScreen): what Mergelane
// downloaded today, split by the network that brought it, the fastest merged speed of the day, and
// how many networks dropped in the last 24 hours. The dropouts and the fastest speed are kept by
// the main process across restarts (ADR-0042), as finished downloads are.

export function DashboardToday(): React.JSX.Element {
  const downloads = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const events = useAppStore((store) => store.networkEvents)
  const fastestMerged = useAppStore((store) => store.fastestMerged)
  const networkVisual = useNetworkVisuals()
  const formatSpeed = useFormatSpeed()
  // Today moves on at midnight.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const today = todayTotals(Object.values(downloads), history, now)
  // Merged over every running download, and never below what one download held on its own.
  const merged = fastestToday(fastestMerged, now)
  const fastest =
    merged === undefined && today.fastest === undefined
      ? undefined
      : Math.max(merged ?? 0, today.fastest ?? 0)
  const dropouts = dropoutsSince(events, now - DROPOUT_WINDOW_MS)

  return (
    <section aria-labelledby="dashboard-today" className="flex flex-col gap-3">
      {/* As the Dashboard's other section headings: on a rule. */}
      <h2
        id="dashboard-today"
        className="flex min-h-7 items-center border-b border-rule pt-7 pb-2 text-[13px] font-[650] tracking-[-0.005em]"
      >
        Today
      </h2>
      <p className="flex items-baseline gap-2">
        <span className="figures text-[34px] leading-none font-[700] tracking-[-0.02em]">
          {formatBytes(today.total)}
        </span>
        <span className="text-[13px] text-ink-2">downloaded</span>
      </p>
      {today.total > 0 && (
        <div
          aria-hidden
          className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-track"
        >
          {today.byNetwork.map((network) => (
            <span
              key={network.id}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${(network.bytes / today.total) * 100}%`,
                background: networkVisual(network.id, network.kind, network.label).solid
              }}
            />
          ))}
        </div>
      )}
      {today.byNetwork.length > 0 && (
        <ul aria-label="Downloaded today, by network" className="flex flex-col">
          {today.byNetwork.map((network) => {
            const visual = networkVisual(network.id, network.kind, network.label)
            return (
              <li
                key={network.id}
                className="flex items-center gap-2.5 border-b border-rule py-1.5 text-[13px] last:border-b-0"
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: visual.solid }}
                />
                <span className="flex-1 font-[560]">{visual.name}</span>
                <span className="figures text-[14px] font-[600]">{formatBytes(network.bytes)}</span>
                <span className="figures w-10 text-right text-[13px] text-ink-3">
                  {Math.round((network.bytes / today.total) * 100)}%
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <dl className="grid grid-cols-2 gap-4 pt-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[12px] text-ink-3">Fastest merged speed</dt>
          <dd className="figures truncate text-[17px] leading-tight font-[640]">
            {fastest === undefined ? '—' : formatSpeed(fastest)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[12px] text-ink-3">Network dropouts</dt>
          <dd className="figures truncate text-[17px] leading-tight font-[640]">
            {dropouts.count}
            {dropouts.count > 0 && dropouts.allBack ? ', all back' : ''}
          </dd>
        </div>
      </dl>
    </section>
  )
}
