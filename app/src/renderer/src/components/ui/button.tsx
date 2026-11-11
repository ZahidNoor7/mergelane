import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

// The final design's capsule button (design-system/mergelane/MASTER.md, Components). Every variant and
// size name the app already uses is kept: `default` is the design's primary, `outline` its secondary,
// and xs/lg/icon-xs/icon-lg extend its sm/md/icon scale.
const buttonVariants = cva(
  'group/button ml-btn inline-flex shrink-0 items-center justify-center rounded-full font-[580] whitespace-nowrap outline-none select-none transition-[background-color,color,scale,opacity] duration-100 ease-out motion-safe:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)] [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'ml-btn-primary bg-primary text-primary-foreground hover:bg-primary/88',
        secondary:
          'ml-btn-secondary bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover aria-expanded:bg-hover',
        outline:
          'ml-btn-secondary bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover aria-expanded:bg-hover',
        ghost:
          'text-ink-2 hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground',
        destructive:
          'bg-destructive-soft text-destructive shadow-[inset_0_0_0_1px_var(--color-danger-border)]',
        link: 'rounded-sm text-[var(--color-accent-ink)] underline-offset-4 hover:underline'
      },
      size: {
        default: "h-8 gap-1.5 px-3.5 text-[13px] [&_svg:not([class*='size-'])]:size-4",
        xs: "h-6 gap-1 px-2.5 text-[12px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-3 text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-4 text-[13.5px] [&_svg:not([class*='size-'])]:size-4",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-lg': "size-9 [&_svg:not([class*='size-'])]:size-4"
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>): React.JSX.Element {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
// eslint-disable-next-line react-refresh/only-export-components -- shadcn convention: variants ship alongside the component
export { buttonVariants }
