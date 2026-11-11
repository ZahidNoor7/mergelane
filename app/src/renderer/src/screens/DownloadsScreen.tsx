import type { DownloadState, FinishedDownload } from '@shared/types'
import { activeFilterCount, filtersActive, matchesFilters } from '@shared/downloadFilters'
import { matchesSearch, searchTokens } from '@shared/downloadSearch'
import { scheduleMessage, scheduleWindow } from '@shared/downloadSchedule'
import { ListFilter, Plus, Search, X } from 'lucide-react'
import { cn } from 'cn'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Confluence, PLACEHOLDER_LANES } from '../components/Confluence'
import { DownloadContextMenu } from '../components/DownloadContextMenu'
import { ActiveFilterChips, FILTER_PANEL_ID, FilterPanel } from '../components/DownloadFilters'
import { FileGlyph, KindTags } from '../components/DownloadGlyphs'
import { useDownloadActions, useDownloadActionsState } from '../components/downloadActionsContext'
import { ACTION_META, toolbarLabel } from '../components/downloadActionMeta'
import { LimitsDialog } from '../components/LimitsDialog'
import { MoreActionsMenu } from '../components/MoreActionsMenu'
import { networkStatusText } from '../components/networkStatus'
import { ScheduleIndicator } from '../components/ScheduleIndicator'
import { SpeedText } from '../components/SpeedText'
import { SplitBar } from '../components/SplitBar'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useMergeLanes } from '../hooks/useMergeLanes'
import { useNetworkVisuals, type ResolveNetworkVisual } from '../hooks/useNetworkVisuals'
import { useAppStore, type DownloadFilter } from '../store/useAppStore'
import {
  availableActions,
  isFinished,
  rowAction,
  splitToolbar,
  type ActionId
} from '../utils/downloadActions'
import {
  describeError,
  formatBytes,
  formatEta,
  formatPercent,
  formatWhen,
  sourceOf,
  wantedBytes
} from '../utils/format'

// The download list, in the final design's layout (design-system/mergelane/redesign/prototype.html,
// DownloadsScreen): a toolbar with the title, what's running, search and New download; the
// Confluence of every network; the status tabs and the filters; then the downloads in groups.
//
// Kept from before, restyled (the owner's answer to PHASE-3.md's first question): the selection
// with its toolbar and keys, the right-click menu, each row's next step, and the schedule button (which
// moves to Settings in M3.1 pull request 5e). The networks menu became the Networks place (5d).

type Item = DownloadState | FinishedDownload

interface Group {
  label: string
  items: Item[]
}

function tabOf(item: Item): Exclude<DownloadFilter, 'all'> {
  if ('unitsWritten' in item || item.status === 'completed') return 'finished'
  return item.status === 'error' ? 'failed' : 'progress'
}

const TABS: { value: DownloadFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'failed', label: 'Needs attention' }
]

function groupsOf(items: Item[]): Group[] {
  const byStatus = (status: DownloadState['status']): DownloadState[] =>
    items.filter((item): item is DownloadState => !isFinished(item) && item.status === status)
  return [
    { label: 'Downloading', items: byStatus('downloading') },
    {
      label: 'Waiting',
      items: byStatus('queued').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    },
    { label: 'Paused', items: byStatus('paused') },
    { label: 'Needs attention', items: byStatus('error') },
    // Completed but not in history yet: on its way there, so listed with it.
    {
      label: 'Finished',
      items: [...byStatus('completed'), ...items.filter((item) => isFinished(item))]
    }
  ].filter((group) => group.items.length > 0)
}

