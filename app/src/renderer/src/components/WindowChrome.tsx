import { cn } from 'cn'
import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  Gauge,
  HardDrive,
  LayoutDashboard,
  Settings,
  Unplug,
  Waypoints
} from 'lucide-react'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useFreeSpace } from '../hooks/useFreeSpace'
import { hasUpdate } from '../hooks/useUpdates'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore, type Screen } from '../store/useAppStore'
import { networkSummaries } from '../utils/dashboard'
import { formatBytes } from '../utils/format'
import { NetworkTile } from './NetworkTile'
import { SpeedText } from './SpeedText'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { UpdateNotice } from './UpdateNotice'
import { HelperUpdateNotice } from './HelperUpdateNotice'
import { CopiedLinkOffer } from './CopiedLinkOffer'
import { onWindows, words } from '../platformWords'
import appIcon from '../assets/brand/icon-128.png'

// The window's frame in the final design (design-system/mergelane/redesign/prototype.html, Sidebar and
// CompactBar): a sidebar from 760px of window width, a compact bar below. The macOS window buttons sit at
// their top left (main/index.ts trafficLightPosition), on a strip the window is dragged by.
//
// Settings is at the sidebar's foot (a button in the compact bar), opened by ⌘, too (App.tsx).
//
// On Windows the same window follows the design's Windows 11 study (ADR-0060): a 32px title bar across the top
// (WinTitleBar), with Windows' own window buttons at its right; the sidebar is a navigation pane straight on the
// window's Mica, its current place on a quiet 4px backplate with a short accent pill at its left edge that
// slides to the new place; the content sits on one layer below.

/** Width of the window at which the sidebar replaces the compact bar. */
export const SIDEBAR_FROM = 760

type Place = Screen

const PLACES: { id: Exclude<Place, 'settings'>; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'downloads', label: 'Downloads', icon: ArrowDownToLine },
  { id: 'networks', label: 'Networks', icon: Waypoints }
]

/** Where the window is: the dashboard, or the downloads (the list, and a download's details). */
function usePlace(): [Place, (place: Place) => void] {
  const place = useAppStore((store) => store.screen)
  const setScreen = useAppStore((store) => store.setScreen)
  return [place, setScreen]
}

/** Every network, live: its tile, name and speed, or that it's out. */
function useNetworkLanes(): {
  id: string
  kind: Parameters<typeof NetworkTile>[0]['kind']
  name: string
  color: string
  onColor: string
  speed: number
  out: boolean
}[] {
  const interfaces = useAppStore((store) => store.interfaces)
  const downloads = useAppStore((store) => store.downloads)
  const visual = useNetworkVisuals()
  return networkSummaries(interfaces, Object.values(downloads), {}, {}).map((network) => {
    const look = visual(network.id, network.kind, network.osName)
    return {
      id: network.id,
      kind: network.kind,
      name: look.name,
      color: look.solid,
      onColor: look.onSolid,
      speed: network.speed,
      out: network.condition === 'offline'
    }
  })
}

function SlowModeSwitch({ withLabel }: { withLabel: boolean }): React.JSX.Element {
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const setSlowMode = useAppStore((store) => store.setSlowMode)
  const formatSpeedLimit = useFormatSpeedLimit()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="flex items-center justify-between gap-2 text-[12.5px] font-[560] text-ink-2">
            <span className={cn('flex items-center gap-1.5', !withLabel && 'sr-only')}>
              <Gauge aria-hidden className="size-3.5" />
              Slow mode
            </span>
            <Switch checked={slowMode} onCheckedChange={setSlowMode} />
          </label>
        }
      />
      <TooltipContent>
        Limit downloads and uploads to {formatSpeedLimit(slowModeSpeed)} each
      </TooltipContent>
    </Tooltip>
  )
}

const NAV_ITEM =
  'flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2 text-[13px] font-[580] text-ink-2 transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-selected aria-[current=page]:bg-selected aria-[current=page]:text-foreground [&[aria-current=page]_svg]:text-[var(--color-accent-ink)]'

/** Windows 11's navigation item (NavigationView, left pane): 36px, a 4px backplate on the current place. */
const WIN_NAV_ITEM =
  'relative flex h-9 w-full items-center gap-3 rounded-[4px] px-3 text-[13.5px] font-[540] text-foreground transition-colors duration-100 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:opacity-80 aria-[current=page]:bg-selected aria-[current=page]:font-[620]'

/** A navigation item's pitch on Windows: 36px, and the list's 2px gap. */
export const NAV_PITCH = 38

