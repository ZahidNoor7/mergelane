import { cn } from 'cn'
import { ArrowUp, Gauge, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useElementWidth } from '../hooks/useElementWidth'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { GlassLens } from './GlassLens'

// The Confluence: the final design's signature (design-system/mergelane/redesign/prototype.html,
// Confluence; MASTER.md, "The idea"). Each network is a lane drawn as thick as its speed; the lanes
// merge into one road whose width is the merged speed. The speed floats over the road on a frosted card, with
// how many times the fastest single network it is (ADR-0070). Lane markings drift along a lane only while it
// carries bytes, and stop under Reduce Motion. Pointing at a network, or focusing it, picks its lane out.

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
  // Tall enough for the lens over the road: its label, figure, gain and a caption of two lines.
  const lensRoom = stacked ? 0 : compact ? 124 : 152
  const height = Math.max(lanes.length * rowHeight, compact ? 64 : 104, lensRoom)
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
  // The merged road runs to the far edge; the speed floats over it on the lens, so the lanes meet before it.
  const lensWidth = compact ? 188 : 220
  const mergeX = stacked
    ? Math.round(width * 0.6)
    : Math.round(Math.max(width * 0.36, Math.min(width * 0.6, width - lensWidth - 40)))
  const xEnd = width - 1
  // The markings stop where the card begins: nothing moves behind it, so its frosted glass is never redrawn.
  const markEnd = stacked ? xEnd : Math.max(mergeX, width - 20 - lensWidth)
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
      centre: `M${x0},${start} C${xMid},${start} ${xMid},${centre} ${mergeX},${centre} L${markEnd},${centre}`,
      approach: `M${x0},${start} C${xMid},${start} ${xMid},${height / 2} ${mergeX},${height / 2}`,
      ribbon: t
        ? `M${x0},${start - half} C${xMid},${start - half} ${xMid},${centre - half} ${mergeX},${centre - half} L${xEnd},${centre - half} L${xEnd},${centre + half} L${mergeX},${centre + half} C${xMid},${centre + half} ${xMid},${start + half} ${x0},${start + half} Z`
        : null
    }
  })
  const flowing = !idle && !reduced
  // Point at a network (its label or its lane) to pick it out: the other lanes step back.
  const [hot, setHot] = useState<string | null>(null)
  const shareOf = (lane: ConfluenceLane): number =>
    sum > 0 && carrying(lane) ? Math.round((lane.speed / sum) * 100) : 0
  // What merging buys: the merged speed against the fastest single network.
  const fastest = Math.max(0, ...lanes.map((lane) => (carrying(lane) ? lane.speed : 0)))
  const gain = !idle && live > 1 && fastest > 0 ? sum / fastest : 0

  const totalBlock = (
    <GlassLens
      off={stacked}
      className={cn(
        'flex min-w-[7.5rem] flex-col gap-1',
        !stacked && 'absolute top-1/2 right-5 z-[1] -translate-y-1/2 px-4 py-3'
      )}
      style={stacked ? undefined : { width: lensWidth }}
    >
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
      {gain >= 1.05 && (
        <span className="flex items-center gap-1 text-[12px] font-[600] text-primary">
          <ArrowUp aria-hidden className="size-3" strokeWidth={2.5} />
          {gain.toFixed(1)}× your fastest network
        </span>
      )}
      {caption && <div className="text-[12px] leading-snug text-ink-2">{caption}</div>}
    </GlassLens>
  )

  return (
    <div
      ref={outerRef}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3"
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
            tabIndex={0}
            style={{ height: rowHeight, opacity: hot && hot !== lane.id ? 0.45 : 1 }}
            onMouseEnter={() => setHot(lane.id)}
            onMouseLeave={() => setHot(null)}
            onFocus={() => setHot(lane.id)}
            onBlur={() => setHot(null)}
            aria-label={`${lane.name}: ${
              lane.down
                ? 'dropped'
                : idle || !carrying(lane)
                  ? (lane.note ?? (idle ? 'idle' : 'off')).toLowerCase()
                  : `${formatSpeed(lane.speed)}, ${shareOf(lane)}% of the total`
            }`}
            className="flex cursor-default flex-col items-end justify-center rounded-[6px] text-right transition-opacity duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--color-primary))]"
          >
            <span className="flex items-center gap-1.5 text-[12.5px] leading-tight font-[620] whitespace-nowrap">
              {lane.name}
              <span
                aria-hidden
                data-swatch
                className={cn(
                  'inline-block h-1.5 w-2 shrink-0 rounded-full',
                  (idle || lane.down || !carrying(lane)) && 'opacity-40'
                )}
                style={{ background: lane.color }}
              />
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
                  {sum > 0 && <span className="figures">{shareOf(lane)}%</span>}
                </>
              )}
              {!compact && lane.interfaceName && (
                <span className="font-mono text-[11px]">{lane.interfaceName}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div ref={drawingRef} className="relative min-w-0">
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
                <g
                  key={lane.id}
                  data-lane={lane.id}
                  style={{ opacity: hot && hot !== lane.id ? 0.3 : 1, transition: 'opacity 150ms' }}
                >
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
              <g
                key={lane.id}
                data-lane={lane.id}
                onMouseEnter={() => setHot(lane.id)}
                onMouseLeave={() => setHot(null)}
                style={{ opacity: hot && hot !== lane.id ? 0.25 : 1, transition: 'opacity 150ms' }}
              >
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
        {!stacked && totalBlock}
      </div>
    </div>
  )
}
