import {
  MENU_BAR_COMMANDS,
  menuBarNetworks,
  menuBarTotals,
  networkDetail,
  networkUploads,
  networksHeading,
  shareSegments,
  todayLine,
  type MenuBarCommand,
  type MenuBarCommandItem
} from '@shared/menuBarPanel'
import { roleOf } from '@shared/networkRoles'
import { cn } from 'cn'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import mark from '../assets/brand/mark.svg'
import { useDownloadEvents } from '../hooks/useDownloadEvents'
import { useMenuBarData } from '../hooks/useMenuBarData'
import { useNetworkEvents } from '../hooks/useNetworks'
import { useNetworkLanes } from '../hooks/useNetworkLanes'
import { useAppStore } from '../store/useAppStore'
import { todayTotals } from '../utils/dashboard'
import { NetworkTile } from './NetworkTile'
import { SpeedText } from './SpeedText'
import { SplitBar } from './SplitBar'

/** The menu under Mergelane's macOS menu bar icon (the design's "The menu bar menu"; ADR-0067): the merged
 * download and upload with the share each network carries, every network with its own speeds and what it brought
 * in today, then the commands. It is its own small window (main/menuBarPanel.ts) that fits itself to this
 * content, and goes away when anything else is clicked, on Esc, and after a command. The commands are a real
 * menu: the pointer or the arrow keys highlight one, Return chooses it, and ⌘O, ⌘N, ⌘, and ⌘Q choose theirs. */
