import { SPEED_HISTORY_SECONDS } from '@shared/types'
import { useState } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useAppStore } from '../store/useAppStore'
import { speedTicks } from '../utils/format'

const WIDTH = 560
const HEIGHT = 130
const labelClass = 'figures text-[11.5px] leading-none text-ink-3'

interface ThroughputChartProps {
  order: Array<{ interfaceId: string; solid: string; name: string }>
  historyByInterface: Record<string, number[]>
  /** Where the minute ends: now, or — the history only grows while it downloads — where it
   * paused, or where it finished. So a paused download's last speed never reads as "now". */
  endsAt?: 'now' | 'pause' | 'end'
}

/** Stacked area chart of recent throughput, split by network, as in the final design
 * (design-system/mergelane/redesign/prototype.html, ThroughputChart): solid fills parted by 2px lines
 * in the ground colour, the merged total in ink, a scale to read it by, a time axis, and every
 * network's speed at the second pointed at — by the mouse, or by the arrow keys once focused. */
export function ThroughputChart({
  order,
  historyByInterface,
  endsAt = 'now'
}: ThroughputChartProps): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const speedUnit = useAppStore((store) => store.speedUnit)
  // The second under the pointer, as a slot of the minute (0 = a minute ago, last = now).
  const [hovered, setHovered] = useState<number | null>(null)
  const length = Math.max(
    0,
    ...order.map((entry) => historyByInterface[entry.interfaceId]?.length ?? 0)
  )

  const totals = Array.from({ length }, (_, i) =>
    order.reduce((sum, entry) => sum + (historyByInterface[entry.interfaceId]?.[i] ?? 0), 0)
  )
  // Round steps to read values off, the top just clearing the fastest second: it moves less than
  // a scale topped by the data itself, and every gridline means a number.
  const { top, ticks } = speedTicks(Math.max(0, ...totals), speedUnit)
  // Fewer than two samples draws no area at all — but the empty gridlines still render, so the
  // chart keeps its height. It's the tallest thing in the hero band, and bailing out to `null`
  // for the first second of a download (or after a resume re-keys the history) collapsed the
  // band and shoved the whole screen up, then back down again.
  // A fixed minute, newest at the right edge, as Activity Monitor and Task Manager draw it: a
  // second is always the same width, so the shape only scrolls, and the first few seconds sit at
  // the right with the rest still empty instead of being stretched across the whole chart.
  const xStep = WIDTH / (SPEED_HISTORY_SECONDS - 1)
  const firstSlot = SPEED_HISTORY_SECONDS - length
  const firstX = firstSlot * xStep
  const toY = (value: number): number => HEIGHT - (value / top) * HEIGHT

  interface Layer {
    solid: string
    points: string
    /** The layer's top edge, where the next one starts: drawn as a separator. */
    edge: string
  }
  const toPoint = (value: number, i: number): string =>
    `${(firstX + i * xStep).toFixed(1)},${toY(value).toFixed(1)}`
  const { layers } = order.reduce<{ cumulative: number[]; layers: Layer[] }>(
    (acc, entry) => {
      const series = historyByInterface[entry.interfaceId] ?? []
      const bottom = acc.cumulative
      const top = bottom.map((value, i) => value + (series[i] ?? 0))
      const edge = top.map(toPoint).join(' ')
      const points = [edge, ...bottom.map(toPoint).reverse()].join(' ')
      return { cumulative: top, layers: [...acc.layers, { solid: entry.solid, points, edge }] }
    },
    { cumulative: new Array<number>(length).fill(0), layers: [] }
  )

  const outline = totals.map(toPoint).join(' ')

  const peakTotal = Math.max(0, ...totals)
  const latestTotal = totals[totals.length - 1] ?? 0

  // Only a second that has a sample shows a readout: before the download's first, there's none.
  const sample = hovered === null ? -1 : hovered - firstSlot
  const readout = sample >= 0 && sample < length ? sample : null
  const slotPercent = (slot: number): string => `${(slot / (SPEED_HISTORY_SECONDS - 1)) * 100}%`
  const secondsAgo = SPEED_HISTORY_SECONDS - 1 - (hovered ?? 0)
  const last = SPEED_HISTORY_SECONDS - 1
  // Where the minute ends, and how far back a second is, in words.
  const endLabel = endsAt === 'now' ? 'Now' : endsAt === 'pause' ? 'Paused' : 'Finished'
  const before = (seconds: number): string =>
    endsAt === 'now' ? `${seconds} s ago` : `${seconds} s before the ${endsAt}`
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.key === 'ArrowLeft' ? -1 : 1
      setHovered((slot) =>
        Math.min(last, Math.max(firstSlot, (slot ?? last) + (slot === null ? 0 : step)))
      )
    } else if (event.key === 'Escape') {
      setHovered(null)
    }
  }

  return (
    // Clear of the heading above: the top label centres on the top gridline, so it rises above it.
    <div className="mt-4 flex gap-2">
      {/* The scale, beside the plot rather than over the fills, where it would be hard to read.
          Each number with its unit, so any one reads on its own. */}
      <div className="shrink-0 text-right">
        <div className="relative h-[104px]">
          {/* The widest label, invisible, gives the column its width. */}
          <span className={`invisible block ${labelClass}`}>{ticks.at(-1)?.label}</span>
          {ticks.map((tick) => (
            <span
              key={tick.value}
              className={`absolute right-0 -translate-y-1/2 ${labelClass}`}
              style={{ top: `${(1 - tick.value / top) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div
          tabIndex={0}
          role="img"
          aria-label={`Merged throughput over the last minute, split by network. ${endLabel} ${formatSpeed(latestTotal)}, fastest ${formatSpeed(peakTotal)}. Focus and use the left and right arrow keys to read each second.`}
          onKeyDown={onKeyDown}
          onBlur={() => setHovered(null)}
          className="relative h-[104px] rounded-[4px] outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
            setHovered(Math.round(fraction * (SPEED_HISTORY_SECONDS - 1)))
          }}
          onPointerLeave={() => setHovered(null)}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="block h-full w-full"
            aria-hidden
          >
            <g stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke">
              {ticks.map((tick) => (
                <line
                  key={tick.value}
                  x1={0}
                  y1={toY(tick.value)}
                  x2={WIDTH}
                  y2={toY(tick.value)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
            {layers.map((layer, index) => (
              <polygon key={index} points={layer.points} fill={layer.solid} />
            ))}
            {/* 2px of the ground between stacked layers, so neighbouring colours stay apart. */}
            {layers.slice(0, -1).map((layer, index) => (
              <polyline
                key={index}
                points={layer.edge}
                fill="none"
                stroke="var(--bg)"
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              points={outline}
              fill="none"
              stroke="var(--node-accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {readout !== null && hovered !== null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-0 border-l border-dashed border-foreground/50"
                style={{ left: slotPercent(hovered) }}
              />
              {/* Every network at that second, so the pointer needn't land on a fill; on the side
                  away from the edge it would run off. */}
              <div
                className="pointer-events-none absolute top-1 z-10 flex min-w-[11rem] flex-col gap-1 rounded-[10px] bg-popover px-3 py-2 text-[12px] shadow-[var(--shadow-sheet)]"
                style={
                  hovered > (SPEED_HISTORY_SECONDS - 1) / 2
                    ? { right: `calc(100% - ${slotPercent(hovered)} + 8px)` }
                    : { left: `calc(${slotPercent(hovered)} + 8px)` }
                }
              >
                <span className="text-[11.5px] text-ink-3">
                  {secondsAgo === 0 ? endLabel : before(secondsAgo)}
                </span>
                {order.map((entry) => (
                  <span key={entry.interfaceId} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2 w-3.5 shrink-0 rounded-full"
                      style={{ background: entry.solid }}
                    />
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="figures text-[13px] font-[600]">
                      {formatSpeed(historyByInterface[entry.interfaceId]?.[readout] ?? 0)}
                    </span>
                  </span>
                ))}
                {order.length > 1 && (
                  <span className="flex items-center gap-2 border-t border-rule pt-1">
                    <span className="flex-1 font-[600]">Merged</span>
                    <span className="figures text-[13px] font-[650]">
                      {formatSpeed(totals[readout])}
                    </span>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div className={`mt-1.5 flex justify-between ${labelClass}`}>
          <span>{before(SPEED_HISTORY_SECONDS)}</span>
          <span>{endLabel}</span>
        </div>
      </div>
    </div>
  )
}
