import type { DownloadUnitState } from '@shared/types'
import { cn } from 'cn'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import type { NetworkVisual } from '../theme'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { formatBytes, type NetworkGroup } from '../utils/format'

// The grid is a byte-space map of the file: one square per chunk, running left-to-right,
// top-to-bottom. Each square is drawn in exactly one network's color — a square reads as one
// network's work, never as a gradient. Which network that is comes from per-network byte tallies
// (see describeBlocks), so the winner is whoever truly moved the most bytes there, including when
// a chunk changed hands mid-flight after a dropped connection or a pause/resume. Hovering reads
// out the exact split.
//
// Vocabulary is the same as the streams table's: a *chunk* is one real 8 MB unit the downloader
// actually fetches (what NetworkRow labels "Chunk #N"), and every chunk gets its own square. No
// grouping, no averaging — square #7 is chunk #7, so a hovered square points at exactly the work
// one stream did and the two views can be read against each other directly.
//
// A big file therefore makes a tall grid rather than a coarser one. Past MAX_VISIBLE_ROWS the
// grid scrolls instead of growing without bound or shrinking its squares: keeping the squares at
// a fixed size is what keeps them the same unit of meaning on every download, and the scroll
// height is what a multi-gigabyte file's chunk count honestly looks like.
// The final design's chunk map (design-system/mergelane/redesign/prototype.html, LaneMap): each chunk
// is a capsule dash like a lane marking, 6px tall in a 14px row, about 14px wide with 4px gaps.
const TARGET_CELL_PX = 14
const CELL_GAP_PX = 4
const CELL_HEIGHT_PX = 14
const DASH_HEIGHT_PX = 6
const MIN_COLS = 8
// Rows visible before the grid starts scrolling: few enough that the network table below keeps
// room for its rows at the window's minimum height.
const MAX_VISIBLE_ROWS = 4
// Room for the pointed-at outline (2px, offset 2) so it isn't clipped against the scroll edges.
const GRID_INSET_PX = 4
// Rows drawn beyond the visible ones on each side, so a scroll doesn't show blank rows first.
const BUFFER_ROWS = 2

// A cell whose bytes can't be traced to a network must not borrow a network's colour: unknown
// provenance reads as neutral ink instead, which is honest and impossible to misread.
const UNATTRIBUTED_SOLID = 'var(--text-tertiary)'

/** One network's share of a cell's downloaded bytes. */
interface CellSegment {
  interfaceId: string
  bytes: number
}

interface DisplayCell {
  status: DownloadUnitState['status']
  /** The network that delivered the most bytes here — what the cell reads out as, and what
   * colors it when its share is drawn as a single block. */
  interfaceId?: string
  /** Every network that delivered bytes here, in legend order. The square itself is painted a
   * single color (`interfaceId`), but this is what decides that winner honestly and what the
   * hover readout breaks down, so a cell shared between networks still says so. */
  segments: CellSegment[]
  fillRatio: number
  totalBytes: number
  bytesDownloaded: number
  provisionalBytes: number
  /** 1-based chunk number, matching the "Chunk #N" badges in the streams table so a hovered
   * square points back at a specific stream's work. */
  chunkNumber: number
}

/** Describes each chunk as one grid square.
 *
 * Attribution comes from a block's per-network byte tallies, never from its current
 * `interfaceId`: that field is only the worker holding the block right now, so a block that a
 * retry or a pause/resume handed from one network to another would otherwise be repainted in the
 * finishing network's color. `orderedInterfaceIds` fixes the order contributors are listed in, so
 * a square's readout doesn't reshuffle between progress pushes. */
