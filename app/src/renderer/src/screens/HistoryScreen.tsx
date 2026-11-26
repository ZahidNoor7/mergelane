import {
  countsBy,
  grouped,
  HISTORY_KEEP,
  HISTORY_SHOW,
  hostOf,
  plainLink,
  type HistoryEntry,
  type HistoryShow
} from '@shared/history'
import type { DownloadState } from '@shared/types'
import { CircleAlert, Copy, Download, FolderOpen, History, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileGlyph } from '../components/DownloadGlyphs'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { words } from '../platformWords'
import { useAppStore } from '../store/useAppStore'
import { formatBytes, formatPercent, linkExpired, wantedBytes } from '../utils/format'

// History (docs/plans/2026-11-new-features-plan.md, feature 3; the design's HistoryScreen; ADR-0080):
// every download Mergelane has started, whether or not it's still in the list. The main process
// keeps it (main/store/historyStore.ts) and lists all but the unfinished downloads in the list,
// which come from the window's own state, live.

/** One row: an entry from History, or a download in the list that hasn't finished. */
interface Row extends HistoryEntry {
  live?: DownloadState
}

function liveRow(download: DownloadState): Row {
  return {
    id: download.id,
    kind: download.kind,
    name: download.fileName,
    link: plainLink(download.url),
    host: hostOf(download.url),
    size: download.totalBytes,
    startedAt: download.startedAt,
    inList: true,
    path: download.destinationPath,
    file: 'partial',
    live: download
  }
}

function Status({ row }: { row: Row }): React.JSX.Element | null {
  if (row.live) {
    return (
      <Badge>
        {linkExpired(row.live)
          ? 'Link expired'
          : `In the list, ${formatPercent(row.live.bytesDownloaded, wantedBytes(row.live))}%`}
      </Badge>
    )
  }
  if (row.file === 'missing') {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-caution-soft px-2 text-[11.5px] font-[580] whitespace-nowrap text-caution shadow-[inset_0_0_0_1px_var(--color-warning-border)]">
        <CircleAlert aria-hidden className="size-3" />
        File moved or deleted
      </span>
    )
  }
  if (row.file === 'stopped') return <Badge>Stopped, partial file removed</Badge>
  return row.inList ? null : <Badge>Not in the list</Badge>
}

