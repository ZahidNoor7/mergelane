import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { NewDownloadDialog } from './components/NewDownloadDialog'
import { CompactBar, Sidebar, SIDEBAR_FROM } from './components/WindowChrome'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useElementWidth } from './hooks/useElementWidth'
import { useNetworkEvents } from './hooks/useNetworks'
import { useNewDownloadShortcuts, useOpenedLinks } from './hooks/useOpenedLinks'
import { DashboardScreen } from './screens/DashboardScreen'
import { DownloadsPlace } from './screens/DownloadsPlace'
import { useAppStore } from './store/useAppStore'

/** The place the window shows: the downloads (with a download's details) or the dashboard. Only
 * this re-renders on a progress update; App, the frame and the dialogs around it don't. */
function CurrentScreen(): React.JSX.Element {
  const dashboard = useAppStore((store) => store.screen === 'dashboard')
  return dashboard ? <DashboardScreen /> : <DownloadsPlace />
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
