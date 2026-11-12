import type { SystemMergeSnapshot } from '@shared/types'
import { ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { words } from '../platformWords'

// The sidebar's word that the helper is older than the app (docs/DECISIONS.md ADR-0051). Updating the
// app can't update the helper: it is a root service in /Library, which only an administrator may
// replace. So, as soon as Mergelane opens after an update, this offers it, and one click brings
// macOS's password prompt. It looks like UpdateNotice. Only for a helper that is installed: someone who
// never turned on system merge is never asked. Hidden on Networks, whose System merge section says the
// same with more, and for the rest of this launch after Later.

export function HelperUpdateNotice(): React.JSX.Element | null {
  const onNetworks = useAppStore((store) => store.screen === 'networks')
  const [snapshot, setSnapshot] = useState<SystemMergeSnapshot | null>(null)
  const [later, setLater] = useState(false)
  const [updating, setUpdating] = useState(false)

  const check = useCallback(() => {
    void window.mergelane.systemMerge().then(setSnapshot, () => {})
  }, [])
  // At launch, and whenever the window comes back to the front (an update made elsewhere).
  useEffect(() => {
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [check])

  if (!snapshot?.installed || !snapshot.helperOutdated || later || onNetworks) return null

  const update = (): void => {
    setUpdating(true)
    void window.mergelane
      .installSystemMerge()
      .then(setSnapshot, () => {})
      .finally(() => setUpdating(false))
  }

  return (
    <div
      role="status"
      aria-label="Helper update"
      className="ml-notice flex flex-col gap-2 rounded-[11px] bg-card p-2.5 shadow-[var(--shadow-raise)]"
    >
      <p className="flex items-start gap-2 text-[12.5px] leading-snug">
        <ShieldCheck
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-[var(--color-accent-ink)]"
        />
        <span>
          <span className="font-[640]">Update the helper</span> to match Mergelane{' '}
          {snapshot.appVersion}. System merge needs it. {words().adminPromptShort}
        </span>
      </p>
      {snapshot.error && (
        <p className="text-[12px] leading-snug text-destructive">{snapshot.error}</p>
      )}
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={updating} onClick={update}>
          {updating ? 'Updating…' : 'Update…'}
        </Button>
        <Button size="sm" variant="ghost" disabled={updating} onClick={() => setLater(true)}>
          Later
        </Button>
      </div>
    </div>
  )
}
