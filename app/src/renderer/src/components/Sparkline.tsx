import { SPEED_HISTORY_SECONDS } from '@shared/types'

const WIDTH = 240
const HEIGHT = 36

/** One series' last minute, a sample a second, newest at the right edge: a 2px line over a faint
 * wash, as the dataviz rules ask of a single series. The minute is fixed, like the throughput
 * chart's, so a second is always the same width and a new series fills in from the right.
 * `top` is shared by the charts shown side by side, so their heights compare. Pointing at it
 * reports the sample under the pointer through `onHover` (an index into `values`); the caller
 * shows that value in text, so nothing is read off the chart alone. */
export function Sparkline({
  values,
  top,
  color,
  label,
  hovered,
  onHover
}: {
  values: number[]
  top: number
  color: string
  /** What the chart shows, for a screen reader. */
  label: string
  hovered: number | null
  onHover: (index: number | null) => void
}): React.JSX.Element {
  const step = WIDTH / (SPEED_HISTORY_SECONDS - 1)
  const first = SPEED_HISTORY_SECONDS - values.length
  const scale = top > 0 ? top : 1
  const point = (value: number, index: number): string =>
    `${((first + index) * step).toFixed(1)},${(HEIGHT - 1 - (Math.min(value, scale) / scale) * (HEIGHT - 2)).toFixed(1)}`
  const line = values.map(point).join(' ')
  const area =
    values.length > 1
      ? `${line} ${((first + values.length - 1) * step).toFixed(1)},${HEIGHT} ${(first * step).toFixed(1)},${HEIGHT}`
      : ''

  return (
    <div
      className="relative h-9"
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
        const index = Math.round(fraction * (SPEED_HISTORY_SECONDS - 1)) - first
        onHover(index >= 0 && index < values.length ? index : null)
      }}
      onPointerLeave={() => onHover(null)}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
        role="img"
        aria-label={label}
      >
        {/* The baseline: a hairline one step off the surface. */}
        <line
          x1={0}
          y1={HEIGHT - 0.5}
          x2={WIDTH}
          y2={HEIGHT - 0.5}
          stroke="var(--border-strong)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {area && <polygon points={area} fill={color} fillOpacity={0.14} />}
        {values.length > 1 && (
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hovered !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${((first + hovered) / (SPEED_HISTORY_SECONDS - 1)) * 100}%` }}
        />
      )}
    </div>
  )
}
