import type { TrayStatus } from '@shared/trayFlyout'
import { useEffect } from 'react'
import { useNetworkLanes } from './useNetworkLanes'
import { onWindows } from '../platformWords'
import { useAppStore } from '../store/useAppStore'

/** On Windows, the window keeps the notification-area flyout current (main/notificationArea.ts, ADR-0061): it
 * publishes what its sidebar shows (each network's name, colour and speed, and the merged speed), the units
 * and the theme, whenever they change, so the two never disagree. It also opens the place the icon's menu
 * asks for: Settings, or Networks when System merge was refused. */
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

  useEffect(() => {
    if (!win) return
    return window.mergelane.onShowPlace((place) => {
      if (place === 'settings') openSettings()
      else setScreen('networks')
    })
  }, [win, openSettings, setScreen])
}
