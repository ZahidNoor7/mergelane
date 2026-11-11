import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

// The final design's segmented control items (default) and chips (outline, pill): capsules whose
// pressed state is raised on a card (segmented) or tinted with the accent (chips).
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1.5 rounded-full font-[580] whitespace-nowrap outline-none transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          'text-ink-2 hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-raise)] data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-[var(--shadow-raise)]',
        outline:
          'text-ink-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)] data-pressed:bg-selected data-pressed:text-foreground data-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)]',
        // A selectable preset (stream counts, qualities, schedule days): the design's chip.
        pill: 'text-ink-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)] data-pressed:bg-selected data-pressed:text-foreground data-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)]'
      },
      size: {
        default: 'h-[26px] min-w-[26px] px-2.5 text-[12.5px]',
        // 24px: WCAG 2.5.8's minimum target.
        xs: "h-6 min-w-6 px-2 text-[12px] [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-7 min-w-7 px-3 text-[12.5px]',
        lg: 'h-8 min-w-8 px-3.5 text-[13px]'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>): React.JSX.Element {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle }
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants ship alongside the component
export { toggleVariants }
