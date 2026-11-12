import { ChevronLeft, Folder, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { isFinished, type DownloadItem } from '../../utils/downloadActions'
import { dirnameOf, sourceOf, toDisplayPath } from '../../utils/format'
import { FileGlyph, KindTags } from '../DownloadGlyphs'
import { Button } from '../ui/button'
import { InspectorFailed } from './InspectorFailed'
import { InspectorFinished } from './InspectorFinished'
import { InspectorProgress } from './InspectorProgress'
import { InspectorActions } from './parts'

// A download's details, from the final design (design-system/mergelane/redesign/prototype.html,
// Inspector): beside the list in a wide window, in its place in a narrow one (with the way back).
// It replaces the three download screens (downloading, complete, error), keeping all they showed.

export function Inspector({
  download,
  onBack,
  onClose
}: {
  download: DownloadItem
  /** In a narrow window: back to the list. */
  onBack?: () => void
  /** Beside the list, in a wide window: closes the details (Esc does too). */
  onClose?: () => void
}): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const finished = isFinished(download) || download.status === 'completed'
  const failed = !finished && (download.status === 'error' || download.status === 'cancelled')
  const missing = isFinished(download) && download.missing === true
  const folder = toDisplayPath(dirnameOf(download.destinationPath), homeDir)

  // In the list's place, it's a new screen: focus starts at its name.
  const fullWindow = onBack !== undefined
  useEffect(() => {
    if (fullWindow) headingRef.current?.focus()
  }, [fullWindow, download.id])

  return (
    <div className="flex flex-col gap-6 p-4 @container">
      {onBack && (
        <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onBack}>
          <ChevronLeft aria-hidden />
          Downloads
        </Button>
      )}
      <header className="flex items-start gap-3">
        <FileGlyph item={download} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-[15px] leading-snug font-[650] tracking-[-0.01em] break-words outline-none"
          >
            {download.fileName}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
            <KindTags item={download} />
            {download.kind === 'http' && (
              <span className="font-mono text-[11.5px] text-ink-2">{sourceOf(download.url)}</span>
            )}
          </div>
          <p
            className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3"
            title={download.destinationPath}
          >
            <Folder aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {missing
                ? 'Moved or deleted since'
                : `${finished ? 'Saved to' : 'Saving to'} ${folder}`}
            </span>
          </p>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close details"
            title="Close details (Esc)"
            className="-mt-1 -mr-1 shrink-0"
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        )}
      </header>

      <InspectorActions download={download} />

      {finished ? (
        <InspectorFinished download={download} />
      ) : failed ? (
        <InspectorFailed download={download} />
      ) : (
        <InspectorProgress download={download} />
      )}
    </div>
  )
}