/** "2 downloading, 1 waiting", "All finished", or "Nothing yet". */
function summaryOf(downloads: DownloadState[], listed: number): string {
  if (listed === 0) return 'Nothing yet'
  const count = (status: DownloadState['status']): number =>
    downloads.filter((download) => download.status === status).length
  const parts = (
    [
      [count('downloading'), 'downloading'],
      [count('queued'), 'waiting'],
      [count('paused'), 'paused'],
      [count('error'), 'need attention']
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
  return parts.length > 0 ? parts.join(', ') : 'All finished'
}

export function DownloadsScreen({
  current
}: {
  /** The download whose details show beside the list, in a wide window. */
  current?: string
} = {}): React.JSX.Element {
  const downloadsById = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const openDownload = useAppStore((store) => store.openDownload)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const filter = useAppStore((store) => store.downloadFilter)
  const setFilter = useAppStore((store) => store.setDownloadFilter)
  const filters = useAppStore((store) => store.downloadFilters)
  const clearFilters = useAppStore((store) => store.clearDownloadFilters)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { perform, askClearFinished } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isMac = window.mergelane.platform === 'darwin'
  const tokens = useMemo(() => searchTokens(searchQuery), [searchQuery])
  const isSearching = tokens.length > 0
  const [now, setNow] = useState(() => Date.now())
  const { lanes, active, progress } = useMergeLanes()

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const downloads = Object.values(downloadsById)
    .filter((download) => download.status !== 'cancelled')
    .sort((a, b) => a.startedAt - b.startedAt)
  const listed: Item[] = [...downloads, ...history]
  // Date, type and search narrow the list first; the status tabs then count and split what's left.
  const narrowed = listed.filter(
    (item) => matchesFilters(item, filters, now) && (!isSearching || matchesSearch(item, tokens))
  )
  const counts: Record<DownloadFilter, number> = {
    all: narrowed.length,
    progress: 0,
    finished: 0,
    failed: 0
  }
  for (const item of narrowed) counts[tabOf(item)]++
  const groups = groupsOf(
    filter === 'all' ? narrowed : narrowed.filter((item) => tabOf(item) === filter)
  )
  const items = groups.flatMap((group) => group.items)
  const anyFilter = filtersActive(filters)
  // Only what's still shown counts: one that finished, went or was filtered out is no longer selected.
  const chosen = items.filter((item) => selected.has(item.id))

  const toggle = useCallback(
    (ids: string[], on: boolean): void =>
      setSelected((previous) => {
        const next = new Set(previous)
        for (const id of ids) {
          if (on) next.add(id)
          else next.delete(id)
        }
        return next
      }),
    []
  )
  // Stable, with the colors resolved once here, so a finished row skips every progress push.
  const networkVisual = useNetworkVisuals()
  const selectRow = useCallback((id: string, on: boolean) => toggle([id], on), [toggle])
  const openRow = useCallback((id: string) => openDownload(id), [openDownload])
  const focusSearch = (): void => {
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }
  // Keys for the selection: Esc clears it, Select all, and Delete takes
  // the selected off the list (with Cmd/Ctrl, moves their files to the Trash), each asking first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = isMac ? event.metaKey : event.ctrlKey
      const target = event.target
      if (
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return

      if (event.key === 'Escape') {
        setSelected(new Set())
      } else if (command && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (chosen.length > 0) {
          setSelected(new Set())
          requestAnimationFrame(focusSearch)
        } else {
          focusSearch()
        }
      } else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelected(new Set(items.map((item) => item.id)))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        const id = command ? 'trash' : 'remove'
        const action = availableActions(chosen)
          .flat()
          .find((available) => available.id === id)
        if (!action) return
        event.preventDefault()
        void perform(id, action.targets)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, chosen, perform, isMac])

  // What the toolbar offers: the two actions most needed for what's selected as buttons, and
  // the rest of what the menu does for the selection behind More, so six never need more room.
  const { buttons: toolbarButtons, more: moreActions } = splitToolbar(availableActions(chosen))

  const openSchedule = (): void => {
    setLimitsPage(null)
    setShowSchedule(true)
    setLimitsOpen(true)
  }
  const showEverything = (): void => {
    setFilter('all')
    setSearchQuery('')
    clearFilters()
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {chosen.length === 0 ? (
        <div className="window-drag flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em]">
              Downloads
            </h1>
            <p className="truncate text-[12px] leading-snug text-ink-3">
              {summaryOf(downloads, listed.length)}
            </p>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 @min-[640px]:w-auto">
            <label className="relative flex h-8 min-w-0 flex-1 items-center rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--border)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring @min-[640px]:w-52 @min-[640px]:flex-none">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 size-3.5 text-ink-3"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    if (searchQuery) setSearchQuery('')
                    else searchInputRef.current?.blur()
                  }
                }}
                placeholder="Search"
                aria-label="Search downloads"
                className="h-full w-full min-w-0 rounded-full bg-transparent pr-8 pl-8 text-[13px] outline-none placeholder:text-ink-3"
              />
              {searchQuery ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearchQuery('')
                    searchInputRef.current?.focus()
                  }}
                  className="absolute right-1.5 grid size-5 place-items-center rounded-full text-ink-3 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <X aria-hidden className="size-3" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-3 hidden font-mono text-[10.5px] text-ink-3 select-none @min-[640px]:inline">
                  {isMac ? '⌘F' : 'Ctrl+F'}
                </kbd>
              )}
            </label>
            <ScheduleIndicator onClick={openSchedule} />
            <Button type="button" onClick={() => openNewDownload()}>
              <Plus data-icon="inline-start" />
              New download
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="toolbar"
          aria-label="Selected downloads"
          aria-busy={busy}
          className="window-drag flex min-h-14 shrink-0 items-center gap-3 border-b border-rule px-4"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Deselect all"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent>Deselect all</TooltipContent>
          </Tooltip>
          <span className="shrink-0 text-[13px] font-[650] whitespace-nowrap">
            {chosen.length} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || chosen.length === items.length}
            onClick={() => setSelected(new Set(items.map((item) => item.id)))}
          >
            Select all
          </Button>
          <div className="flex-1" />
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {toolbarButtons.map(({ id, targets }) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={ACTION_META[id].destructive ? 'destructive' : 'secondary'}
                disabled={busy}
                onClick={() => void perform(id, targets)}
              >
                {toolbarLabel(id, targets.length)}
              </Button>
            ))}
            <MoreActionsMenu groups={moreActions} disabled={busy} />
          </div>
          <ScheduleIndicator onClick={openSchedule} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listed.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4 px-3 pt-4 pb-6">
            <div className="px-1.5">
              <Confluence
                lanes={lanes.length > 0 ? lanes : PLACEHOLDER_LANES}
                idle={active.running.length === 0 || lanes.length === 0}
                total={active.totalSpeed}
                caption={progress}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 px-1.5">
              <div className="min-w-0 overflow-x-auto [scrollbar-width:none]">
                <ToggleGroup
                  aria-label="Show"
                  value={[filter]}
                  onValueChange={(values) => {
                    if (values[0] === undefined) return
                    setFilter(values[0] as DownloadFilter)
                    setSelected(new Set())
                  }}
                >
                  {TABS.map((tab) => (
                    <ToggleGroupItem key={tab.value} value={tab.value}>
                      {tab.label}
                      <span className="figures font-[500] text-ink-3">{counts[tab.value]}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8 px-3.5"
                variant={filtersOpen ? 'default' : 'secondary'}
                aria-expanded={filtersOpen}
                aria-controls={filtersOpen ? FILTER_PANEL_ID : undefined}
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <ListFilter aria-hidden />
                Filters
                {anyFilter && (
                  <>
                    <span
                      aria-hidden
                      className="figures ml-0.5 rounded-full bg-[var(--color-accent-soft)] px-1.5 text-[11.5px] text-[var(--color-accent-ink)]"
                    >
                      {activeFilterCount(filters)}
                    </span>
                    <span className="sr-only">{`, ${activeFilterCount(filters)} on`}</span>
                  </>
                )}
              </Button>
            </div>
            {filtersOpen && (
              <div className="px-1.5">
                <FilterPanel
                  items={listed}
                  shown={narrowed.length}
                  now={now}
                  onDone={() => setFiltersOpen(false)}
                />
              </div>
            )}
            {!filtersOpen && anyFilter && (
              <div className="px-1.5">
                <ActiveFilterChips />
              </div>
            )}
            {groups.length === 0 ? (
              <div role="status" className="flex flex-col items-start gap-2 px-2.5 py-6">
                <p className="text-[14px] font-[620]">
                  {isSearching
                    ? `No downloads match “${searchQuery.trim()}”`
                    : anyFilter && narrowed.length === 0
                      ? 'No downloads match these filters'
                      : filter === 'progress'
                        ? 'Nothing in progress'
                        : filter === 'finished'
                          ? 'No finished downloads'
                          : 'Nothing needs attention'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {isSearching && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setSearchQuery('')}
                    >
                      Clear search
                    </Button>
                  )}
                  {anyFilter && (
                    <Button type="button" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={anyFilter ? 'ghost' : 'secondary'}
                    onClick={showEverything}
                  >
                    Show all downloads
                  </Button>
                </div>
              </div>
            ) : (
              groups.map((group) => {
                const ids = group.items.map((item) => item.id)
                const all = ids.every((id) => selected.has(id))
                const some = !all && ids.some((id) => selected.has(id))
                return (
                  <section key={group.label} aria-label={group.label}>
                    <div className="flex min-h-7 items-center gap-2.5 px-2.5 pb-1">
                      <Checkbox
                        aria-label={
                          group.label === 'Needs attention'
                            ? 'Select all downloads needing attention'
                            : `Select all ${group.label.toLowerCase()} downloads`
                        }
                        checked={all}
                        indeterminate={some}
                        onCheckedChange={(on) => toggle(ids, on)}
                      />
                      <h2 className="flex items-baseline gap-2 text-[12.5px] font-[650] text-ink-2">
                        {group.label}
                        <span className="figures font-[500] text-ink-3">{group.items.length}</span>
                      </h2>
                      <div className="flex-1" />
                      {group.label === 'Finished' &&
                        history.length > 0 &&
                        !isSearching &&
                        !anyFilter && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={askClearFinished}
                          >
                            Clear finished list
                          </Button>
                        )}
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <ListedDownload
                            item={item}
                            now={now}
                            selected={selected.has(item.id)}
                            current={item.id === current}
                            // Only a selected row's menu acts on the selection.
                            chosen={selected.has(item.id) ? chosen : NOT_CHOSEN}
                            networkVisual={
                              isFinished(item) || item.status === 'completed'
                                ? undefined
                                : networkVisual
                            }
                            onSelect={selectRow}
                            onOpen={openRow}
                            onPerform={perform}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })
            )}
          </div>
        )}
      </div>

      <LimitsDialog
        open={limitsOpen}
        showSchedule={showSchedule}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </div>
  )
}