function HistoryRow({ row }: { row: Row }): React.JSX.Element {
  const openDownload = useAppStore((store) => store.openDownload)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const [copied, setCopied] = useState(false)
  const finder = words().fileManager
  const canShow = row.file === 'on_disk'
  const where =
    row.host || (row.kind === 'torrent' ? 'Torrent' : row.kind === 'nzb' ? 'Usenet' : '')

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const again = async (): Promise<void> => {
    const link = await window.mergelane.historyLink(row.id).catch(() => null)
    // Opened in New download, filled in: nothing starts on its own (plan D7).
    openNewDownload(link ?? row.link)
  }
  const copy = async (): Promise<void> => {
    const link = (await window.mergelane.historyLink(row.id).catch(() => null)) ?? row.link
    await navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => {}
    )
  }

  return (
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[12px] px-2.5 py-2 transition-colors duration-100 hover:bg-hover">
      <FileGlyph
        item={{ kind: row.kind, fileName: row.name } as unknown as DownloadState}
        size={32}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-[13.5px] leading-tight font-[580]">
            {row.name}
          </span>
          <Status row={row} />
        </p>
        <p className="flex min-w-0 gap-x-3 overflow-hidden text-[12px] leading-tight whitespace-nowrap text-ink-2">
          {where && <span className="truncate font-mono text-[11.5px]">{where}</span>}
          {row.size > 0 && <span className="figures">{formatBytes(row.size)}</span>}
          <span className="truncate">
            {new Date(row.startedAt).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {row.live ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => openDownload(row.id)}>
            Show in list
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={canShow ? 'ghost' : 'secondary'}
            aria-label={`Download ${row.name} again`}
            onClick={() => void again()}
          >
            <Download aria-hidden data-icon="inline-start" />
            Download again
          </Button>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Show ${row.name} in ${finder}`}
          title={canShow ? `Show in ${finder}` : 'The file isn’t where it was saved'}
          disabled={!canShow}
          onClick={() => void window.mergelane.revealHistoryEntry(row.id).catch(() => false)}
        >
          <FolderOpen aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={copied ? 'Link copied' : `Copy the link for ${row.name}`}
          title={copied ? 'Copied' : 'Copy link'}
          onClick={() => void copy()}
        >
          <Copy aria-hidden />
        </Button>
      </div>
    </li>
  )
}

export function HistoryScreen(): React.JSX.Element {
  const downloads = useAppStore((store) => store.downloads)
  const keep = useAppStore((store) => store.historyKeep)
  const openSettings = useAppStore((store) => store.openSettings)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<HistoryShow>('all')
  const searchRef = useRef<HTMLInputElement>(null)
  // Day boundaries for the groups; read again whenever History is read.
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(() => {
    void window.mergelane.historyEntries().then(
      (found) => {
        setEntries(found)
        setNow(Date.now())
      },
      () => {}
    )
  }, [])
  useEffect(() => {
    load()
    return window.mergelane.onHistoryChanged(load)
  }, [load])

  const rows = useMemo<Row[]>(() => {
    // The main process lists every download but those unfinished in the list; one it lists is no
    // longer live there, whatever the window still holds of it.
    const listed = new Set(entries.map((entry) => entry.id))
    const live = Object.values(downloads)
      .filter((download) => download.status !== 'completed' && !listed.has(download.id))
      .map(liveRow)
    return [...live, ...entries]
  }, [downloads, entries])

  const counts = countsBy(rows, query)
  const groups = grouped(rows, query, show, now) as { label: string; entries: Row[] }[]
  const removed = rows.filter((row) => !row.inList).length
  const kept = HISTORY_KEEP.find((option) => option.value === keep)?.label.toLowerCase()

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="window-drag flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[18px] leading-tight font-[680] tracking-[-0.015em]">
            History
          </h1>
          <p className="truncate text-[12px] leading-snug text-ink-3">
            {rows.length} {rows.length === 1 ? 'download' : 'downloads'}, {removed} no longer in the
            list
          </p>
        </div>
        <label className="relative flex h-8 w-full min-w-0 items-center rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--border)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 size-3.5 text-ink-3"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="Search names, sites and links"
            aria-label="Search history"
            className="h-full w-full min-w-0 rounded-full bg-transparent pr-8 pl-8 text-[13px] outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              className="absolute right-1.5 grid size-5 place-items-center rounded-full text-ink-3 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <div className="flex max-w-[960px] flex-col gap-4 px-3 pt-4 pb-8">
          <div className="min-w-0 overflow-x-auto px-1.5 [scrollbar-width:none]">
            <ToggleGroup
              aria-label="Show in history"
              value={[show]}
              onValueChange={(values) => {
                if (values[0] !== undefined) setShow(values[0] as HistoryShow)
              }}
            >
              {HISTORY_SHOW.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                  <span className="figures text-ink-3">{counts[option.value]}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {groups.length === 0 ? (
            <div role="status" className="flex flex-col items-start gap-2 px-2.5 py-6">
              <p className="text-[14px] font-[620]">
                {query.trim()
                  ? `Nothing in your history matches “${query.trim()}”`
                  : 'Nothing here'}
              </p>
              <p className="text-[12.5px] text-ink-2">
                Search looks at file names, the sites they came from and their links.
              </p>
              {(query.trim() || show !== 'all') && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setQuery('')
                    setShow('all')
                  }}
                >
                  Show all history
                </Button>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="flex items-baseline gap-2 px-2.5 pb-1 text-[12.5px] font-[650] text-ink-2">
                  {group.label}
                  <span className="figures font-[500] text-ink-3">{group.entries.length}</span>
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {group.entries.map((row) => (
                    <HistoryRow key={row.id} row={row} />
                  ))}
                </ul>
              </section>
            ))
          )}

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pt-2 text-[12px] text-ink-3">
            <History aria-hidden className="size-3.5" />
            Kept {keep === 'forever' ? 'forever' : `for ${kept}`}, only on {words().thisComputer}.
            Removing a download from the list or deleting its file doesn’t remove it here.
            <button
              type="button"
              onClick={() => openSettings('downloads')}
              className="font-[600] text-[var(--color-accent-ink)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              History settings
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
