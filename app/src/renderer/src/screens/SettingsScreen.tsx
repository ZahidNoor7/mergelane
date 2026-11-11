import { THEMES, type ThemeSeeds } from '@shared/themes'
import {
  DOWNLOADS_AT_ONCE,
  type GlassLook,
  type ThemeSource,
  type UsenetServer
} from '@shared/types'
import { cn } from 'cn'
import {
  ArrowDownToLine,
  CalendarClock,
  Check,
  FolderOpen,
  Gauge,
  Monitor,
  Moon,
  Newspaper,
  Palette,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  Sun
} from 'lucide-react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { LimitsDialog } from '../components/LimitsDialog'
import { NetworkTile } from '../components/NetworkTile'
import { SpeedText } from '../components/SpeedText'
import { SpeedUnitToggle } from '../components/SpeedUnitToggle'
import { DiagnosticsSettings } from '../components/DiagnosticsSettings'
import { ExtensionSettings } from '../components/ExtensionSettings'
import { OnThisMacSettings } from '../components/OnThisMacSettings'
import { SettingRow, SettingsGroup } from '../components/settingsParts'
import { UpdateSettings } from '../components/UpdateSettings'
import { UsenetServerDialog } from '../components/UsenetServerDialog'
import { Button } from '../components/ui/button'
import { Switch } from '../components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { useElementWidth } from '../hooks/useElementWidth'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useMergeLanes } from '../hooks/useMergeLanes'
import { hasUpdate } from '../hooks/useUpdates'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { usePrefersDark } from '../hooks/usePrefersDark'
import { useAppStore, type SettingsSection } from '../store/useAppStore'
import { toDisplayPath } from '../utils/format'

// Settings, from the final design (design-system/mergelane/redesign/prototype.html, SettingsScreen):
// General, Appearance, Downloads, Browser extensions and Updates.
//
// The schedule, the total speed and slow mode's speed are still edited in the Speed & data limits
// dialog, and the news server in its own: the rows here open them.