const PASTE_SHORTCUT = window.mergelane.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
const NEW_SHORTCUT = window.mergelane.platform === 'darwin' ? '⌘N' : 'Ctrl+N'

/** Nothing listed yet: how to start one — or, with no network connected, how to get one. */
function EmptyState(): React.JSX.Element {
  const noNetworks = useAppStore(
    (store) => store.interfacesStatus === 'ready' && store.interfaces.length === 0
  )
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const { lanes } = useMergeLanes()

  return (
    <div className="flex flex-col gap-6 px-4 py-8">
      <Confluence
        lanes={
          lanes.length > 0
            ? lanes.map((lane) => ({ ...lane, speed: 0, on: false }))
            : PLACEHOLDER_LANES
        }
        idle
        label="Merged speed"
      />
      {noNetworks ? (
        <div className="flex max-w-[46ch] flex-col items-start gap-2">
          <h2 className="text-[17px] font-[680] tracking-[-0.01em]">No networks connected</h2>
          <p className="text-[13px] leading-[1.6] text-ink-2">
            Mergelane needs at least one active network. Join a Wi-Fi network, plug in Ethernet, or
            connect your phone using USB tethering.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
              Scan again
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.mergelane.openNetworkSettings()}
            >
              Network settings
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex max-w-[46ch] flex-col items-start gap-2">
          <h2 className="text-[17px] font-[680] tracking-[-0.01em]">No downloads yet</h2>
          <p className="text-[13px] leading-[1.6] text-ink-2">
            Paste a link ({PASTE_SHORTCUT}) or drop a .torrent or .nzb anywhere in this window.
            Mergelane splits each download across every network you switch on.
          </p>
          <Button type="button" className="mt-2" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
            <span className="ml-1 font-mono text-[11px] opacity-75">{NEW_SHORTCUT}</span>
          </Button>
        </div>
      )}
    </div>
  )
}

