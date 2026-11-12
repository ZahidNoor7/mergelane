import type { AppUsage } from '@shared/appUsage'
import { SPEED_HISTORY_SECONDS } from '@shared/types'
import { useEffect, useState } from 'react'
import { Sparkline } from './Sparkline'
import { onWindows, words } from '../platformWords'

// The Dashboard's "Mergelane on this Mac", from the final design (prototype.html, UsagePanel): how
// much CPU and memory Mergelane itself uses, in all and by part, as Activity Monitor counts it. In
// ink only: colour stays for networks. Read once a second while the Dashboard shows.

const POLL_MS = 1000

/** "0.4%" under 10%, "37%" above, as the design writes them. */
function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`
}

/** "412 MB", or "1.24 GB" from a gigabyte (1,000-based, as Activity Monitor). */
function formatMemory(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`
}

export function UsagePanel({ merging }: { merging: boolean }): React.JSX.Element {
  const [usage, setUsage] = useState<AppUsage | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [hovered, setHovered] = useState<number | null>(null)

  useEffect(() => {
    let stopped = false
    const read = (): void => {
      void window.mergelane
        .appUsage()
        .then((next) => {
          if (stopped) return
          setUsage(next)
          const total = next.app.cpu + (next.helper?.cpu ?? 0) + next.tools.cpu
          setHistory((previous) => [...previous, total].slice(-SPEED_HISTORY_SECONDS))
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  const parts = usage
    ? [
        { name: 'Mergelane', note: 'The app: its window, downloads and engine', part: usage.app },
        {
          name: 'Helper',
          note: usage.helper
            ? merging
              ? 'System merge is on'
              : 'System merge is off'
            : 'Not running',
          part: usage.helper
        },
        {
          name: 'Video tools',
          note:
            usage.tools.count > 0
              ? 'yt-dlp, FFmpeg and Deno, for a video download'
              : 'Not running now',
          part: usage.tools.count > 0 ? usage.tools : null
        }
      ]
    : []
  const cpu = parts.reduce((total, each) => total + (each.part?.cpu ?? 0), 0)
  const memory = parts.reduce((total, each) => total + (each.part?.memory ?? 0), 0)

  return (
    <section aria-labelledby="dashboard-usage" className="flex flex-col gap-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule pt-7 pb-2">
        <h2 id="dashboard-usage" className="text-[13px] font-[650] tracking-[-0.005em]">
          Mergelane on {words().thisComputer}
        </h2>
        <span className="ml-auto text-[12px] text-ink-3">
          {onWindows()
            ? '100% is one full core. Task Manager divides by every core, so it shows less.'
            : 'As Activity Monitor counts it: 100% is one full core'}
        </span>
      </div>
      {usage === null ? (
        <p className="text-[12.5px] text-ink-3">Measuring…</p>
      ) : (
        <div className="grid gap-x-8 gap-y-5 @min-[768px]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-[12px] text-ink-3">CPU</dt>
                <dd className="figures text-[34px] leading-none font-[700] tracking-[-0.02em]">
                  {formatCpu(cpu)}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-[12px] text-ink-3">Memory</dt>
                <dd className="figures text-[34px] leading-none font-[700] tracking-[-0.02em]">
                  {formatMemory(memory)}
                </dd>
              </div>
            </dl>
            <Sparkline
              values={history}
              top={Math.max(1, ...history)}
              color="var(--text)"
              label={`Mergelane’s CPU over the last minute, now ${formatCpu(cpu)}`}
              hovered={hovered}
              onHover={setHovered}
            />
            <div className="flex justify-between text-[11.5px] text-ink-3">
              <span>60 s ago</span>
              <span>Now</span>
            </div>
          </div>
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Mergelane’s CPU and memory by part</caption>
              <thead>
                <tr className="border-b border-rule text-[12px] text-ink-3">
                  <th scope="col" className="pb-1.5 font-[600]">
                    Part
                  </th>
                  <th scope="col" className="w-16 pb-1.5 text-right font-[600]">
                    CPU
                  </th>
                  <th scope="col" className="w-20 pb-1.5 text-right font-[600]">
                    Memory
                  </th>
                </tr>
              </thead>
              <tbody>
                {parts.map((each) => (
                  <tr key={each.name} className="border-b border-rule last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="block truncate text-[13px] font-[600]">{each.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{each.note}</span>
                    </th>
                    <td className="figures py-2 text-right text-[14px] font-[600]">
                      {each.part ? formatCpu(each.part.cpu) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="figures py-2 text-right text-[13px] text-ink-2">
                      {each.part ? formatMemory(each.part.memory) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