/** Windows 11's selection pill: one for the whole list, sliding to the current place (centred on its 36px
 * row). It moves with a transition, so a click mid-slide turns it from where it is; reduced motion jumps. */
export function NavPill({ index }: { index: number }): React.JSX.Element | null {
  if (index < 0) return null
  return (
    <span
      aria-hidden
      data-testid="nav-pill"
      className="pointer-events-none absolute top-0 left-0 z-10 h-4 w-[3px] rounded-full bg-primary transition-[translate] duration-[350ms] ease-[cubic-bezier(0.2,0.9,0.25,1)] motion-reduce:transition-none"
      style={{ translate: `0 ${index * NAV_PITCH + 10}px` }}
    />
  )
}

/** Whether the window has the focus, following it as it comes and goes. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const focus = (): void => setFocused(true)
    const blur = (): void => setFocused(false)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return focused
}

/** Windows 11's title bar (the design's Windows study): 32px, the window icon 16px from the left edge, the title
 * 16px after it in caption text. Windows draws minimise, maximise and close at its right
 * (main/windowBackground.ts titleBarOverlay), so snap layouts work. The window is dragged by it. While another
 * window has the focus, the icon and title are semi-transparent, as Microsoft's title bar guidance asks. */
export function WinTitleBar(): React.JSX.Element {
  const focused = useWindowFocused()
  return (
    <div
      data-inactive={focused ? undefined : ''}
      className="ml-titlebar window-drag flex h-8 shrink-0 items-center transition-opacity duration-100 select-none data-[inactive]:opacity-50"
    >
      <img src={appIcon} alt="" aria-hidden className="ml-4 size-4" />
      <span className="truncate pl-4 text-[12px] text-foreground">Mergelane</span>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const [place, setPlace] = usePlace()
  const settings = place === 'settings'
  const openSettings = useAppStore((store) => store.openSettings)
  const updateOut = useAppStore((store) => hasUpdate(store.update))
  const lanes = useNetworkLanes()
  const inProgress = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) =>
        ['downloading', 'queued', 'paused'].includes(download.status)
      ).length
  )
  const destinationDir = useAppStore((store) => store.destinationDir)
  const free = useFreeSpace(destinationDir)
  const { message: schedule } = useDownloadSchedule()
  const merged = lanes.reduce((sum, lane) => sum + (lane.out ? 0 : lane.speed), 0)
  const win = onWindows()
  const navItem = win ? WIN_NAV_ITEM : NAV_ITEM
  const pad = win ? 'px-3' : 'px-1.5'

  return (
    <div className={cn('flex shrink-0', win ? 'w-[248px] p-1' : 'w-[236px] p-2')}>
      <div
        className={cn(
          'flex w-full flex-col',
          win
            ? 'px-1.5 pb-2'
            : 'ml-surface rounded-[12px] bg-sidebar px-2.5 pb-2.5 shadow-[inset_0_0_0_1px_var(--border-subtle)]'
        )}
      >
        {/* The window buttons' strip: the window is dragged by it. Windows has its title bar instead. */}
        {!win && <div className="window-drag -mx-2.5 h-10 shrink-0" />}
        <nav
          aria-label="Mergelane"
          className={cn('relative flex flex-col gap-0.5', win ? 'mt-1' : 'mt-2')}
        >
          {win && <NavPill index={PLACES.findIndex((each) => each.id === place)} />}
          {PLACES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={place === item.id ? 'page' : undefined}
              onClick={() => setPlace(item.id)}
              className={navItem}
            >
              <item.icon aria-hidden className="size-4" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.id === 'downloads' && inProgress > 0 && (
                <>
                  <span aria-hidden className="figures text-[12.5px] text-ink-3">
                    {inProgress}
                  </span>
                  <span className="sr-only">{`, ${inProgress} in progress`}</span>
                </>
              )}
            </button>
          ))}
        </nav>

        {/* Not a labelled region: the dashboard has the Networks region. The heading still
            structures the sidebar for a screen reader. */}
        <section className={cn('flex flex-col gap-1', win ? 'mt-5' : 'mt-7')}>
          <h2 className={cn('text-[12px] font-[650] text-ink-3', win ? 'px-3' : 'px-2')}>
            Networks
          </h2>
          <ul className="flex flex-col">
            {lanes.map((lane) => (
              <li
                key={lane.id}
                className={cn(
                  'flex h-9 items-center gap-2.5',
                  win ? 'rounded-[4px] px-3' : 'rounded-[9px] px-2'
                )}
              >
                <NetworkTile
                  kind={lane.kind}
                  color={lane.color}
                  onColor={lane.onColor}
                  size={20}
                  dim={lane.out}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-[560]">{lane.name}</span>
                {lane.out ? (
                  <span className="inline-flex items-center gap-1 text-[12px] text-destructive">
                    <Unplug aria-hidden className="size-3" />
                    Out
                  </span>
                ) : (
                  <SpeedText
                    bytesPerSecond={lane.speed}
                    dash={lane.speed === 0}
                    className="text-[13.5px] font-[600]"
                  />
                )}
              </li>
            ))}
          </ul>
          <div
            className={cn(
              'mt-1.5 flex items-baseline justify-between border-t border-rule pt-2',
              win ? 'mx-3' : 'mx-2'
            )}
          >
            <span className="text-[12.5px] font-[620]">Merged</span>
            <SpeedText
              bytesPerSecond={merged}
              dash={merged === 0}
              className="text-[17px] font-[680]"
            />
          </div>
        </section>

        <div className="mt-auto flex flex-col gap-3 pt-4">
          <CopiedLinkOffer layout="sidebar" />
          <UpdateNotice />
          <HelperUpdateNotice />
          {schedule && <p className={cn('text-[12px] leading-snug text-ink-2', pad)}>{schedule}</p>}
          {free !== null && (
            <p className={cn('flex items-center gap-1.5 text-[12px] text-ink-3', pad)}>
              <HardDrive aria-hidden className="size-3.5" />
              {formatBytes(free)} free
            </p>
          )}
          <div className={pad}>
            <SlowModeSwitch withLabel />
          </div>
          {/* Settings, as the design's sidebar ends: to Updates, with a dot, when one is out. On Windows its
              pill is its own, at the foot. */}
          <div className={cn('relative border-t border-rule', win ? 'pt-1.5' : '-mx-1 pt-2')}>
            {win && settings && (
              <span
                aria-hidden
                data-testid="nav-pill"
                className="pointer-events-none absolute top-[16px] left-0 z-10 h-4 w-[3px] rounded-full bg-primary"
              />
            )}
            <button
              type="button"
              aria-current={settings ? 'page' : undefined}
              onClick={() => openSettings(updateOut ? 'updates' : undefined)}
              className={navItem}
            >
              <Settings aria-hidden className="size-4" />
              <span className="flex-1 text-left">Settings</span>
              {updateOut ? (
                <span
                  role="img"
                  aria-label="Update available"
                  className="size-2 rounded-full bg-primary"
                />
              ) : (
                <kbd className="font-mono text-[11px] font-normal text-ink-3">
                  {words().settingsShortcut}
                </kbd>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The narrow window's frame: the merged speed and the places as a segmented control. */
export function CompactBar(): React.JSX.Element {
  const [place, setPlace] = usePlace()
  const settings = place === 'settings'
  const openSettings = useAppStore((store) => store.openSettings)
  const updateOut = useAppStore((store) => hasUpdate(store.update))
  const lanes = useNetworkLanes()
  const merged = lanes.reduce((sum, lane) => sum + (lane.out ? 0 : lane.speed), 0)
  const win = onWindows()
  return (
    <div
      className={cn(
        'ml-compactbar flex flex-col gap-2.5 border-b border-rule pt-3 pr-3 pb-2.5 pl-3',
        // On Windows the title bar above holds the window buttons and drags the window.
        win ? 'bg-background' : 'ml-surface window-drag bg-sidebar'
      )}
    >
      <div className="flex min-h-7 items-center gap-3">
        {/* Room for the window buttons. */}
        {!win && <span aria-hidden className="w-[64px] shrink-0" />}
        <span className="flex items-baseline gap-1.5 text-[12px] text-ink-2">
          Merged
          <SpeedText
            bytesPerSecond={merged}
            dash={merged === 0}
            className="text-[15px] font-[680] text-foreground"
          />
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <SlowModeSwitch withLabel={false} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={updateOut ? 'Settings, update available' : 'Settings'}
            aria-current={settings ? 'page' : undefined}
            onClick={() => openSettings(updateOut ? 'updates' : undefined)}
          >
            <Settings />
          </Button>
        </div>
      </div>
      <nav aria-label="Mergelane">
        <ToggleGroup
          aria-label="Section"
          value={[place]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setPlace(values[0] as Place)
          }}
        >
          {PLACES.map((item) => (
            <ToggleGroupItem key={item.id} value={item.id}>
              <item.icon aria-hidden />
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </nav>
    </div>
  )
}
