import { recoveryMessage, type RecoveryNote } from '@shared/recovery'
import { LifeBuoy } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Button } from './ui/button'

// After a crash, a force quit or a power cut, the note at the top of Downloads says what came back
// (docs/plans/2026-11-new-features-plan.md, feature 5; the design's RecoveredBanner). The main process
// works it out at launch (shared/recovery.ts) and forgets it once dismissed. It is there from the
// first frame, so it doesn't slide in; it says its piece once, as a status, without taking focus.

export function RecoveredBanner(): React.JSX.Element | null {
  const [note, setNote] = useState<RecoveryNote | null>(null)
  const titleId = useId()

  useEffect(() => {
    let current = true
    window.mergelane.recovery().then(
      (found) => current && setNote(found),
      () => {}
    )
    return () => {
      current = false
    }
  }, [])

  if (!note) return null

  const dismiss = (): void => {
    setNote(null)
    void window.mergelane.dismissRecovery().catch(() => {})
  }

  return (
    <div
      role="status"
      aria-atomic="true"
      aria-labelledby={titleId}
      className="mx-1.5 flex flex-wrap items-start gap-3 rounded-[12px] bg-[var(--color-accent-soft)] p-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-accent)_28%,transparent)]"
    >
      <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--color-accent-ink)]" />
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <p id={titleId} className="text-[13px] font-[640]">
          Mergelane recovered after quitting unexpectedly
        </p>
        <p className="text-[12.5px] leading-[1.5] text-ink-2">{recoveryMessage(note)}</p>
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
        Dismiss
      </Button>
    </div>
  )
}
