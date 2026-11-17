import type { MenuBarPanelData } from '@shared/menuBarPanel'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

/** How often the open menu asks again: the menu bar item's title changes as often. */
export const MENU_BAR_REFRESH_MS = 1000

/** What the menu bar's menu reads from the main process (ADR-0067): the helper's traffic while System merge is
 * on, and the units, theme and network names the window has saved. Asked for when the menu opens and then once a
 * second, until it closes. The settings go into this page's store, so its speeds and names match the window's.
 * `now` is when it last asked, so "today" moves on at midnight and is current whenever the menu opens. */
export function useMenuBarData(): { data: MenuBarPanelData | null; now: number } {
  const [data, setData] = useState<MenuBarPanelData | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setInterval> | undefined
    const read = (): void => {
      setNow(Date.now())
      window.mergelane.menuBarPanel().then(
        (latest) => {
          if (!current) return
          setData(latest)
          useAppStore.setState({
            speedUnit: latest.speedUnit,
            appearanceTheme: latest.appearanceTheme,
            networkPreferences: latest.networkPreferences
          })
          document.documentElement.dataset.palette = latest.appearanceTheme
        },
        () => {}
      )
    }
    const stop = (): void => {
      clearInterval(timer)
      timer = undefined
    }
    const start = (): void => {
      stop()
      read()
      timer = setInterval(read, MENU_BAR_REFRESH_MS)
    }
    // The page loads when the menu first opens.
    start()
    const stopShown = window.mergelane.onMenuBarPanelShown(start)
    const stopHidden = window.mergelane.onMenuBarPanelHidden(stop)
    return () => {
      current = false
      stop()
      stopShown()
      stopHidden()
    }
  }, [])

  return { data, now }
}