const NOT_CHOSEN: Item[] = []

/** A row with its right-click menu, memoized as one: a progress update to one download leaves
 * every other row, menu included, as it was. */
const ListedDownload = memo(function ListedDownload({
  chosen,
  ...row
}: React.ComponentProps<typeof DownloadRow> & { chosen: Item[] }): React.JSX.Element {
  return (
    <DownloadContextMenu item={row.item} selected={row.selected} chosen={chosen}>
      <DownloadRow {...row} />
    </DownloadContextMenu>
  )
})

/** The row's line under its bar, in parts: what it's doing, how much, and when. */
function rowMeta(item: Item, now: number, waiting: string): { parts: string[]; error?: boolean } {
  const wanted = wantedBytes(item)
  const percent = formatPercent(item.bytesDownloaded, wanted)
  if (isFinished(item) || item.status === 'completed') {
    return {
      parts: [
        formatBytes(wanted || item.bytesDownloaded),
        // A torrent's tag already says where it came from.
        item.kind === 'http' ? sourceOf(item.url) : '',
        isFinished(item) && item.missing
          ? 'Moved or deleted'
          : formatWhen(item.completedAt ?? now, now)
      ].filter(Boolean)
    }
  }
  const sizes =
    wanted > 0
      ? `${formatBytes(item.bytesDownloaded)} of ${formatBytes(wanted)}`
      : formatBytes(item.bytesDownloaded)
  switch (item.status) {
    case 'downloading':
      return {
        parts: [
          item.kind === 'stream' && item.muxing ? 'Joining video and audio…' : '',
          wanted > 0 ? `${percent}%` : '',
          sizes,
          item.timeLeftSeconds !== undefined
            ? `${formatEta(item.timeLeftSeconds)} left`
            : item.speedBytesPerSec === 0
              ? 'Starting'
              : ''
        ].filter(Boolean)
      }
    case 'queued':
      return { parts: [waiting, sizes] }
    case 'paused':
      return { parts: [wanted > 0 ? `Paused at ${percent}%` : 'Paused', sizes] }
    default:
      return { parts: [describeError(item.error ?? 'Something went wrong')], error: true }
  }
}

