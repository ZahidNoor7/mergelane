import * as React from 'react'
import { cn } from 'cn'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg bg-[var(--input-bg)] px-3 py-2 text-[13px] text-foreground transition-colors outline-none shadow-[inset_0_0_0_1px_var(--control)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)] placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-45',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
