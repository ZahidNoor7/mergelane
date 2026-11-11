import { cn } from 'cn'
import { useFormatSpeed } from '../hooks/useFormatSpeed'

/** A speed as the design sets it in a line of text: the figure, then its unit smaller and lighter.
 * `dash` shows "—" for a speed that isn't there (off, or nothing moving). */
export function SpeedText({
  bytesPerSecond,
  dash = false,
  className
}: {
  bytesPerSecond: number
  dash?: boolean
  className?: string
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  if (dash) return <span className={cn('figures text-ink-3', className)}>—</span>
  const text = formatSpeed(bytesPerSecond)
  const space = text.lastIndexOf(' ')
  return (
    <span className={cn('figures whitespace-nowrap', className)}>
      {space > 0 ? text.slice(0, space) : text}
      {space > 0 && (
        <span className="ml-[0.3em] text-[max(11px,0.5em)] font-[540] tracking-normal text-ink-3">
          {text.slice(space + 1)}
        </span>
      )}
    </span>
  )
}