const DownloadRow = memo(function DownloadRow({
  item,
  now,
  selected,
  current = false,
  networkVisual,
  onSelect,
  onOpen,
  onPerform
}: {
  item: Item
  now: number
  /** Checked, in the selection. */
  selected: boolean
  /** Its details are open beside the list. */
  current?: boolean
  /** Colors its progress bar and network dots; a finished row has none. */
  networkVisual?: ResolveNetworkVisual
  onSelect: (id: string, on: boolean) => void
  onOpen: (id: string) => void
  /** Does what the row's button says, the way the menu, the toolbar and its screen do. */
  onPerform: (id: ActionId, targets: Item[]) => Promise<boolean>
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const schedule = useAppStore((store) => store.downloadSchedule)
  const [working, setWorking] = useState(false)
  const finished = isFinished(item) || item.status === 'completed'
  const wanted = wantedBytes(item)
  const waiting =
    schedule?.enabled && !scheduleWindow(schedule, now).allowed
      ? (scheduleMessage(schedule, now) ?? 'Waiting for a turn')
      : 'Waiting for a turn'
  const meta = rowMeta(item, now, waiting)

  // Its next step, if it has one: the first thing its menu offers.
  const actionId = rowAction(item)
  const action = actionId ? ACTION_META[actionId] : null

  // The bar shows each network's share of the file in its color; a failed one shows in red.
  const segments =
    finished || isFinished(item) || !networkVisual
      ? []
      : item.status === 'error'
        ? [
            {
              id: 'error',
              share: item.bytesDownloaded / (wanted || 1),
              color: 'var(--color-danger)'
            }
          ]
        : item.networks
            .filter((network) => network.bytesDownloaded > 0)
            .map((network) => ({
              id: network.id,
              share: network.bytesDownloaded / (wanted || 1),
              color: networkVisual(network.id, network.kind, network.label).solid
            }))

  // Which networks it's on, at a glance, when it isn't on all of them. One on every network says
  // nothing new, so it shows none.
  const dots =
    networkVisual &&
    !isFinished(item) &&
    !finished &&
    item.networks.some((network) => !network.enabled)
      ? item.networks.map((network) => {
          const visual = networkVisual(network.id, network.kind, network.label)
          return {
            id: network.id,
            on: network.enabled,
            color: visual.solid,
            name: visual.name,
            // Its speed while it runs; otherwise whether it's on, or what's stopping it.
            state: !network.enabled
              ? 'Off'
              : network.status !== 'on'
                ? networkStatusText(network.status, network.transfer)
                : item.status === 'downloading'
                  ? formatSpeed(network.speedBytesPerSec)
                  : 'On'
          }
        })
      : null
  const running = !isFinished(item) && item.status === 'downloading'

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        'group/download-row relative flex items-center gap-3 rounded-[12px] px-2.5 py-2.5 transition-colors duration-100',
        selected || current ? 'bg-selected' : 'hover:bg-hover active:bg-selected',
        current && 'shadow-[inset_0_0_0_1px_var(--color-accent)]'
      )}
    >
      <Checkbox
        aria-label={`Select ${item.fileName}`}
        checked={selected}
        onCheckedChange={(on) => onSelect(item.id, on)}
        className="relative z-10"
      />
      <FileGlyph item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {/* The whole row opens the download: this button's area covers it (after:inset-0). */}
          <button
            type="button"
            data-download-id={item.id}
            aria-current={current || undefined}
            onClick={() => onOpen(item.id)}
            className="min-w-0 truncate text-left text-[13.5px] leading-tight font-[580] outline-none after:absolute after:inset-0 after:rounded-[12px] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
          >
            {item.fileName}
          </button>
          <span className="hidden shrink-0 items-center gap-1.5 @min-[448px]:flex">
            <KindTags item={item} />
          </span>
          {dots && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={dots.map((dot) => `${dot.name} ${dot.state}`).join(', ')}
                    className="relative z-10 ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-1 shadow-[inset_0_0_0_1px_var(--border)]"
                  >
                    {dots.map((dot) => (
                      <span
                        key={dot.id}
                        className={cn('size-1.5 rounded-full', !dot.on && 'bg-[var(--track-bg)]')}
                        style={dot.on ? { background: dot.color } : undefined}
                      />
                    ))}
                  </span>
                }
              />
              <TooltipContent>
                <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-1">
                  {dots.map((dot) => (
                    <Fragment key={dot.id}>
                      <span
                        className={cn(
                          'size-2 rounded-full',
                          !dot.on && 'border border-current opacity-60'
                        )}
                        style={dot.on ? { background: dot.color } : undefined}
                      />
                      <span>{dot.name}</span>
                      <span className="figures pl-3 text-right opacity-80">{dot.state}</span>
                    </Fragment>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {segments.length > 0 && (
          <SplitBar
            segments={segments}
            // Not moving: the colours stay, faded, so it doesn't read as running.
            dim={!isFinished(item) && (item.status === 'paused' || item.status === 'queued')}
          />
        )}
        <p
          className={cn(
            'flex min-w-0 gap-x-3 overflow-hidden text-[12px] leading-tight whitespace-nowrap',
            meta.error ? 'text-destructive' : 'text-ink-2'
          )}
        >
          {meta.parts.map((part, index) => (
            <span key={index} className={cn(index > 0 && 'truncate')}>
              {part}
            </span>
          ))}
        </p>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {running && (
          <SpeedText
            bytesPerSecond={item.speedBytesPerSec}
            className="hidden min-w-[5.5rem] text-right text-[17px] font-[650] @min-[384px]:inline"
          />
        )}
        {action && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${action.label} ${item.fileName}`}
                  aria-busy={working}
                  disabled={working}
                  onClick={() => {
                    setWorking(true)
                    void onPerform(actionId!, [item]).finally(() => setWorking(false))
                  }}
                >
                  <action.icon />
                </Button>
              }
            />
            <TooltipContent>
              {working && action.working ? action.working : action.label}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
})
