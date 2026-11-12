import { Inspector } from '../components/inspector/Inspector'
import { useElementWidth } from '../hooks/useElementWidth'
import { useAppStore } from '../store/useAppStore'
import { DownloadsScreen } from './DownloadsScreen'
import { SPLIT_FROM } from './layout'

// The Downloads place, as the final design lays it out (prototype.html, DownloadsScreen with
// `split`): from 860px of content width, the list with the selected download's details beside it
// in a 400px pane; narrower, the list, or the details in its place with the way back.

export function DownloadsPlace(): React.JSX.Element {
  const [ref, width] = useElementWidth()
  const split = width >= SPLIT_FROM
  const detailOpen = useAppStore((store) => store.detailOpen)
  const closeDownload = useAppStore((store) => store.closeDownload)
  const closeDetails = useAppStore((store) => store.closeDetails)
  // Just the one selected: an update to any other download leaves this selector's result alone.
  const selected = useAppStore((store) => {
    const id = store.selectedId
    if (id === null) return null
    const shown = store.downloads[id] ?? store.history.find((entry) => entry.id === id) ?? null
    // A cancelled download leaves the list, and its details with it.
    return shown && !('unitsWritten' in shown) && shown.status === 'cancelled' ? null : shown
  })

  /** Back to its row, where the details were opened from. */
  const backToRow = (id: string | undefined): void => {
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-download-id="${CSS.escape(id ?? '')}"]`)?.focus()
    )
  }
  const close = (): void => {
    const id = selected?.id
    closeDetails()
    backToRow(id)
  }
  const back = (): void => {
    const id = selected?.id
    closeDownload()
    // Back where it was opened from: its row.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-download-id="${CSS.escape(id ?? '')}"]`)?.focus()
    )
  }

  return (
    <div ref={ref} className="flex h-full min-w-0">
      {!split && detailOpen && selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          <Inspector download={selected} onBack={back} />
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1 @container">
            <DownloadsScreen current={split ? selected?.id : undefined} />
          </div>
          {split && selected && (
            <aside
              aria-label="Download details"
              className="w-[400px] shrink-0 overflow-y-auto border-l border-rule bg-card"
            >
              <Inspector download={selected} onClose={close} />
            </aside>
          )}
        </>
      )}
    </div>
  )
}
