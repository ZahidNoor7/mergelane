import { CopiedLinkOffer } from './components/CopiedLinkOffer'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { NewDownloadDialog } from './components/NewDownloadDialog'
import { CompactBar, Sidebar, SIDEBAR_FROM } from './components/WindowChrome'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useElementWidth } from './hooks/useElementWidth'
import { useDiagnosticsMenu, useNetworkEvents } from './hooks/useNetworks'
import { useNewDownloadShortcuts, useOpenedLinks } from './hooks/useOpenedLinks'
import { useSettingsShortcut } from './hooks/useSettingsShortcut'
import { useGlassAttributes } from './hooks/useGlassAttributes'
import { useCopiedLinks } from './hooks/useCopiedLinks'
import { useUpdates } from './hooks/useUpdates'
import { DashboardScreen } from './screens/DashboardScreen'
import { DownloadsPlace } from './screens/DownloadsPlace'
import { NetworksScreen } from './screens/NetworksScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useAppStore } from './store/useAppStore'

/** The place the window shows: the downloads (with a download's details), the dashboard or the
 * networks. Only
 * this re-renders on a progress update; App, the frame and the dialogs around it don't. */
function CurrentScreen(): React.JSX.Element {
  const screen = useAppStore((store) => store.screen)
  return screen === 'dashboard' ? (
    <DashboardScreen />
  ) : screen === 'networks' ? (
    <NetworksScreen />
  ) : screen === 'settings' ? (
    <SettingsScreen />
  ) : (
    <DownloadsPlace />
  )
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useOpenedLinks()
  useNewDownloadShortcuts()
  useSettingsShortcut()
  useGlassAttributes()
  useNetworkEvents()
  useDiagnosticsMenu()
  useUpdates()
  useCopiedLinks()
  // The final design's frame: a sidebar from 760px of window width, a compact bar below it. Until
  // the first measurement, the sidebar (the window opens wider than that). The screens size their
  // layout by <main>'s width (a container), not the window's, since the sidebar takes part of it.
  const [windowRef, width] = useElementWidth()
  const sidebar = width === 0 || width >= SIDEBAR_FROM

  return (
    <TooltipProvider>
      <DownloadActionsProvider>
        <div ref={windowRef} className="ml-window flex h-full bg-window text-foreground">
          {sidebar && <Sidebar />}
          <div
            className={`ml-content flex min-w-0 flex-1 flex-col bg-background ${sidebar ? 'ml-content-side' : ''}`}
          >
            {!sidebar && <CompactBar />}
            {!sidebar && <CopiedLinkOffer layout="bar" />}
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