export function MenuBarPanel(): React.JSX.Element {
  // The window may be closed on the Mac, so the menu keeps its own downloads and networks.
  useDownloadEvents()
  useNetworkEvents()
  const { data, now } = useMenuBarData()
  const lanes = useNetworkLanes()
  const downloads = Object.values(useAppStore((store) => store.downloads))
  const history = useAppStore((store) => store.history)
  const preferences = useAppStore((store) => store.networkPreferences)
  const panel = useRef<HTMLDivElement>(null)

  const today = todayTotals(downloads, history, now)
  const networks = menuBarNetworks({
    lanes,
    system: data?.system ?? null,
    uploads: networkUploads(downloads),
    today: new Map(today.byNetwork.map((network) => [network.id, network.bytes])),
    off: new Set(lanes.filter((lane) => roleOf(preferences[lane.id]) === 'never').map((l) => l.id))
  })
  const { down, up } = menuBarTotals(networks)
  const active = downloads.some(
    (download) => download.status === 'downloading' || download.status === 'queued'
  )

  // The window fits the content: one row per network.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const report = (): void => {
      void window.mergelane.resizeMenuBarPanel(element.getBoundingClientRect().height)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={panel}
      aria-label="Mergelane"
      role="dialog"
      className="flex w-full flex-col bg-popover p-[5px] text-foreground select-none"
    >
      <section aria-label="Merged speed" className="flex flex-col gap-2.5 px-2.5 pt-2 pb-2.5">
        <div className="flex items-center gap-2">
          <img src={mark} alt="" aria-hidden className="h-3.5 w-auto" />
          <h1 className="flex-1 text-[12px] font-[620] text-ink-2">{networksHeading(networks)}</h1>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Total
            label="Download"
            icon={<ArrowDown aria-hidden className="size-3" />}
            value={down}
          />
          <Total label="Upload" icon={<ArrowUp aria-hidden className="size-3" />} value={up} />
        </div>
        <SplitBar segments={shareSegments(networks, down)} />
      </section>
      <span aria-hidden className="mx-2 h-px bg-border" />
      <div
        aria-hidden
        className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 px-2.5 pt-1.5 pb-0.5 text-[11px] text-ink-3"
      >
        <span>Network</span>
        <span className="w-[64px] text-right">↓ Down</span>
        <span className="w-[56px] text-right">↑ Up</span>
      </div>
      <ul aria-label="Networks" className="flex flex-col">
        {networks.map((network) => (
          <li
            key={network.id}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-[5px] px-2.5 py-1.5"
          >
            <span className="flex min-w-0 items-center gap-2">
              <NetworkTile
                kind={network.kind}
                color={network.color}
                onColor={network.onColor}
                size={20}
                dim={network.out || network.off}
              />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-[580]">{network.name}</span>
                <span className="truncate text-[11px] text-ink-3">
                  {networkDetail(network, down)}
                </span>
              </span>
            </span>
            {network.out ? (
              <span className="col-span-2 text-right text-[12px] text-destructive">
                Not connected
              </span>
            ) : (
              <>
                <SpeedText
                  bytesPerSecond={network.down}
                  dash={network.off || network.down === 0}
                  className="w-[64px] text-right text-[13px] font-[600]"
                />
                <SpeedText
                  bytesPerSecond={network.up}
                  dash={network.off || network.up === 0}
                  className="w-[56px] text-right text-[12.5px] font-[560] text-ink-2"
                />
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="px-2.5 pt-0.5 pb-1.5 text-[11px] text-ink-3">{todayLine(networks)}</p>
      <span aria-hidden className="mx-2 my-1 h-px bg-border" />
      <Commands
        disabled={active ? [] : ['pauseAll']}
        speedBesideIcon={data?.speedBesideIcon ?? false}
      />
    </div>
  )
}

function Total({
  label,
  icon,
  value
}: {
  label: string
  icon: React.ReactNode
  value: number
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[11.5px] text-ink-3">
        {icon}
        {label}
      </span>
      <SpeedText
        bytesPerSecond={value}
        dash={value === 0}
        className="text-[22px] leading-none font-[700] tracking-[-0.02em]"
      />
    </div>
  )
}

const choose = (command: MenuBarCommand): void => void window.mergelane.menuBarChoose(command)

/** The commands, as a macOS menu: one highlight, moved by the pointer or the arrow keys. The speed beside the
 * icon is a switch, as macOS's own menu bar menus show one (ADR-0069). */
function Commands({
  disabled,
  speedBesideIcon
}: {
  disabled: MenuBarCommand[]
  speedBesideIcon: boolean
}): React.JSX.Element {
  const [hot, setHot] = useState<MenuBarCommand | null>(null)
  const items = MENU_BAR_COMMANDS.flat()
  const enabled = items.filter((item) => !disabled.includes(item.id)).map((item) => item.id)

  // A disabled command can't stay highlighted.
  const highlighted = hot && enabled.includes(hot) ? hot : null

  // The menu opens again with nothing highlighted, as a macOS menu does.
  useEffect(() => window.mergelane.onMenuBarPanelHidden(() => setHot(null)), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.mergelane.closeMenuBarPanel()
        return
      }
      if (event.metaKey) {
        const command = items.find((item) => item.key === event.key.toLowerCase())
        if (command && enabled.includes(command.id)) {
          event.preventDefault()
          choose(command.id)
        }
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (enabled.length === 0) return
        const at = highlighted ? enabled.indexOf(highlighted) : -1
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next =
          at < 0
            ? step > 0
              ? 0
              : enabled.length - 1
            : (at + step + enabled.length) % enabled.length
        setHot(enabled[next])
        return
      }
      if ((event.key === 'Enter' || event.key === ' ') && highlighted) {
        event.preventDefault()
        choose(highlighted)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div role="menu" aria-label="Commands" className="flex flex-col">
      {MENU_BAR_COMMANDS.map((group, index) => (
        <Fragment key={group[0].id}>
          {index > 0 && <span aria-hidden className="mx-2 my-1 h-px bg-border" />}
          {group.map((item) => (
            <Command
              key={item.id}
              item={item}
              hot={highlighted === item.id}
              disabled={disabled.includes(item.id)}
              checked={item.toggle ? speedBesideIcon : undefined}
              onHot={setHot}
            />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

function Command({
  item,
  hot,
  disabled,
  checked,
  onHot
}: {
  item: MenuBarCommandItem
  hot: boolean
  disabled: boolean
  /** For a switch: whether it's on. */
  checked?: boolean
  onHot: (id: MenuBarCommand | null) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role={item.toggle ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.toggle ? checked === true : undefined}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={item.key ? `Meta+${item.key.toUpperCase()}` : undefined}
      data-highlighted={hot || undefined}
      onPointerEnter={() => onHot(disabled ? null : item.id)}
      onPointerLeave={() => onHot(null)}
      onClick={() => {
        if (!disabled) choose(item.id)
      }}
      className={cn(
        'flex h-[24px] items-center gap-2 rounded-[5px] px-2 text-left text-[13px] outline-none',
        hot && 'bg-primary text-primary-foreground',
        disabled && 'text-ink-3'
      )}
    >
      <span className="flex-1">{item.label}</span>
      {item.key && (
        <span
          aria-hidden
          className={cn('text-[12px]', hot ? 'text-primary-foreground/80' : 'text-ink-3')}
        >
          ⌘{item.key.toUpperCase()}
        </span>
      )}
      {item.toggle && <MiniSwitch on={checked === true} hot={hot} />}
    </button>
  )
}

/** A small switch, drawn only: the menu item it sits in is the control. On the highlight's accent it turns
 * light, so it still reads. */
function MiniSwitch({ on, hot }: { on: boolean; hot: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-on={on || undefined}
      className={cn(
        'relative inline-flex h-[14px] w-[24px] shrink-0 rounded-full transition-colors duration-150',
        on
          ? hot
            ? 'bg-primary-foreground/45'
            : 'bg-primary'
          : hot
            ? 'bg-primary-foreground/25'
            : 'bg-track'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-[10px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] motion-safe:transition-transform motion-safe:duration-150',
          on && 'translate-x-[10px]'
        )}
      />
    </span>
  )
}
