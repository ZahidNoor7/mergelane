import { cn } from 'cn'
import { Gauge, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useElementWidth } from '../hooks/useElementWidth'
import { useFormatSpeed } from '../hooks/useFormatSpeed'

// The Confluence: the final design's signature (design-system/mergelane/redesign/prototype.html,
// Confluence; MASTER.md, "The idea"). Each network is a lane drawn as thick as its speed; the lanes
// merge into one road whose width is the merged speed, beside the merged speed in figures. Lane
// markings drift along a lane only while it carries bytes, and stop under Reduce Motion.

export interface ConfluenceLane {
  /** Tells the lanes apart; never shown. */
  id: string
  /** The network's interface name (`en0`), shown beside its speed when there is room. */
  interfaceName?: string
  name: string
  /** The network's colour (a CSS colour or custom property). */
  color: string
  /** Bytes per second. */
  speed: number
  /** Carrying bytes for what's shown. Off, it is drawn as a dashed approach with `note` or "Off". */
  on?: boolean
  /** Dropped: drawn dashed in the danger colour, with "Dropped". */
  down?: boolean
  /** At its speed limit: a gauge beside its speed. */
  limited?: boolean
  /** What an unused lane says instead of "Off" (e.g. "Not used"). */
  note?: string
}

/** Grey lanes to draw the diagram with when there is no network yet: the empty list and dashboard. */
// eslint-disable-next-line react-refresh/only-export-components -- one set of placeholders, shared
export const PLACEHOLDER_LANES: ConfluenceLane[] = [
  { id: 'wifi', name: 'Wi-Fi', color: 'var(--icon-muted)', speed: 0 },
  { id: 'usb', name: 'iPhone USB', color: 'var(--icon-muted)', speed: 0 },
  { id: 'ethernet', name: 'Ethernet', color: 'var(--icon-muted)', speed: 0 }
]

/** The design's scale: at this merged speed the road is two thirds of the drawing's height. Above it
 * the scale stretches to the merged speed, so a fast Ethernet doesn't max every lane out. */
const CAPACITY = 36_000_000

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Each value eases from where it is now toward its target (exponential, τ = 0.16 s), so a new
 * reading never makes a lane jump. Under Reduce Motion, values change at once. */
