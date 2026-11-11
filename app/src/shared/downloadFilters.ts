// The download list's filters by date added and file type, from the final design
// (design-system/mergelane/redesign/prototype.html, "Filters: date added and file type"). They narrow
// the list together with the search; the status tabs then count and split what is left.
//
// Pure, so the main process could use them too; the renderer adds the icons.

/** What a filter needs to know about a download. `startedAt` is when it was added. */
export interface Filterable {
  kind: string
  fileName: string
  startedAt: number
}

export type FileType = 'doc' | 'image' | 'video' | 'audio' | 'archive' | 'disk' | 'app'

/** The file types, in the order the filter offers them, each with the extensions that make it. */
export const FILE_TYPES: { id: FileType; label: string; extensions: string[] }[] = [
  {
    id: 'doc',
    label: 'Documents',
    extensions: [
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'rtf',
      'epub',
      'pages',
      'numbers',
      'key',
      'csv',
      'md'
    ]
  },
  {
    id: 'image',
    label: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp', 'svg', 'tif', 'tiff', 'raw', 'dng']
  },
  { id: 'video', label: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
  { id: 'audio', label: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'] },
  {
    id: 'archive',
    label: 'Archives',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']
  },
  { id: 'disk', label: 'Disk images', extensions: ['iso', 'img'] },
  { id: 'app', label: 'Applications', extensions: ['dmg', 'pkg', 'app', 'exe', 'msi'] }
]

/** A download's file type, from its file's extension; a video link's download is always a video.
 * One that matches none (a folder, an unknown extension) is 'other', which no type filter shows. */
export function fileTypeOf(item: Pick<Filterable, 'kind' | 'fileName'>): FileType | 'other' {
  if (item.kind === 'stream') return 'video'
  const dot = item.fileName.lastIndexOf('.')
  if (dot <= 0) return 'other'
  const extension = item.fileName.slice(dot + 1).toLowerCase()
  return FILE_TYPES.find((type) => type.extensions.includes(extension))?.id ?? 'other'
}

export type DateRange = 'any' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'

export const DATE_RANGES: { id: DateRange; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range' }
]

export interface DownloadFilters {
  date: DateRange
  /** A custom range's first and last day, as a date field gives them (YYYY-MM-DD); '' for open. */
  from: string
  to: string
  /** No types: any type. */
  types: FileType[]
}

export const NO_FILTERS: DownloadFilters = { date: 'any', from: '', to: '', types: [] }

function startOfDay(time: number): number {
  const day = new Date(time)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** A date field's value as the start of that day on this Mac, or null for none. */
export function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

/** A time as a date field's value (YYYY-MM-DD), on this Mac's calendar. */
export function dayInput(time: number): string {
  const day = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** `days` calendar days before `time` (after it, for a negative count), at the same time of day.
 * Counted on this Mac's calendar rather than as 24 hours, so a daylight-saving change never shifts a
 * range. */
export function daysBefore(time: number, days: number): number {
  const day = new Date(time)
  day.setDate(day.getDate() - days)
  return day.getTime()
}

/** The added-at window a date range allows: from (inclusive) to (exclusive). Whole calendar days. */
function dateWindow(filters: DownloadFilters, now: number): [number, number] {
  const today = startOfDay(now)
  switch (filters.date) {
    case 'today':
      return [today, Infinity]
    case 'yesterday':
      return [daysBefore(today, 1), today]
    case '7d':
      return [daysBefore(today, 6), Infinity]
    case '30d':
      return [daysBefore(today, 29), Infinity]
    case 'custom': {
      const from = parseDay(filters.from)
      const to = parseDay(filters.to)
      // Both days included: up to the start of the day after `to`.
      return [from ?? -Infinity, to !== null ? daysBefore(to, -1) : Infinity]
    }
    default:
      return [-Infinity, Infinity]
  }
}

/** A custom range that starts after it ends. It filters nothing until it's fixed, and says so. */
export function customRangeInvalid(filters: DownloadFilters): boolean {
  if (filters.date !== 'custom') return false
  const from = parseDay(filters.from)
  const to = parseDay(filters.to)
  return from !== null && to !== null && from > to
}

export function matchesFilters(item: Filterable, filters: DownloadFilters, now: number): boolean {
  if (filters.types.length > 0) {
    const type = fileTypeOf(item)
    if (type === 'other' || !filters.types.includes(type)) return false
  }
  if (customRangeInvalid(filters)) return true
  const [from, to] = dateWindow(filters, now)
  return item.startedAt >= from && item.startedAt < to
}

export function filtersActive(filters: DownloadFilters): boolean {
  return filters.date !== 'any' || filters.types.length > 0
}

/** How many filters are on, for the Filters button's badge: the date range counts as one. */
export function activeFilterCount(filters: DownloadFilters): number {
  return (filters.date !== 'any' ? 1 : 0) + filters.types.length
}
