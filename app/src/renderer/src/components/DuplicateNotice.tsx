import type { DuplicateMatch } from '@shared/duplicates'
import { Copy, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { words } from '../platformWords'
import { useAppStore } from '../store/useAppStore'
import { dirnameOf, formatBytes, formatWhen, toDisplayPath } from '../utils/format'
import { Button } from './ui/button'

// New download's warning that this is had already (the design's DuplicateNotice; ADR-0081): still
// downloading in the list, or a file on disk, by the same link or the same file from another site.

export function DuplicateNotice({ match }: { match: DuplicateMatch }): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const openDownload = useAppStore((store) => store.openDownload)
  const closeNewDownload = useAppStore((store) => store.closeNewDownload)
  const finder = words().fileManager
  // When it was downloaded, against when the notice came up.
  const [now] = useState(() => Date.now())
  const how =
    match.how === 'link'
      ? 'Same link.'
      : `Same file from ${match.host}: the name and size match, and so does the SHA-256 this site publishes.`
  const where = match.path ? ` to ${toDisplayPath(dirnameOf(match.path), homeDir)}` : ''
  const when = match.completedAt !== undefined ? ` ${formatWhen(match.completedAt, now)}` : ''

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[12px] bg-caution-soft p-3 shadow-[inset_0_0_0_1px_var(--color-warning-border)]"
    >
      <Copy aria-hidden className="mt-0.5 size-4 shrink-0 text-caution" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-[13px] font-[640]">
          {match.live ? 'This is already downloading' : 'You already have this file'}
        </p>
        <p className="text-[12.5px] leading-[1.5] text-ink-2">
          {match.live
            ? `It’s in your list, ${match.percent ?? 0}% done.`
            : `Downloaded${when}${where}, ${formatBytes(match.size)}.`}{' '}
          {how}
        </p>
        <div className="flex flex-wrap gap-2">
          {match.live ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                closeNewDownload()
                openDownload(match.id)
              }}
            >
              Show in list
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void window.mergelane.revealHistoryEntry(match.id).catch(() => false)}
            >
              <FolderOpen aria-hidden data-icon="inline-start" />
              Show in {finder}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