function describeBlocks(
  blocks: DownloadUnitState[],
  orderedInterfaceIds: string[],
  firstIndex = 0
): DisplayCell[] {
  return blocks.map((block, index) => {
    const totalBytes = block.rangeEnd !== null ? block.rangeEnd - block.rangeStart + 1 : 0

    // Per-network tallies are the accurate source. When a block has none — bytes recorded by an
    // older main process, or a block adopted whole off disk — fall back to crediting its whole
    // byte count to the network holding it. That is the coarse attribution this replaced, but it
    // is still far better than dropping the block to "unknown".
    let tallies = Object.entries(block.bytesByInterface ?? {}).filter(([, bytes]) => bytes > 0)
    if (tallies.length === 0 && block.interfaceId && block.bytesDownloaded > 0) {
      tallies = [[block.interfaceId, block.bytesDownloaded]]
    }
    const bytesByInterface = new Map(tallies)

    const knownOrder = orderedInterfaceIds.filter((id) => bytesByInterface.has(id))
    const extras = [...bytesByInterface.keys()].filter((id) => !orderedInterfaceIds.includes(id))
    const segments: CellSegment[] = [...knownOrder, ...extras].map((interfaceId) => ({
      interfaceId,
      bytes: bytesByInterface.get(interfaceId)!
    }))

    let dominantInterfaceId: string | undefined
    let dominantBytes = 0
    for (const segment of segments) {
      if (segment.bytes > dominantBytes) {
        dominantBytes = segment.bytes
        dominantInterfaceId = segment.interfaceId
      }
    }

    return {
      status: block.status,
      // Before any bytes land, a chunk in flight is still fairly labelled by the network that is
      // fetching it — but only then.
      interfaceId:
        dominantInterfaceId ?? (block.status === 'downloading' ? block.interfaceId : undefined),
      segments,
      fillRatio:
        totalBytes > 0
          ? (block.bytesDownloaded + (block.kind === 'torrent' ? block.provisionalBytes : 0)) /
            totalBytes
          : 0,
      totalBytes,
      bytesDownloaded: block.bytesDownloaded,
      provisionalBytes: block.kind === 'torrent' ? block.provisionalBytes : 0,
      chunkNumber: firstIndex + index + 1
    }
  })
}

/** Names the networks behind a cell: one name when a single network delivered it, and a
 * share-annotated list when several did — the point of the split coloring is that the user can
 * see, and read out, that a square was a joint effort. */
function describeContributors(
  cell: DisplayCell,
  visualByInterfaceId: Map<string, NetworkVisual>
): string | undefined {
  const named = cell.segments
    .filter((segment) => segment.bytes > 0)
    .map((segment) => ({
      name: visualByInterfaceId.get(segment.interfaceId)?.name,
      bytes: segment.bytes
    }))
    .filter((entry): entry is { name: string; bytes: number } => Boolean(entry.name))
    .sort((a, b) => b.bytes - a.bytes)

  if (named.length === 0) {
    return cell.interfaceId ? visualByInterfaceId.get(cell.interfaceId)?.name : undefined
  }
  if (named.length === 1) return named[0].name

  const total = named.reduce((sum, entry) => sum + entry.bytes, 0)
  return named
    .map((entry) => `${entry.name} ${Math.round((entry.bytes / total) * 100)}%`)
    .join(', ')
}

interface BlockGridProps {
  blocks?: DownloadUnitState[]
  groups: NetworkGroup[]
  visuals: NetworkVisual[]
  knownSize: boolean
  remainingBytes: number
  isPaused?: boolean
  /** A torrent's grid: its blocks are the torrent's pieces. */
  pieces?: boolean
  /** An NZB's grid: its blocks are Usenet articles, of varying size. */
  articles?: boolean
}

