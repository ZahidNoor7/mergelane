import type { TrayStatus } from '@shared/trayFlyout'
import { Pause } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import mark from '../assets/brand/mark.svg'
import { useAppStore } from '../store/useAppStore'
import { NetworkTile } from './NetworkTile'
import { SpeedText } from './SpeedText'
import { Button } from './ui/button'

/** The flyout beside Mergelane's notification-area icon on Windows (the design's Windows 11 study,
 * WinTrayFlyout; ADR-0061): the merged speed, each network as the window's sidebar shows it, and the two things
 * people most want from there, Open Mergelane and Pause all. It is its own small window (main/notificationArea.ts),
 * which fits itself to this content, goes away when anything else is clicked, and on Esc. */
export function TrayFlyout(): React.JSX.Element {
  const [status, setStatus] = useState<TrayStatus | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    window.mergelane.trayStatus().then(
      (latest) => {
        if (current && latest) setStatus(latest)
      },
      () => {}
    )
    const stop = window.mergelane.onTrayStatus(setStatus)
    return () => {
      current = false
      stop()
    }
  }, [])

  // The window's theme and units, as they change there.
  const theme = status?.theme
  const unit = status?.unit
  useEffect(() => {
    if (theme) document.documentElement.dataset.palette = theme
    if (unit) useAppStore.setState({ speedUnit: unit })
  }, [theme, unit])

  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.mergelane.closeTrayFlyout()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])

  // The window fits the content: one row per network.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const report = (): void => {
      void window.mergelane.resizeTrayFlyout(element.getBoundingClientRect().height)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const total = status?.total ?? 0
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Mergelane"
      className="flex flex-col gap-3 bg-popover p-3.5 text-foreground"
    >
      <div className="flex items-center gap-2">
        <img src={mark} alt="" aria-hidden className="h-3.5 w-auto" />
        <span className="flex-1 text-[13px] font-[620]">Mergelane</span>
        <SpeedText bytesPerSecond={total} dash={total === 0} className="text-[18px] font-[680]" />
      </div>
      <ul aria-label="Networks" className="flex flex-col">
        {(status?.networks ?? []).map((network) => (
          <li
            key={network.id}
            className="flex items-center gap-2.5 border-t border-rule py-1.5 text-[12.5px]"
          >
            <NetworkTile
              kind={network.kind}
              color={network.color}
              onColor={network.onColor}
              size={18}
              dim={network.out}
            />
            <span className="min-w-0 flex-1 truncate">{network.name}</span>
            {network.out ? (
              <span className="text-[12px] text-destructive">Out</span>
            ) : (
              <SpeedText
                bytesPerSecond={network.speed}
                dash={network.speed === 0}
                className="text-[13px] font-[600]"
              />
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={() => void window.mergelane.openMainWindow()}>
          Open Mergelane
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          disabled={!status?.active}
          onClick={() => void window.mergelane.pauseAllDownloads()}
        >
          <Pause aria-hidden />
          Pause all
        </Button>
      </div>
    </div>
  )
}
