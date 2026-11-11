import { Sparkles } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'

// The sidebar's word that an update is out, from the final design (prototype.html, UpdateNotice).
// Hidden while Settings › Updates shows, which says the same with more.

export function UpdateNotice(): React.JSX.Element | null {
  const update = useAppStore((store) => store.update)
  const onUpdates = useAppStore(
    (store) => store.screen === 'settings' && store.settingsSection === 'updates'
  )
  const openSettings = useAppStore((store) => store.openSettings)
  // As the design: only when there's something to do, found or ready, not while downloading.
  const ready = update?.status === 'ready'
  if (!update || (update.status !== 'available' && !ready) || onUpdates) return null
  return (
    <div
      role="status"
      className="ml-notice flex flex-col gap-2 rounded-[11px] bg-card p-2.5 shadow-[var(--shadow-raise)]"
    >
      <p className="flex items-start gap-2 text-[12.5px] leading-snug">
        <Sparkles aria-hidden className="mt-px size-3.5 shrink-0 text-[var(--color-accent-ink)]" />
        <span>
          <span className="font-[640]">Mergelane {update.latest?.version}</span>{' '}
          {ready ? 'is ready to install.' : 'is available.'}
        </span>
      </p>
      <Button size="sm" className="self-start" onClick={() => openSettings('updates')}>
        {ready ? 'Install…' : 'See what’s new'}
      </Button>
    </div>
  )
}
