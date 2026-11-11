import { describeCopiedLink } from '@shared/links'
import { cn } from 'cn'
import { ClipboardCopy } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'

// "Offer links I copy" (docs/DECISIONS.md ADR-0043): a link the user copied elsewhere, offered as
// they switch to Mergelane (main/clipboardOffers.ts). A notice in the update notice's style
// (UpdateNotice.tsx), at the sidebar's foot, or under the compact bar in a narrow window. It never
// takes focus and never starts anything: Download… opens New download with the link in it. The
// links arrive through hooks/useCopiedLinks.ts.

export function CopiedLinkOffer({
  layout
}: {
  layout: 'sidebar' | 'bar'
}): React.JSX.Element | null {
  const link = useAppStore((store) => store.copiedLink)
  const newDownloadOpen = useAppStore((store) => store.newDownloadOpen)
  const dismiss = useAppStore((store) => store.dismissCopiedLink)
  const download = useAppStore((store) => store.downloadCopiedLink)
  // New download open: it's where the link would go, and ⌘V puts it there.
  if (link === null || newDownloadOpen) return null
  const bar = layout === 'bar'
  return (
    <section
      aria-label="Copied link"
      className={cn(
        'ml-notice flex animate-[mergelane-notice-in_180ms_ease-out] rounded-[11px] bg-card p-2.5 shadow-[var(--shadow-raise)]',
        bar ? 'mx-3 mt-2 flex-wrap items-center gap-x-3 gap-y-2' : 'flex-col gap-2'
      )}
    >
      <p
        role="status"
        className={cn(
          'flex min-w-0 items-start gap-2 text-[12.5px] leading-snug',
          bar && 'flex-1 basis-48'
        )}
      >
        <ClipboardCopy
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-[var(--color-accent-ink)]"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-[640]">Download the link you copied?</span>
          <span title={link} className="truncate font-mono text-[11.5px] text-ink-2">
            {describeCopiedLink(link)}
          </span>
        </span>
      </p>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={download}>
          Download…
        </Button>
        <Button size="sm" variant="secondary" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  )
}
