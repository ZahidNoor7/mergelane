import type { DownloadState, FinishedDownload } from '@shared/types'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { NewDownloadDialog } from './components/NewDownloadDialog'
import { CompactBar, Sidebar, SIDEBAR_FROM } from './components/WindowChrome'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useElementWidth } from './hooks/useElementWidth'
import { useNetworkEvents } from './hooks/useNetworks'
import { useNewDownloadShortcuts, useOpenedLinks } from './hooks/useOpenedLinks'
import { CompleteScreen } from './screens/CompleteScreen'
import { DashboardScreen } from './screens/DashboardScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { DownloadsScreen } from './screens/DownloadsScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen per download.status — a switch with an assertNever default so a new
 * DownloadStatus value is a compile error here instead of silently falling into whichever branch
 * happened to be last. */
function renderDownload(download: DownloadState | FinishedDownload): React.JSX.Element {
  if ('unitsWritten' in download) return <CompleteScreen download={download} />
  switch (download.status) {
    case 'queued':
    case 'downloading':
    case 'paused':
      return <DownloadingScreen download={download} />
    case 'completed':
      return <CompleteScreen download={download} />
    case 'error':
    case 'cancelled':
      return <ErrorScreen download={download} />
    default:
      return assertNever(download.status)
  }
}

/** The download shown, the dashboard, or the list. Only this re-renders on a progress update —
 * App, the title bar, the status bar and the dialogs around it don't. */
function CurrentScreen(): React.JSX.Element {
  const dashboard = useAppStore((store) => store.view.name === 'dashboard')
  // Just the one shown: an update to any other download leaves this selector's result alone.
  const shown = useAppStore((store) => {
    const { view } = store
    if (view.name !== 'download') return null
    // A download that's gone (removed, deleted) leaves the list showing.
    return store.downloads[view.id] ?? store.history.find((entry) => entry.id === view.id) ?? null
  })
  const cancelled = shown && !('unitsWritten' in shown) && shown.status === 'cancelled'
  if (dashboard) return <DashboardScreen />
  return shown && !cancelled ? renderDownload(shown) : <DownloadsScreen />
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useOpenedLinks()
  useNewDownloadShortcuts()
  useNetworkEvents()
  // The final design's frame: a sidebar from 760px of window width, a compact bar below it. Until
  // the first measurement, the sidebar (the window opens wider than that). The screens size their
  // layout by <main>'s width (a container), not the window's, since the sidebar takes part of it.
  const [windowRef, width] = useElementWidth()
  const sidebar = width === 0 || width >= SIDEBAR_FROM

  return (
    <TooltipProvider>
      <DownloadActionsProvider>
        <div ref={windowRef} className="flex h-full bg-window text-foreground">
          {sidebar && <Sidebar />}
          <div className="flex min-w-0 flex-1 flex-col bg-background">
            {!sidebar && <CompactBar />}
            <main className="@container min-h-0 flex-1">
              <CurrentScreen />
            </main>
          </div>
          <NewDownloadDialog />
          <NetworkBindingDialog />
        </div>
      </DownloadActionsProvider>
    </TooltipProvider>
  )
}

export default App
