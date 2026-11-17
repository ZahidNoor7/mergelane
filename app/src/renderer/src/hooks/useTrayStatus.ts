import type { TrayStatus } from '@shared/trayFlyout'
import { useEffect } from 'react'
import { useNetworkLanes } from './useNetworkLanes'
import { onWindows } from '../platformWords'
import { useAppStore } from '../store/useAppStore'

/** On Windows, the window keeps the notification-area flyout current (main/notificationArea.ts, ADR-0061): it
 * publishes what its sidebar shows (each network's name, colour and speed, and the merged speed), the units
 * and the theme, whenever they change, so the two never disagree. It also opens the place the icon's menu
 * asks for, on Windows and on the Mac: Settings, Networks when System merge was refused, or New download. */
export function useTrayStatus(): void {
  const win = onWindows()
  const lanes = useNetworkLanes()
  const unit = useAppStore((store) => store.speedUnit)
  const theme = useAppStore((store) => store.appearanceTheme)
  const active = useAppStore((store) =>
    Object.values(store.downloads).some(
      (download) => download.status === 'downloading' || download.status === 'queued'
    )
  )
  const openSettings = useAppStore((store) => store.openSettings)
  const setScreen = useAppStore((store) => store.setScreen)
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  const status: TrayStatus = {
    total: lanes.reduce((sum, lane) => sum + (lane.out ? 0 : lane.speed), 0),
    active,
    unit,
    theme,
    networks: lanes
  }
  // A string, so a render that changes nothing the flyout shows sends nothing.
  const published = JSON.stringify(status)

  useEffect(() => {
    if (!win) return
    void window.mergelane.publishTrayStatus(JSON.parse(published) as TrayStatus)
  }, [win, published])

  // The menu bar's menu showed or hid the speed beside its icon: Settings shows the new choice (ADR-0069). Main has
  // saved it already.
  useEffect(
    () =>
      window.mergelane.onMenuBarSpeedTextChanged((menuBarSpeedText) =>
        useAppStore.setState({ menuBarSpeedText })
      ),
    []
  )

  // The notification area's menu on Windows, and the menu bar's menu on the Mac (ADR-0067).
  useEffect(
    () =>
      window.mergelane.onShowPlace((place) => {
        if (place === 'settings') openSettings()
        else if (place === 'newDownload') openNewDownload()
        else setScreen('networks')
      }),
    [openSettings, openNewDownload, setScreen]
  )
}
