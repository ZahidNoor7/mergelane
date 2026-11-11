import {
  customRangeInvalid,
  DATE_RANGES,
  dayInput,
  daysBefore,
  fileTypeOf,
  FILE_TYPES,
  filtersActive,
  matchesFilters,
  parseDay,
  type DownloadFilters,
  type Filterable
} from '@shared/downloadFilters'
import { CalendarDays, TriangleAlert, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { FILE_TYPE_ICON } from './fileTypeIcons'
import { Button } from './ui/button'
import { Toggle } from './ui/toggle'

// The download list's filters by date added and file type, from the final design
// (design-system/mergelane/redesign/prototype.html, FilterPanel and ActiveFilterChips). The logic is
// in shared/downloadFilters.ts.

export const FILTER_PANEL_ID = 'download-filters'

function Chip({
  pressed,
  onPress,
  count,
  children
}: {
  pressed: boolean
  onPress: () => void
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Toggle variant="pill" size="sm" pressed={pressed} onPressedChange={onPress}>
      {children}
      {count !== undefined && <span className="figures font-[500] text-ink-3">{count}</span>}
    </Toggle>
  )
}

/** The filters, open below the status tabs: date ranges and types, each with how many it would
 * show given the other, and how many are showing. */
export function FilterPanel({
  items,
  shown,
  now,
  onDone
}: {
  /** Every listed download, before the filters and the search. */
  items: Filterable[]
  /** How many the filters and the search leave. */
  shown: number
  now: number
  onDone: () => void
}): React.JSX.Element {
  const filters = useAppStore((store) => store.downloadFilters)
  const setFilters = useAppStore((store) => store.setDownloadFilters)
  const clearFilters = useAppStore((store) => store.clearDownloadFilters)
  const backwards = customRangeInvalid(filters)
  const today = dayInput(now)
  // Each choice's count, given the other filter as it stands.
  const byDate = (date: DownloadFilters['date']): number =>
    items.filter((item) => matchesFilters(item, { ...filters, date }, now)).length
  const byType = (type: string): number =>
    items.filter(
      (item) => matchesFilters(item, { ...filters, types: [] }, now) && fileTypeOf(item) === type
    ).length

  return (
    <div
      id={FILTER_PANEL_ID}
      role="group"
      aria-label="Filters"
      className="flex flex-col gap-4 rounded-[14px] bg-card p-3.5 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 flex items-center gap-1.5 text-[12.5px] font-[650] text-ink-2">
          <CalendarDays aria-hidden className="size-3.5" />
          Date added
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {DATE_RANGES.map((range) => (
            <Chip
              key={range.id}
              pressed={filters.date === range.id}
              count={range.id === 'any' || range.id === 'custom' ? undefined : byDate(range.id)}
              onPress={() =>
                setFilters(
                  // A new custom range starts as the last week, so it shows something at once.
                  range.id === 'custom' && !filters.from && !filters.to
                    ? { date: 'custom', from: dayInput(daysBefore(now, 6)), to: today }
                    : { date: range.id }
                )
              }
            >
              {range.label}
            </Chip>
          ))}
        </div>
        {filters.date === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {(
              [
                ['from', 'From'],
                ['to', 'To']
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex h-8 items-center gap-2 rounded-full bg-[var(--input-bg)] pr-2 pl-3 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--control)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
              >
                {label}
                <input
                  type="date"
                  value={filters[key]}
                  max={today}
                  aria-invalid={backwards || undefined}
                  onChange={(event) => setFilters({ [key]: event.target.value })}
                  className="figures bg-transparent text-[13.5px] text-foreground outline-none"
                />
              </label>
            ))}
            {backwards ? (
              <span
                role="alert"
                className="inline-flex items-center gap-1.5 text-[12px] text-destructive"
              >
                <TriangleAlert aria-hidden className="size-3.5" />
                The start date is after the end date.
              </span>
            ) : (
              <span className="text-[12px] text-ink-3">Both days included.</span>
            )}
          </div>
        )}
      </fieldset>
      <fieldset className="flex flex-col">
        <legend className="mb-2 text-[12.5px] font-[650] text-ink-2">File type</legend>
        <div className="flex flex-wrap gap-1.5">
          <Chip pressed={filters.types.length === 0} onPress={() => setFilters({ types: [] })}>
            Any type
          </Chip>
          {FILE_TYPES.map((type) => {
            const on = filters.types.includes(type.id)
            const Icon = FILE_TYPE_ICON[type.id]
            return (
              <Chip
                key={type.id}
                pressed={on}
                count={byType(type.id)}
                onPress={() =>
                  setFilters({
                    types: on
                      ? filters.types.filter((chosen) => chosen !== type.id)
                      : [...filters.types, type.id]
                  })
                }
              >
                <Icon aria-hidden />
                {type.label}
              </Chip>
            )
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <p className="text-[12.5px] text-ink-2" aria-live="polite">
          Showing <span className="figures font-[640] text-foreground">{shown}</span> of{' '}
          {items.length} downloads
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={!filtersActive(filters)}
          onClick={clearFilters}
        >
          Clear filters
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

const shortDay = (value: string): string => {
  const day = parseDay(value)
  return day === null
    ? '…'
    : new Date(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The filters that are on, while the panel is closed: each removable on its own, or all at once. */
export function ActiveFilterChips(): React.JSX.Element {
  const filters = useAppStore((store) => store.downloadFilters)
  const setFilters = useAppStore((store) => store.setDownloadFilters)
  const clearFilters = useAppStore((store) => store.clearDownloadFilters)
  const dateLabel =
    filters.date === 'custom'
      ? `${shortDay(filters.from)} – ${shortDay(filters.to)}`
      : DATE_RANGES.find((range) => range.id === filters.date)!.label
  const items = [
    ...(filters.date !== 'any'
      ? [
          {
            key: 'date',
            label: dateLabel,
            icon: CalendarDays,
            clear: () => setFilters({ date: 'any' })
          }
        ]
      : []),
    ...filters.types.map((type) => ({
      key: type,
      label: FILE_TYPES.find((known) => known.id === type)!.label,
      icon: FILE_TYPE_ICON[type],
      clear: () => setFilters({ types: filters.types.filter((chosen) => chosen !== type) })
    }))
  ]
  return (
    <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <li key={item.key}>
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-selected pr-1 pl-2.5 text-[12.5px] font-[580] shadow-[inset_0_0_0_1px_var(--color-accent)]">
            <item.icon aria-hidden className="size-3.5 text-ink-2" />
            {item.label}
            <button
              type="button"
              aria-label={`Remove filter: ${item.label}`}
              onClick={item.clear}
              className="grid size-5 place-items-center rounded-full text-ink-2 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        </li>
      ))}
      <li>
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear all
        </Button>
      </li>
    </ul>
  )
}
