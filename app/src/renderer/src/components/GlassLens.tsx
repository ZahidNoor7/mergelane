import { cn } from 'cn'

// The card the Confluence's speed sits on, over the merged road (the design's GlassLens; docs/DECISIONS.md
// ADR-0070, ADR-0071). Frosted rather than clear (the owner, 2026-11-17: "the card is too glassy, make it a little
// glassy or frosted"): a soft blur and a mostly solid fill, so the figure reads on every theme, Liquid Glass
// included, with no refraction to redraw as the lanes move. main.css (.mergelane-lens) draws it, and a plain card
// for solid glass, Reduce Transparency and Increase Contrast.

/** Frosted glass over whatever is behind it. `off` draws a plain block instead: where there's no road behind it
 * (the narrow layout, where the speed sits above the lanes). */
export function GlassLens({
  off = false,
  className,
  style,
  children
}: {
  off?: boolean
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn(!off && 'mergelane-lens', className)} style={style}>
      {children}
    </div>
  )
}
