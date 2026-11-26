// Download history (docs/plans/2026-11-new-features-plan.md, feature 3; ADR-0080): every download ever
// started, kept on this computer in userData/mergelane.db (main/store/historyStore.ts), whether or not
// it is still in the list. What is shown, searched and kept is decided here; pure, so it is
// unit-tested on its own.

export type HistoryKeep = '30d' | '1y' | 'forever'

export const HISTORY_KEEP: readonly { value: HistoryKeep; label: string }[] = [
  { value: '30d', label: '30 days' },
  { value: '1y', label: 'A year' },
  { value: 'forever', label: 'Forever' }
]

export const isHistoryKeep = (value: unknown): value is HistoryKeep =>
  HISTORY_KEEP.some((option) => option.value === value)

const DAY = 86_400_000

/** Entries started before this are forgotten, or null to keep every one. Only entries no longer
 * in the list are ever forgotten. */
export function keepSince(keep: HistoryKeep, now: number): number | null {
  if (keep === 'forever') return null
  return now - (keep === '30d' ? 30 : 365) * DAY
}

/** Where a download's file is, as History says it. */
export type FileState = 'on_disk' | 'missing' | 'partial' | 'stopped'

/** One download, as History lists it. `link` is the link without its query (where a signed link
 * keeps its signature): the full link is sealed in the database, and asked for when needed. */
export interface HistoryEntry {
  id: string
  kind: 'http' | 'torrent' | 'nzb' | 'stream'
  name: string
  link: string
  host: string
  size: number
  startedAt: number
  completedAt?: number
  /** Unset while it is in the list, unfinished. */
  ended?: 'completed' | 'cancelled'
  inList: boolean
  path: string
  file: FileState
}

/** The link as it is shown and searched: a web link without its query or fragment, where signed
 * links carry their signature and expiry. Anything else (a magnet link, a file's path) as it is. */
export function plainLink(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

/** A web link's host, or '' for anything else. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : ''
  } catch {
    return ''
  }
}

export type HistoryShow = 'all' | 'onDisk' | 'removed' | 'missing'

export const HISTORY_SHOW: readonly { value: HistoryShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'onDisk', label: 'On disk' },
  { value: 'removed', label: 'Not in the list' },
  { value: 'missing', label: 'File missing' }
]

/** Whether an entry is one the filter shows. */
export function shows(entry: HistoryEntry, show: HistoryShow): boolean {
  if (show === 'all') return true
  if (show === 'onDisk') return entry.file === 'on_disk'
  if (show === 'removed') return !entry.inList
  return entry.file === 'missing'
}

/** Whether an entry matches what was typed: its name, its site and its link, ignoring case. Every
 * word typed must match one of them. */
export function matches(entry: HistoryEntry, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [entry.name, entry.host, entry.link].join(' ').toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** How many entries each filter shows, of those the search matches. */
export function countsBy(
  entries: readonly HistoryEntry[],
  query: string
): Record<HistoryShow, number> {
  const matched = entries.filter((entry) => matches(entry, query))
  return Object.fromEntries(
    HISTORY_SHOW.map(({ value }) => [value, matched.filter((entry) => shows(entry, value)).length])
  ) as Record<HistoryShow, number>
}

/** The group an entry is listed under, by when it started (the design's historyBucket). */
export function bucketOf(time: number, now: number): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (time >= start) return 'Today'
  if (time >= start - DAY) return 'Yesterday'
  if (time >= start - 6 * DAY) return 'Earlier this week'
  if (time >= start - 29 * DAY) return 'Earlier this month'
  return 'Older'
}

/** The entries to show, newest first, in their groups. */
export function grouped(
  entries: readonly HistoryEntry[],
  query: string,
  show: HistoryShow,
  now: number
): { label: string; entries: HistoryEntry[] }[] {
  const groups: { label: string; entries: HistoryEntry[] }[] = []
  const listed = entries
    .filter((entry) => matches(entry, query) && shows(entry, show))
    .sort((a, b) => b.startedAt - a.startedAt)
  for (const entry of listed) {
    const label = bucketOf(entry.startedAt, now)
    const group = groups.find((candidate) => candidate.label === label)
    if (group) group.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}
