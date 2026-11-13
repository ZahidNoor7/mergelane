import { standouts, type SpeedTestRun } from '@shared/speedTest'
import { cn } from 'cn'
import { ArrowDown, ArrowUp, CircleAlert, Info } from 'lucide-react'
import { useState } from 'react'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import type { NetworkVisual } from '../../theme'
import { useAppStore } from '../../store/useAppStore'
import { formatSpeed } from '../../utils/format'
import {
  change,
  formatMs,
  formatWhen,
  noteText,
  previousRow,
  resultRows,
  scopeLabel,
  TOTAL,
  type ResultRow
} from '../../utils/speedTest'
import { NetworkTile } from '../NetworkTile'
import { SplitBar } from '../SplitBar'
import { Badge } from '../ui/badge'

// A test's results (ADR-0064): the total first for a test of all the networks together, then each
// network, with how each figure moved since the last test of the same kind, and which network was
// fastest, slowest and steadiest. A table, so it reads in rows and columns with assistive tech too.

type Column = 'downloadBytesPerSec' | 'uploadBytesPerSec' | 'latencyMs' | 'jitterMs'

const COLUMNS: ReadonlyArray<{ key: Column; label: string; speed: boolean }> = [
  { key: 'downloadBytesPerSec', label: 'Download', speed: true },
  { key: 'uploadBytesPerSec', label: 'Upload', speed: true },
  { key: 'latencyMs', label: 'Ping', speed: false },
  { key: 'jitterMs', label: 'Jitter', speed: false }
]

export function SpeedTestResults({
  run,
  runs,
  partial = false
}: {
  run: SpeedTestRun | null
  /** Every kept run, newest first, to compare with. */
  runs: SpeedTestRun[]
  /** The test is still running: these are the networks finished so far. */
  partial?: boolean
}): React.JSX.Element | null {
  const unit = useAppStore((store) => store.speedUnit)
  const networkVisual = useNetworkVisuals()
  // When the view opened: "Today" and "Yesterday" are said from then.
  const [now] = useState(() => Date.now())
  if (!run) return null
  const badges = standouts(run.links)
  const rows = resultRows(run)
  const share = run.combined?.share ?? {}
  const shareTotal = Object.values(share).reduce((sum, bytes) => sum + bytes, 0)
  const visualOf = (id: string): NetworkVisual => {
    const link = run.links.find((each) => each.networkId === id)
    return networkVisual(id, link?.kind ?? 'other', link?.name ?? id)
  }

  const figure = (row: ResultRow, column: (typeof COLUMNS)[number]): React.JSX.Element => {
    const value = row[column.key]
    const text =
      value === undefined ? '—' : column.speed ? formatSpeed(value, unit) : formatMs(value)
    const before = partial ? undefined : previousRow(runs, run, row.key)?.[column.key]
    const moved = change(value, before)
    return (
      <td key={column.key} className="py-2.5 pl-3 text-right align-top">
        <span className="figures block text-[14px] font-[620]">{text}</span>
        {moved !== undefined && moved !== 0 && (
          <span
            className="figures inline-flex items-center gap-0.5 text-[11.5px] text-ink-3"
            aria-label={`${Math.abs(moved)}% ${moved > 0 ? 'higher' : 'lower'} than the last test`}
          >
            {moved > 0 ? (
              <ArrowUp aria-hidden className="size-3" />
            ) : (
              <ArrowDown aria-hidden className="size-3" />
            )}
            {Math.abs(moved)}%
          </span>
        )}
      </td>
    )
  }

  return (
    <section aria-labelledby="speed-results" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id="speed-results" className="text-[14px] font-[650]">
          {partial ? 'Results so far' : 'Results'}
        </h2>
        <span className="text-[12px] text-ink-3">
          {scopeLabel(run.scope)}
          {partial ? '' : `, ${formatWhen(run.startedAt, now)}`}
        </span>
      </div>

      {!partial && run.status !== 'done' && (
        <p
          className={cn(
            'flex items-start gap-1.5 text-[12.5px] leading-[1.5]',
            run.status === 'failed' ? 'text-destructive' : 'text-ink-2'
          )}
        >
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {run.status === 'cancelled'
            ? 'The test was stopped before it finished.'
            : run.status === 'unavailable'
              ? `The test couldn’t run. ${run.reason ?? ''}`
              : `The test failed. ${run.reason ?? 'No network finished it.'}`}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule text-[12px] text-ink-3">
                <th scope="col" className="py-1.5 text-left font-[580]">
                  Network
                </th>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="py-1.5 pl-3 text-right font-[580]">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const total = row.key === TOTAL
                const link = run.links.find((each) => each.networkId === row.key)
                const visual = total ? null : visualOf(row.key)
                const ok = total || link?.status === 'done'
                return (
                  <tr key={row.key} className="border-b border-rule last:border-b-0">
                    <th scope="row" className="py-2.5 pr-2 text-left align-top font-normal">
                      <span className="flex items-center gap-2.5">
                        {visual && link ? (
                          <NetworkTile
                            kind={link.kind}
                            color={visual.solid}
                            onColor={visual.onSolid}
                            size={24}
                            dim={!ok}
                          />
                        ) : (
                          <span aria-hidden className="size-6 shrink-0" />
                        )}
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-[620]">
                              {total
                                ? run.scope === 'system'
                                  ? 'Through system merge'
                                  : 'All together'
                                : visual?.name}
                            </span>
                            {!total && badges.fastest === row.key && <Badge>Fastest</Badge>}
                            {!total && badges.slowest === row.key && <Badge>Slowest</Badge>}
                            {!total && badges.steadiest === row.key && <Badge>Steadiest</Badge>}
                          </span>
                          {total && shareTotal > 0 && (
                            <SplitBar
                              label="Each network’s part of the download"
                              percent={100}
                              valueText={Object.entries(share)
                                .map(
                                  ([id, bytes]) =>
                                    `${visualOf(id).name} ${Math.round((bytes / shareTotal) * 100)}%`
                                )
                                .join(', ')}
                              segments={Object.entries(share).map(([id, bytes]) => ({
                                id,
                                share: bytes / shareTotal,
                                color: visualOf(id).solid
                              }))}
                            />
                          )}
                          {!ok && link && (
                            <span
                              className={cn(
                                'text-[12px]',
                                link.status === 'failed' ? 'text-destructive' : 'text-ink-3'
                              )}
                            >
                              {link.status === 'failed' ? 'Failed: ' : 'Not tested: '}
                              {link.reason ?? ''}
                            </span>
                          )}
                        </span>
                      </span>
                    </th>
                    {COLUMNS.map((column) => figure(row, column))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!partial && run.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {run.notes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-ink-2"
            >
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {noteText(note)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