function useEasedArray(targets: number[], reduced: boolean): number[] {
  const [values, setValues] = useState(targets)
  const current = useRef(targets)
  const goal = useRef(targets)
  const key = targets.map((value) => value.toFixed(1)).join(',')
  useEffect(() => {
    goal.current = targets
    if (reduced || current.current.length !== targets.length) {
      current.current = targets
      setValues(targets)
      return undefined
    }
    let frame = 0
    let last = performance.now()
    const step = (time: number): void => {
      const dt = Math.min(0.05, (time - last) / 1000)
      last = time
      const amount = 1 - Math.exp(-dt / 0.16)
      const next = goal.current.map(
        (g, i) => current.current[i] + (g - current.current[i]) * amount
      )
      const settled = next.every((value, i) => Math.abs(value - goal.current[i]) < 0.05)
      current.current = settled ? goal.current : next
      setValues(current.current)
      if (!settled) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
    // `key` stands for `targets`: a new array with the same values must not restart the easing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced])
  return values.length === targets.length ? values : targets
}

/** A speed as the design sets it: the figure large and condensed, its unit small beside it. */
function SpeedFigure({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const space = text.lastIndexOf(' ')
  const value = space > 0 ? text.slice(0, space) : text
  const unit = space > 0 ? text.slice(space + 1) : ''
  return (
    <span className={cn('figures inline-flex items-baseline gap-1', className)}>
      {value}
      {unit && <span className="text-[0.32em] font-[580] tracking-normal text-ink-2">{unit}</span>}
    </span>
  )
}

export function Confluence({
  lanes,
  total,
  label = 'Merged speed',
  labelNote,
  caption,
  compact = false,
  idle = false
}: {
  lanes: ConfluenceLane[]
  /** The merged speed shown; by default the sum of the lanes carrying bytes. */
  total?: number
  label?: string
  /** Beside the label, e.g. a warning about what holds the speed down. */
  labelNote?: React.ReactNode
  caption?: React.ReactNode
  /** Smaller rows and figure, without interface ids: a download's own screen. */
  compact?: boolean
  /** Nothing to draw yet: dashed approaches and a dash for the speed. */
  idle?: boolean
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const reduced = useReducedMotion()
  const [outerRef, outerWidth] = useElementWidth()
  const [drawingRef, drawingWidth] = useElementWidth()
  const stacked = outerWidth > 0 && outerWidth < 440

  const rowHeight = compact ? 32 : 40
  const height = Math.max(lanes.length * rowHeight, compact ? 64 : 104)
  const pad = (height - lanes.length * rowHeight) / 2
  const carrying = (lane: ConfluenceLane): boolean => lane.on !== false && !lane.down
  const sum = lanes.reduce((acc, lane) => acc + (carrying(lane) ? lane.speed : 0), 0)
  const merged = total ?? sum

  // The scale: the design's fixed one, stretched to the merged speed when that is faster.
  const perByte = (height * 0.66) / Math.max(CAPACITY, sum)
  // A lane never outgrows its row, so lanes can't overlap where they start.
  const maxLane = rowHeight - 6
  const targets = lanes.map((lane) =>
    idle || !carrying(lane) ? 0 : Math.min(lane.speed * perByte, maxLane)
  )
  const thickness = useEasedArray(targets, reduced)

  const width = Math.max(60, drawingWidth)
  // Room for the widest round cap at each lane's start, inside the drawing.
  const x0 = maxLane / 2 + 2
  const mergeX = Math.round(width * 0.6)
  const xEnd = width - 1
  const xMid = (x0 + mergeX) / 2
  const gap = 2
  const drawn = thickness.map((t) => (t > 0.8 ? t : 0))
  const live = drawn.filter(Boolean).length
  const bandHeight = drawn.reduce((acc, t) => acc + t, 0) + gap * Math.max(0, live - 1)
  // Where each drawn lane's centre lands in the road: stacked from the top of the band, 2px apart.
  const centres = drawn.map((t, i) => {
    if (!t) return height / 2
    const before = drawn.slice(0, i).filter(Boolean)
    const offset = before.reduce((acc, previous) => acc + previous + gap, 0)
    return height / 2 - bandHeight / 2 + offset + t / 2
  })
  const geometry = lanes.map((_, i) => {
    const t = drawn[i]
    const start = pad + (i + 0.5) * rowHeight
    const centre = centres[i]
    const half = t / 2
    return {
      t,
      start,
      centre: `M${x0},${start} C${xMid},${start} ${xMid},${centre} ${mergeX},${centre} L${xEnd},${centre}`,
      approach: `M${x0},${start} C${xMid},${start} ${xMid},${height / 2} ${mergeX},${height / 2}`,
      ribbon: t
        ? `M${x0},${start - half} C${xMid},${start - half} ${xMid},${centre - half} ${mergeX},${centre - half} L${xEnd},${centre - half} L${xEnd},${centre + half} L${mergeX},${centre + half} C${xMid},${centre + half} ${xMid},${start + half} ${x0},${start + half} Z`
        : null
    }
  })
  const flowing = !idle && !reduced

  const totalBlock = (
    <div className="flex min-w-[7.5rem] flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-[580] text-ink-2">
        {label}
        {labelNote}
      </span>
      {idle ? (
        <span className="figures text-[40px] leading-[0.9] font-[680] text-ink-3">—</span>
      ) : (
        <SpeedFigure
          text={formatSpeed(merged)}
          className={cn(
            'leading-[0.9] font-[700] tracking-[-0.02em]',
            compact ? 'text-[34px]' : 'text-[46px]'
          )}
        />
      )}
      {caption && <div className="text-[12px] leading-snug text-ink-2">{caption}</div>}
    </div>
  )

  return (
    <div
      ref={outerRef}
      className={cn(
        'grid items-center gap-x-4 gap-y-3',
        stacked ? 'grid-cols-[auto_minmax(0,1fr)]' : 'grid-cols-[auto_minmax(0,1fr)_auto]'
      )}
    >
      {stacked && <div className="col-span-2">{totalBlock}</div>}
      <ul
        className="flex flex-col"
        style={{ paddingBlock: pad }}
        aria-label="Networks in this merge"
      >
        {lanes.map((lane) => (
          <li
            key={lane.id}
            style={{ height: rowHeight }}
            className="flex flex-col items-end justify-center text-right"
          >
            <span className="text-[12.5px] leading-tight font-[620] whitespace-nowrap">
              {lane.name}
            </span>
            <span className="flex items-center gap-1.5 text-[11.5px] leading-tight whitespace-nowrap text-ink-3">
              {lane.down ? (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <Unplug aria-hidden className="size-3" />
                  Dropped
                </span>
              ) : idle || !carrying(lane) ? (
                <span>{lane.note ?? (idle ? 'Idle' : 'Off')}</span>
              ) : (
                <>
                  {lane.limited && (
                    <Gauge
                      role="img"
                      aria-label="at its speed limit"
                      className="size-3 text-ink-2"
                    />
                  )}
                  <span className="figures text-[12px] font-[600] text-ink-2">
                    {formatSpeed(lane.speed)}
                  </span>
                </>
              )}
              {!compact && lane.interfaceName && (
                <span className="font-mono text-[11px]">{lane.interfaceName}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div ref={drawingRef} className="min-w-0">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden
          className="block overflow-visible"
        >
          {geometry.map((shape, i) => {
            const lane = lanes[i]
            const color = idle
              ? 'var(--icon-muted)'
              : lane.down
                ? 'var(--color-danger)'
                : lane.color
            if (!shape.t) {
              return (
                <g key={lane.id} data-lane={lane.id}>
                  <path
                    d={shape.approach}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray="2 5"
                    strokeLinecap="round"
                    opacity={lane.down ? 0.8 : 1}
                  />
                  <circle cx={x0} cy={shape.start} r={3} fill={color} />
                </g>
              )
            }
            // Markings move a little faster on a faster lane.
            const pixelsPerSecond = 6 + (lane.speed / 1e6) * 1.8
            const duration = Math.round((12 / pixelsPerSecond) * 20) / 20
            return (
              <g key={lane.id} data-lane={lane.id}>
                <path d={shape.ribbon!} fill={color} />
                <circle cx={x0} cy={shape.start} r={shape.t / 2} fill={color} />
                {shape.t >= 5 && (
                  <path
                    d={shape.centre}
                    fill="none"
                    stroke="var(--lane-mark)"
                    strokeWidth={Math.max(1, shape.t * 0.14)}
                    strokeDasharray="4 8"
                    strokeLinecap="round"
                    className={cn('mergelane-lane-flow', !flowing && 'mergelane-lane-still')}
                    style={{ animationDuration: `${duration}s` }}
                  />
                )}
              </g>
            )
          })}
          {(idle || live === 0) && (
            <path
              d={`M${mergeX},${height / 2} L${xEnd},${height / 2}`}
              stroke="var(--icon-muted)"
              strokeWidth={1.5}
              strokeDasharray="2 5"
              strokeLinecap="round"
            />
          )}
        </svg>
      </div>
      {!stacked && totalBlock}
    </div>
  )
}
