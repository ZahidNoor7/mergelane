import { cn } from 'cn'

export interface SplitSegment {
  id: string
  /** This network's share of the whole file, from 0 to 1. */
  share: number
  color: string
}

/** A download's progress split by the network that fetched each share, in each network's colour,
 * as in the final design (design-system/mergelane/redesign/prototype.html, SplitBar): 6px tall with
 * 2px gaps on the track. Widths ease as they grow, unless Reduce Motion is on.
 *
 * With a `label` it is a progressbar for assistive tech; without one it is decorative, for places
 * where the same progress is already in words (a list row's detail line). */
export function SplitBar({
  segments,
  height = 6,
  dim = false,
  label,
  percent,
  valueText
}: {
  segments: SplitSegment[]
  height?: number
  /** Not moving (paused, waiting): the colours stay, faded, so it doesn't read as running. */
  dim?: boolean
  label?: string
  percent?: number
  valueText?: string
}): React.JSX.Element {
  // A sliver under half a pixel on the widest bar draws nothing but a stray gap.
  const shown = segments.filter((segment) => segment.share > 0.0004)
  const meter = label
    ? {
        role: 'progressbar' as const,
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': percent,
        'aria-valuetext': valueText
      }
    : { 'aria-hidden': true as const }
  return (
    <div
      {...meter}
      className={cn(
        'flex w-full gap-[2px] overflow-hidden rounded-full bg-track transition-opacity duration-200',
        dim && 'opacity-45'
      )}
      style={{ height }}
    >
      {shown.map((segment) => (
        <span
          key={segment.id}
          className="h-full shrink-0 first:rounded-l-full motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
          style={{ width: `${Math.min(100, segment.share * 100)}%`, background: segment.color }}
        />
      ))}
    </div>
  )
}