const SECTIONS: { id: SettingsSection; label: string; short: string; icon: typeof Palette }[] = [
  { id: 'general', label: 'General', short: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', short: 'Appearance', icon: Palette },
  { id: 'downloads', label: 'Downloads', short: 'Downloads', icon: ArrowDownToLine },
  { id: 'extensions', label: 'Browser extensions', short: 'Extensions', icon: Puzzle },
  { id: 'updates', label: 'Updates', short: 'Updates', icon: RefreshCw }
]

/** Width of Settings' content from which its sections are a list beside it, not a segmented row. */
const SIDE_FROM = 620

export function SettingsScreen(): React.JSX.Element {
  const section = useAppStore((store) => store.settingsSection)
  const openSettings = useAppStore((store) => store.openSettings)
  const [ref, width] = useElementWidth()
  const side = width === 0 || width >= SIDE_FROM
  const current = SECTIONS.find((each) => each.id === section)!
  const Body = {
    general: GeneralSettings,
    appearance: AppearanceSettings,
    downloads: DownloadSettings,
    extensions: ExtensionSettings,
    updates: UpdateSettings
  }[current.id]
  const updateOut = useAppStore((store) => hasUpdate(store.update))

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="window-drag flex min-h-14 shrink-0 flex-col justify-center border-b border-rule px-4 py-2.5">
        <h1 className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em]">
          Settings
        </h1>
        <p className="truncate text-[12px] leading-snug text-ink-3">
          Everything you can change in Mergelane, in one place
        </p>
      </div>
      <div ref={ref} className={cn('flex min-h-0 flex-1', side ? 'flex-row' : 'flex-col')}>
        {side ? (
          <nav
            aria-label="Settings sections"
            className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-rule p-2"
          >
            {SECTIONS.map((each) => (
              <button
                key={each.id}
                type="button"
                aria-current={each.id === current.id ? 'page' : undefined}
                onClick={() => openSettings(each.id)}
                className="flex h-8 items-center gap-2.5 rounded-[9px] px-2 text-[13px] font-[580] text-ink-2 transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-selected aria-[current=page]:text-foreground [&[aria-current=page]_svg]:text-[var(--color-accent-ink)]"
              >
                <each.icon aria-hidden className="size-4" />
                <span className="flex-1 text-left">{each.label}</span>
                {each.id === 'updates' && updateOut && (
                  <span
                    role="img"
                    aria-label="Update available"
                    className="size-2 rounded-full bg-primary"
                  />
                )}
              </button>
            ))}
          </nav>
        ) : (
          <div className="overflow-x-auto border-b border-rule px-3 py-2 [scrollbar-width:none]">
            <ToggleGroup
              aria-label="Settings sections"
              value={[current.id]}
              onValueChange={(values) => {
                if (values[0] !== undefined) openSettings(values[0] as SettingsSection)
              }}
            >
              {SECTIONS.map((each) => (
                <ToggleGroupItem key={each.id} value={each.id}>
                  <each.icon aria-hidden />
                  {each.short}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto @container">
          <div className="flex max-w-[780px] flex-col gap-7 px-5 pt-5 pb-10">
            <h2 className="sr-only">{current.label}</h2>
            <Body />
          </div>
        </div>
      </div>
    </div>
  )
}

/* General */
function GeneralSettings(): React.JSX.Element {
  const speedUnit = useAppStore((store) => store.speedUnit)
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const speedLimit = useAppStore((store) => store.speedLimit)
  const setSlowMode = useAppStore((store) => store.setSlowMode)
  const formatSpeedLimit = useFormatSpeedLimit()
  const { active } = useMergeLanes()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const slowId = useId()
  return (
    <>
      <SettingsGroup
        title="Speeds"
        description="Used everywhere a speed appears: the sidebar, every download, the charts and their axes, and limits."
      >
        <SettingRow
          label="Show speeds in"
          hint={
            speedUnit === 'bits'
              ? 'Megabits per second, the way internet providers quote speeds. 8 Mbps is 1 MB/s.'
              : 'Megabytes per second, dropping to KB/s below 1 MB/s. Matches the sizes Finder shows.'
          }
        >
          <SpeedUnitToggle />
        </SettingRow>
        <p
          aria-live="polite"
          className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-rule py-3 text-[12.5px] text-ink-2 last:border-b-0"
        >
          <span className="text-ink-3">Right now</span>
          <span className="flex items-baseline gap-2">
            Merged
            <SpeedText
              bytesPerSecond={active.totalSpeed}
              dash={active.totalSpeed === 0}
              className="text-[15px] font-[640] text-foreground"
            />
          </span>
        </p>
        <SettingRow
          label="Slow mode"
          htmlFor={slowId}
          hint={`Caps all of Mergelane’s downloads at ${formatSpeedLimit(slowModeSpeed)} in total, so calls and streaming stay smooth. Also in the sidebar.`}
        >
          <Switch id={slowId} checked={slowMode} onCheckedChange={setSlowMode} />
        </SettingRow>
        <SettingRow
          label="Total speed"
          hint={
            speedLimit === undefined
              ? 'No limit on all downloads together.'
              : `All downloads together are limited to ${formatSpeedLimit(speedLimit)}.`
          }
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setLimitsPage(null)
              setLimitsOpen(true)
            }}
          >
            <Gauge data-icon="inline-start" />
            Change…
          </Button>
        </SettingRow>
      </SettingsGroup>
      <OnThisMacSettings />
      <DiagnosticsSettings />
      <LimitsDialog
        open={limitsOpen}
        showSchedule={false}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </>
  )
}

/* Appearance */

/** A theme's look in miniature: the sidebar, a toolbar, three network lanes and a download. */
function ThemeMiniWindow({ seeds }: { seeds: ThemeSeeds }): React.JSX.Element {
  const nets = [seeds.wifi, seeds.usb, seeds.ethernet]
  const ink = seeds.sidebarInk ?? seeds.text
  return (
    <span
      aria-hidden
      className="flex h-[96px] w-full overflow-hidden rounded-[9px]"
      style={{ background: seeds.window, boxShadow: `0 0 0 1px ${seeds.text}1f` }}
    >
      <span
        className="flex w-[34%] shrink-0 flex-col gap-[5px] p-[7px]"
        style={{ background: seeds.sidebar }}
      >
        <span className="mb-[3px] flex gap-[3px]">
          {['#FF5F57', '#FEBC2E', '#28C840'].map((light) => (
            <span key={light} className="size-[5px] rounded-full" style={{ background: light }} />
          ))}
        </span>
        {[0.78, 0.6, 0.66].map((share, index) => (
          <span
            key={share}
            className="flex h-[11px] items-center gap-[4px] rounded-[4px] px-[4px]"
            style={{ background: index === 0 ? `${seeds.accent}2e` : 'transparent' }}
          >
            <span
              className="size-[5px] rounded-[1.5px]"
              style={{ background: index === 0 ? seeds.accent : `${ink}70` }}
            />
            <span
              className="h-[3px] rounded-full"
              style={{ width: `${share * 60}%`, background: index === 0 ? ink : `${ink}80` }}
            />
          </span>
        ))}
        <span className="mt-auto flex flex-col gap-[3px]">
          {nets.map((net) => (
            <span key={net} className="flex items-center gap-[3px]">
              <span className="size-[6px] rounded-[2px]" style={{ background: net }} />
              <span className="h-[2.5px] w-[45%] rounded-full" style={{ background: `${ink}66` }} />
            </span>
          ))}
        </span>
      </span>
      <span
        className="flex min-w-0 flex-1 flex-col gap-[6px] p-[8px]"
        style={{ background: seeds.bg }}
      >
        <span className="flex items-center gap-[4px]">
          <span className="h-[5px] w-[38%] rounded-full" style={{ background: seeds.text }} />
          <span
            className="ml-auto h-[11px] w-[30%] rounded-full"
            style={{ background: seeds.accent }}
          />
        </span>
        <svg viewBox="0 0 100 26" preserveAspectRatio="none" className="h-[24px] w-full">
          {nets.map((net, index) => {
            const from = 4 + index * 9
            const to = 9.5 + index * 3.5
            return (
              <path
                key={net}
                d={`M3,${from} C30,${from} 30,${to} 58,${to} L100,${to}`}
                fill="none"
                stroke={net}
                strokeWidth={[3.4, 2.4, 3.8][index]}
                strokeLinecap="round"
              />
            )
          })}
        </svg>
        <span
          className="flex flex-col gap-[4px] rounded-[5px] p-[5px]"
          style={{ background: seeds.card, boxShadow: `0 0 0 1px ${seeds.text}14` }}
        >
          <span
            className="h-[3px] w-[64%] rounded-full"
            style={{ background: `${seeds.text}cc` }}
          />
          <span
            className="flex h-[3px] gap-[1px] overflow-hidden rounded-full"
            style={{ background: `${seeds.text}18` }}
          >
            <span style={{ width: '30%', background: nets[0] }} />
            <span style={{ width: '12%', background: nets[1] }} />
            <span style={{ width: '24%', background: nets[2] }} />
          </span>
        </span>
      </span>
    </span>
  )
}

const MODES: { value: ThemeSource; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Auto', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
]

function AppearanceSettings(): React.JSX.Element {
  const themeSource = useAppStore((store) => store.themeSource)
  const setThemeSource = useAppStore((store) => store.setThemeSource)
  const appearanceTheme = useAppStore((store) => store.appearanceTheme)
  const setAppearanceTheme = useAppStore((store) => store.setAppearanceTheme)
  const interfaces = useAppStore((store) => store.interfaces)
  const networkVisual = useNetworkVisuals()
  const macDark = usePrefersDark()
  const dark = themeSource === 'dark' || (themeSource === 'system' && macDark)
  const titleId = useId()
  return (
    <>
      <SettingsGroup title="Light or dark">
        <SettingRow
          label="Appearance"
          hint={
            themeSource === 'system'
              ? `Follows your Mac, which is ${macDark ? 'dark' : 'light'} right now.`
              : `Always ${themeSource}, whatever your Mac uses.`
          }
        >
          <ToggleGroup
            aria-label="Light or dark"
            value={[themeSource]}
            onValueChange={(values) => {
              if (values[0] !== undefined) setThemeSource(values[0] as ThemeSource)
            }}
          >
            {MODES.map((mode) => (
              <ToggleGroupItem key={mode.value} value={mode.value}>
                <mode.icon aria-hidden />
                {mode.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
      </SettingsGroup>

      <section aria-labelledby={titleId} className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5 px-1">
          <h3 id={titleId} className="text-[13.5px] font-[650]">
            Theme
          </h3>
          <p className="max-w-[64ch] text-[12.5px] leading-[1.5] text-ink-2">
            A theme sets every colour in the window: grounds, the sidebar, cards, lines, text,
            buttons, switches, selection, focus rings and the three network colours. Previews show
            the {dark ? 'dark' : 'light'} version.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby={titleId}
          className="grid grid-cols-1 gap-3 @min-[448px]:grid-cols-2 @min-[768px]:grid-cols-3"
        >
          {THEMES.map((theme) => {
            const on = appearanceTheme === theme.id
            return (
              <label
                key={theme.id}
                className={cn(
                  'flex flex-col gap-2.5 rounded-[14px] bg-card p-2.5 transition-[background-color,box-shadow] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                  on
                    ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
                    : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover'
                )}
              >
                <input
                  type="radio"
                  name="mergelane-theme"
                  value={theme.id}
                  checked={on}
                  onChange={() => setAppearanceTheme(theme.id)}
                  className="sr-only"
                />
                <ThemeMiniWindow seeds={dark ? theme.dark : theme.light} />
                <span className="flex items-start gap-2 px-0.5 pb-0.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] leading-tight font-[620]">{theme.name}</span>
                    <span className="text-[12px] leading-snug text-ink-3">{theme.description}</span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full',
                      on
                        ? 'bg-primary text-primary-foreground'
                        : 'shadow-[inset_0_0_0_1.5px_var(--control)]'
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {appearanceTheme === 'liquid' && <GlassSettings />}

      <SettingsGroup
        title="Network colours in this theme"
        description="Within a theme a network keeps its colour everywhere: lanes, bars, charts and chunk maps. A colour you pick for a network, in Networks, overrides the theme’s."
      >
        <div className="flex flex-wrap gap-x-6 gap-y-2 py-3">
          {interfaces.length === 0 ? (
            <span className="text-[12.5px] text-ink-3">No network connected.</span>
          ) : (
            interfaces.map((iface) => {
              const visual = networkVisual(iface.id, iface.kind, iface.displayName)
              return (
                <span key={iface.id} className="flex items-center gap-2 text-[13px]">
                  <NetworkTile
                    kind={iface.kind}
                    color={visual.solid}
                    onColor={visual.onSolid}
                    size={22}
                  />
                  <span className="font-[580]">{visual.name}</span>
                  <span className="font-mono text-[11px] text-ink-3">{iface.id}</span>
                </span>
              )
            })
          )}
        </div>
      </SettingsGroup>
    </>
  )
}

/** Whether the Mac has Reduce Transparency on (System Settings › Accessibility › Display). */
function useSystemReducedTransparency(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED_TRANSPARENCY)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => window.matchMedia(REDUCED_TRANSPARENCY).matches
  )
}
const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'

/** The Liquid Glass theme's own settings, as the design has them (prototype.html, GlassSettings). */
function GlassSettings(): React.JSX.Element {
  const glassLook = useAppStore((store) => store.glassLook)
  const setGlassLook = useAppStore((store) => store.setGlassLook)
  const solidGlass = useAppStore((store) => store.solidGlass)
  const setSolidGlass = useAppStore((store) => store.setSolidGlass)
  const systemSolid = useSystemReducedTransparency()
  const solidId = useId()
  return (
    <SettingsGroup
      title="Liquid Glass"
      description="Glass is used only for what floats above your downloads: the window, the sidebar and the content pane. Cards and lists stay easy to read."
    >
      <SettingRow
        label="Look"
        hint={
          glassLook === 'clear'
            ? 'Clear lets more of the desktop show through.'
            : 'Tinted makes the glass thicker, for more contrast.'
        }
      >
        <ToggleGroup
          aria-label="Liquid Glass look"
          value={[glassLook]}
          disabled={solidGlass || systemSolid}
          onValueChange={(values) => {
            if (values[0] !== undefined) setGlassLook(values[0] as GlassLook)
          }}
        >
          <ToggleGroupItem value="clear">Clear</ToggleGroupItem>
          <ToggleGroupItem value="tinted">Tinted</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow
        label="Reduce transparency"
        htmlFor={solidId}
        hint={
          systemSolid
            ? 'Already on in your Mac’s Accessibility settings, so the glass is solid.'
            : 'Makes the glass solid. Mergelane also follows this setting in System Settings › Accessibility › Display.'
        }
      >
        <Switch
          id={solidId}
          checked={solidGlass || systemSolid}
          disabled={systemSolid}
          onCheckedChange={setSolidGlass}
        />
      </SettingRow>
    </SettingsGroup>
  )
}

/* Downloads */
function DownloadSettings(): React.JSX.Element {
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const homeDir = useAppStore((store) => store.homeDir)
  const downloadsAtOnce = useAppStore((store) => store.downloadsAtOnce)
  const setDownloadsAtOnce = useAppStore((store) => store.setDownloadsAtOnce)
  const setScreen = useAppStore((store) => store.setScreen)
  const { schedule, message: scheduleMessage } = useDownloadSchedule()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const [server, setServer] = useState<UsenetServer | null | undefined>(undefined)
  const [serverOpen, setServerOpen] = useState(false)
  const offerCopiedLinks = useAppStore((store) => store.offerCopiedLinks)
  const setOfferCopiedLinks = useAppStore((store) => store.setOfferCopiedLinks)
  const offerId = useId()

  useEffect(() => {
    void window.mergelane
      .usenetServer()
      .then(setServer)
      .catch(() => setServer(null))
  }, [])

  const choose = async (): Promise<void> => {
    const chosen = await window.mergelane.chooseDestinationFolder(destinationDir)
    if (chosen) setDestinationDir(chosen)
  }
  const counts = Array.from(
    { length: DOWNLOADS_AT_ONCE.max - DOWNLOADS_AT_ONCE.min + 1 },
    (_, index) => String(DOWNLOADS_AT_ONCE.min + index)
  )

  return (
    <>
      <SettingsGroup title="Saving">
        <SettingRow
          label="Save downloads to"
          hint={
            <span className="font-mono text-[12px] text-foreground">
              {toDisplayPath(destinationDir, homeDir)}
            </span>
          }
        >
          <Button type="button" size="sm" variant="secondary" onClick={() => void choose()}>
            <FolderOpen data-icon="inline-start" />
            Change…
          </Button>
        </SettingRow>
      </SettingsGroup>

      {/* ADR-0043: off unless turned on, since macOS may ask the user about it. */}
      <SettingsGroup title="Adding downloads">
        <SettingRow
          label="Offer links I copy"
          htmlFor={offerId}
          hint="When you switch to Mergelane, a link you copied in another app is offered for download. Mergelane looks at what you copied only then. macOS may ask once to allow it."
        >
          <Switch id={offerId} checked={offerCopiedLinks} onCheckedChange={setOfferCopiedLinks} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Speed and the queue">
        <SettingRow
          label="Speed and data limits, per network"
          hint="Each network’s speed limit and data cap are set in Networks."
        >
          <Button type="button" size="sm" variant="secondary" onClick={() => setScreen('networks')}>
            <Gauge data-icon="inline-start" />
            Open in Networks
          </Button>
        </SettingRow>
        <SettingRow
          label="Downloads at once"
          hint="The rest wait their turn. A lower number gives each running download more speed."
        >
          <ToggleGroup
            aria-label="Downloads at once"
            value={[String(downloadsAtOnce)]}
            onValueChange={(values) => {
              if (values[0] !== undefined) setDownloadsAtOnce(Number(values[0]))
            }}
          >
            {counts.map((count) => (
              <ToggleGroupItem key={count} value={count}>
                {count}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow
          label="Download schedule"
          hint={
            schedule?.enabled
              ? (scheduleMessage ?? 'On. Downloads run inside its hours.')
              : 'Off. Downloads start whenever they’re added.'
          }
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setLimitsPage(null)
              setLimitsOpen(true)
            }}
          >
            <CalendarClock data-icon="inline-start" />
            Change…
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Usenet">
        <SettingRow
          label="News server"
          hint={
            server === undefined
              ? 'Looking…'
              : server
                ? `${server.host}, ${server.connections} ${server.connections === 1 ? 'connection' : 'connections'}${server.enabled ? '' : '. Off: NZB links download as plain files.'}`
                : 'Not set up. Set one up to download NZB files.'
          }
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={server === undefined}
            onClick={() => setServerOpen(true)}
          >
            <Newspaper data-icon="inline-start" />
            {server ? 'Change…' : 'Set up…'}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <LimitsDialog
        open={limitsOpen}
        showSchedule
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
      <UsenetServerDialog
        open={serverOpen}
        server={server ?? null}
        onOpenChange={setServerOpen}
        onSaved={setServer}
      />
    </>
  )
}
