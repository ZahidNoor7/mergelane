import { cn } from 'cn'
import { Gauge, GaugeArc, GaugeTrack, type GaugeSpringTransition } from '../gauge'

// The speed test's dial (ADR-0064): the one large element of the view. Gauge UI draws the arc
// (components/gauge, copied from upstream); the reading sits in HTML at its centre, so it gets the
// app's figures and stays real text. Critically damped, as the design's springs are: the arc follows
// each new reading from wherever it is, without overshoot. Gauge UI snaps it under Reduce Motion.

const TRANSITION: GaugeSpringTransition = { type: 'spring', visualDuration: 0.35, bounce: 0 }

export function SpeedGauge({
  bytesPerSec,
  max,
  color,
  reading,
  unit,
  caption,
  label,
  valueText,
  dim = false
}: {
  bytesPerSec: number
  /** The top of the scale, bytes a second. */
  max: number
  /** The arc's colour: the network's while one network is measured, else the accent. */
  color: string
  /** The figure at the centre, and its unit under it. */
  reading: string
  unit: string
  /** What is being measured, over the figure. */
  caption: string
  /** The meter's name for assistive tech. */
  label: string
  /** The meter's value in words. */
  valueText: string
  /** Nothing is being measured: the arc and figure fade. */
  dim?: boolean
}): React.JSX.Element {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(Math.min(bytesPerSec, max))}
      aria-valuetext={valueText}
      className="relative mx-auto aspect-square w-full max-w-[17rem]"
    >
      <Gauge
        aria-hidden
        value={Math.min(bytesPerSec, max)}
        min={0}
        max={max}
        startAngle={45}
        endAngle={315}
        radius={200}
        padding={20}
        transition={TRANSITION}
        className={cn('transition-opacity duration-200', dim && 'opacity-55')}
      >
        <GaugeTrack width={22} color="var(--track-bg)" opacity={1} />
        <GaugeArc width={22} color={color} />
      </Gauge>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 pt-2">
        <span className="text-[12.5px] font-[600] text-ink-2">{caption}</span>
        <span
          className={cn(
            'figures text-[44px] leading-none font-[650] tracking-[-0.02em]',
            dim ? 'text-ink-3' : 'text-foreground'
          )}
        >
          {reading}
        </span>
        <span className="text-[12.5px] font-[580] text-ink-3">{unit}</span>
      </div>
    </div>
  )
}