export function BlockGrid({
  blocks,
  groups,
  visuals,
  knownSize,
  remainingBytes,
  isPaused = false,
  pieces = false,
  articles = false
}: BlockGridProps): React.JSX.Element {
  // A video's blocks are its segments, sized as each comes in.
  const segments = blocks?.[0]?.kind === 'stream'
  const unit = pieces ? 'Piece' : articles ? 'Article' : segments ? 'Segment' : 'Chunk'
  const [gridWidth, setGridWidth] = useState(0)
  // The chunk pointed at, by the mouse or by the arrow keys: what the readout describes.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const readoutId = useId()
  const observerRef = useRef<ResizeObserver | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // How far the grid is scrolled: which rows are in view, for the way to what's active (below).
  const [scrollTop, setScrollTop] = useState(0)

  const fittedCols = Math.floor((gridWidth + CELL_GAP_PX) / (TARGET_CELL_PX + CELL_GAP_PX))
  // Squares keep their size and the grid wraps; how many rows that takes is the file's business,
  // not the window's. Only the width decides the wrap, exactly like a paragraph reflowing.
  const cols = Math.min(blocks?.length ?? 0, Math.max(MIN_COLS, fittedCols))

  // A callback ref rather than useEffect: the measured node only exists on the grid branch
  // below, so this has to re-observe whenever that node mounts or unmounts.
  const measureGrid = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      setGridWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  if (blocks && blocks.length > 1) {
    const visualByInterfaceId = new Map<string, NetworkVisual>()
    groups.forEach((g, idx) => {
      if (visuals[idx]) {
        visualByInterfaceId.set(g.id, visuals[idx])
      }
    })

    const orderedInterfaceIds = groups.map((g) => g.id)
    const lastEnd = blocks.at(-1)?.rangeEnd ?? null
    // An NZB's articles differ in size (each file's last is shorter): what one is on average.
    const chunkBytes =
      articles && lastEnd !== null
        ? Math.round((lastEnd + 1) / blocks.length)
        : blocks[0].rangeEnd !== null
          ? blocks[0].rangeEnd - blocks[0].rangeStart + 1
          : 0
    const rows = Math.ceil(blocks.length / cols)
    const visibleRows = Math.min(rows, MAX_VISIBLE_ROWS)
    // Only the rows in view (and a few either side) are drawn: a big torrent has hundreds of
    // thousands of pieces. Padding above and below stands in for the rest, so the scroll height
    // is the whole file's.
    const rowStride = CELL_HEIGHT_PX + CELL_GAP_PX
    const startRow = Math.max(0, Math.floor(scrollTop / rowStride) - BUFFER_ROWS)
    const endRow = Math.min(rows, Math.floor(scrollTop / rowStride) + visibleRows + BUFFER_ROWS)
    const firstIndex = startRow * cols
    const cells =
      gridWidth > 0
        ? describeBlocks(blocks.slice(firstIndex, endRow * cols), orderedInterfaceIds, firstIndex)
        : []
    // Cut the viewport exactly on a row boundary, so a scrollable grid never shows a half-row
    // that could be mistaken for a shorter square.
    const gridMaxHeight =
      visibleRows * CELL_HEIGHT_PX + (visibleRows - 1) * CELL_GAP_PX + GRID_INSET_PX * 2

    // The grid stays where it's scrolled: following the work moved it from under the reader, and
    // a torrent's work is all over the file. When none of what's in flight is in view, a pill
    // points the way to the nearest of it, and goes there.
    const firstInView = Math.round(scrollTop / rowStride)
    const lastInView = firstInView + visibleRows - 1
    const activeRows = blocks.flatMap((block, index) =>
      block.status === 'downloading' ? [Math.floor(index / cols)] : []
    )
    const nearestActive =
      rows <= MAX_VISIBLE_ROWS || activeRows.some((row) => row >= firstInView && row <= lastInView)
        ? null
        : activeRows.reduce<number | null>((nearest, row) => {
            const distance = (r: number): number =>
              r < firstInView ? firstInView - r : r - lastInView
            return nearest === null || distance(row) < distance(nearest) ? row : nearest
          }, null)
    const goToActive = (): void => {
      if (nearestActive === null) return
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      scrollerRef.current?.scrollTo({
        // A row of what's before it above, for context.
        top: Math.max(0, nearestActive - 1) * rowStride,
        behavior: reduce ? 'auto' : 'smooth'
      })
    }

    // Pointing reads out below the map rather than in a native `title` tooltip: the grid re-renders
    // on every progress push, which resets Chromium's tooltip timer so it never appears on an active
    // block — and a tooltip advertises nothing to point at in the first place.
    const hoveredCell =
      hoveredIndex !== null && blocks[hoveredIndex]
        ? describeBlocks([blocks[hoveredIndex]], orderedInterfaceIds, hoveredIndex)[0]
        : undefined
    let readout: string
    if (hoveredCell) {
      const contributors = describeContributors(hoveredCell, visualByInterfaceId)
      const where =
        hoveredCell.status === 'pending'
          ? 'not fetched yet'
          : hoveredCell.status === 'skipped'
            ? 'skipped: in no file chosen'
            : hoveredCell.status === 'missing'
              ? 'missing on the server: needs a par2 repair'
              : contributors
                ? `${hoveredCell.status === 'downloading' ? 'in progress over' : 'fetched over'} ${contributors}`
                : 'not attributed to a network'
      const provisional =
        hoveredCell.provisionalBytes > 0
          ? `, ${formatBytes(hoveredCell.provisionalBytes)} more received and awaiting verification`
          : ''
      readout = `${unit} ${hoveredCell.chunkNumber} of ${blocks.length}: ${formatBytes(hoveredCell.bytesDownloaded)} of ${formatBytes(hoveredCell.totalBytes)} verified${provisional}, ${where}`
    } else {
      const how = 'Point at one, or focus the map and use the arrow keys.'
      readout =
        segments || chunkBytes <= 0
          ? `${blocks.length} ${unit.toLowerCase()}s. ${how}`
          : `${blocks.length} ${unit.toLowerCase()}s of about ${formatBytes(chunkBytes)}. ${how}`
    }

    // The arrow keys move along the map (up and down a row), Home and End jump to either end, and
    // Escape lets go. The scroller follows, so the chunk read out is always in view.
    const pointAt = (index: number): void => {
      setHoveredIndex(index)
      const row = Math.floor(index / cols)
      const scroller = scrollerRef.current
      if (!scroller) return
      if (row < firstInView) scroller.scrollTop = row * rowStride
      else if (row > lastInView) scroller.scrollTop = (row - visibleRows + 1) * rowStride
    }
    const onKeyDown = (event: React.KeyboardEvent): void => {
      const last = blocks.length - 1
      const moves: Record<string, number> = {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: cols,
        ArrowUp: -cols
      }
      if (event.key in moves) {
        event.preventDefault()
        const from = hoveredIndex ?? -1
        pointAt(Math.min(last, Math.max(0, hoveredIndex === null ? 0 : from + moves[event.key])))
      } else if (event.key === 'Home') {
        event.preventDefault()
        pointAt(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        pointAt(last)
      } else if (event.key === 'Escape') {
        setHoveredIndex(null)
      }
    }
    const mapLabel = `${unit} map`

    return (
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-3.5 pt-3 pb-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {groups.map((group, idx) => {
            const visual = visuals[idx]
            return (
              <span
                key={group.id}
                className="inline-flex items-center gap-1.5 text-[12px] leading-none text-ink-2"
              >
                <span
                  aria-hidden
                  className="h-1.5 w-3 shrink-0 rounded-full"
                  style={{ background: visual.solid }}
                />
                {visual.name}
              </span>
            )
          })}
        </div>

        <div className="relative">
          {nearestActive !== null && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={goToActive}
                    aria-label={`Show the ${unit.toLowerCase()}s in progress`}
                    className={cn(
                      'absolute right-4 z-10 flex size-6 cursor-default items-center justify-center rounded-full bg-card text-ink-2 shadow-[var(--shadow-raise)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      nearestActive < firstInView ? '-top-1' : '-bottom-1'
                    )}
                  >
                    {nearestActive < firstInView ? (
                      <ArrowUp aria-hidden className="size-3.5" />
                    ) : (
                      <ArrowDown aria-hidden className="size-3.5" />
                    )}
                  </button>
                }
              />
              <TooltipContent>{`Show the ${unit.toLowerCase()}s in progress`}</TooltipContent>
            </Tooltip>
          )}
          <div
            ref={scrollerRef}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onMouseLeave={() => setHoveredIndex(null)}
            style={{
              maxHeight: gridMaxHeight,
              // gridMaxHeight is measured including the inset padding, so say so rather than
              // leaning on the global reset — a content-box here would cut a half-row.
              boxSizing: 'border-box',
              overflowY: rows > MAX_VISIBLE_ROWS ? 'auto' : 'visible',
              // The scrollbar takes width from the grid, and the ResizeObserver sits on the grid
              // itself rather than this scroller, so the column count already accounts for it.
              padding: GRID_INSET_PX,
              margin: -GRID_INSET_PX
            }}
          >
            <div
              ref={measureGrid}
              tabIndex={0}
              role="group"
              aria-label={mapLabel}
              aria-describedby={readoutId}
              onKeyDown={onKeyDown}
              onBlur={() => setHoveredIndex(null)}
              className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: CELL_GAP_PX,
                width: '100%',
                minHeight: CELL_HEIGHT_PX,
                paddingTop: startRow * rowStride,
                paddingBottom: (rows - endRow) * rowStride
              }}
            >
              {cells.map((cell, slot) => {
                const index = firstIndex + slot
                const visual = cell.interfaceId
                  ? visualByInterfaceId.get(cell.interfaceId)
                  : undefined
                const color = visual?.solid || UNATTRIBUTED_SOLID

                // Fetched: the dash in the colour of the network that delivered most of it. In
                // flight: a ring in that colour, filling as it comes in. Not yet: the bare track.
                let background = 'var(--track-bg)'
                let boxShadow: string | undefined
                let opacity = 1
                if (cell.status === 'completed') {
                  background = color
                } else if (cell.status === 'downloading') {
                  boxShadow = `0 0 0 1px ${color}`
                  opacity = isPaused ? 0.5 : 1
                } else if (cell.status === 'skipped') {
                  // None of the files chosen needs it: there, but not this download's.
                  opacity = 0.35
                } else if (cell.status === 'missing') {
                  // The server didn't have it: a hole in its file, for a par2 repair to fill.
                  background = 'var(--color-danger-bg)'
                  boxShadow = '0 0 0 1px var(--color-danger)'
                }

                const rawFillPercent = Math.min(1, Math.max(0, cell.fillRatio)) * 100
                // A dash is only ~14px wide, so the first bytes of a chunk round to nothing —
                // floor a started chunk to a visible sliver rather than 0 width.
                const fillPercent =
                  cell.status === 'completed' || rawFillPercent <= 0
                    ? 0
                    : Math.max(8, Math.round(rawFillPercent))

                return (
                  <span
                    key={index}
                    data-chunk={index + 1}
                    onMouseEnter={() => setHoveredIndex(index)}
                    className="flex items-center"
                    style={{ height: CELL_HEIGHT_PX }}
                  >
                    <span
                      className="relative block w-full overflow-hidden rounded-full"
                      style={{
                        height: DASH_HEIGHT_PX,
                        background,
                        boxShadow,
                        opacity,
                        outline: hoveredIndex === index ? '2px solid var(--focus)' : undefined,
                        outlineOffset: 2,
                        transition: 'opacity 0.3s'
                      }}
                    >
                      {fillPercent > 0 && (
                        <span
                          className="absolute inset-y-0 left-0"
                          style={{
                            width: `${fillPercent}%`,
                            background: color,
                            opacity:
                              cell.provisionalBytes > 0 && cell.bytesDownloaded === 0 ? 0.55 : 1,
                            transition: 'width 0.15s, background 0.15s'
                          }}
                        />
                      )}
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
        </div>

        <p
          id={readoutId}
          aria-live="polite"
          className="min-h-[1.5em] text-[12px] leading-snug text-ink-2"
        >
          {readout}
        </p>
      </div>
    )
  }

  // Fallback for single stream / non-splittable download: clean horizontal bar
  return (
    <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-track">
      {knownSize ? (
        <>
          {groups.map((group, index) => (
            <div
              key={group.id}
              style={{
                flex: group.bytesDownloaded || 0.0001,
                background: visuals[index].solid
              }}
            />
          ))}
          <div style={{ flex: remainingBytes || 0.0001 }} />
        </>
      ) : (
        <div className="w-full bg-primary" />
      )}
    </div>
  )
}
