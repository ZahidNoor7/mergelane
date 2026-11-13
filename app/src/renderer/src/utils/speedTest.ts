import type {
  SpeedTestLinkResult,
  SpeedTestNote,
  SpeedTestPhase,
  SpeedTestRun,
  SpeedTestScope
} from '@shared/speedTest'

// What the speed test view says and works out (ADR-0064), kept apart from the components so it is
// unit-tested on its own.

/** The choice of test, in the words the view uses. */
export const SCOPE_CHOICES: ReadonlyArray<{ scope: SpeedTestScope; label: string; hint: string }> =
  [
    {
      scope: 'link',
      label: 'Each network',
      hint: 'Tests the networks one at a time, so each gets the line to itself.'
    },
    {
      scope: 'combined',
      label: 'All together',
      hint: 'Uses the networks at the same time, as Mergelane’s downloads do, and measures what arrives.'
    },
    {
      scope: 'system',
      label: 'Other apps',
      hint: 'Goes through system merge, which picks a network for each connection, as for any other app.'
    }
  ]

export function scopeLabel(scope: SpeedTestScope): string {
  return SCOPE_CHOICES.find((choice) => choice.scope === scope)?.label ?? scope
}

export const PHASES: readonly SpeedTestPhase[] = ['latency', 'download', 'upload']

export function phaseLabel(phase: SpeedTestPhase): string {
  return phase === 'latency' ? 'Ping' : phase === 'download' ? 'Download' : 'Upload'
}

export function noteText(note: SpeedTestNote, pausedDownloads = 0): string {
  switch (note) {
    case 'downloads-paused':
      return pausedDownloads > 0
        ? `${pausedDownloads === 1 ? 'Your download was' : `Your ${pausedDownloads} downloads were`} paused for the test and resumed after it.`
        : 'Your downloads were paused for the test and resumed after it.'
    case 'busy-network':
      return 'Something else was using the network during the test, so its result may be low.'
    case 'sticky-sites-on':
      return 'System merge keeps each website on one network, so one site gets one network’s speed. Different sites still spread across them.'
    case 'speed-limit':
      return 'A speed limit in system merge applied to this test.'
  }
}

/** Dial scales, in bits a second: the smallest that clears the fastest reading so far. */
const DIAL_STEPS_MBPS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000]

/** The dial's top, in bytes a second, for the fastest reading so far: never below 5 Mbps, with a
 * tenth to spare so the arc doesn't sit pinned at the end. */
export function dialMax(peakBytesPerSec: number): number {
  const mbps = (Math.max(0, peakBytesPerSec) * 8 * 1.1) / 1_000_000
  const step = DIAL_STEPS_MBPS.find((each) => each >= mbps) ?? Math.ceil(mbps / 10_000) * 10_000
  return (step * 1_000_000) / 8
}

/** "12 ms", rounded to a whole millisecond, or a dash. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return `${ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)} ms`
}

/** The change from `before` to `now` as a whole percentage, or undefined when there's nothing to
 * compare. */
export function change(now: number | undefined, before: number | undefined): number | undefined {
  if (now === undefined || before === undefined || !(before > 0)) return undefined
  return Math.round(((now - before) / before) * 100)
}

/** The network's result in a run, or the run's total for 'combined' in a combined or system run. */
export type ResultKey = string

/** The figures of one row of results: a network's, or the total's. */
export interface ResultRow {
  key: ResultKey
  downloadBytesPerSec?: number
  uploadBytesPerSec?: number
  latencyMs?: number
  jitterMs?: number
}

export const TOTAL = 'combined'

/** A run's rows: the total first, for a run that has one, then each network. */
export function resultRows(run: SpeedTestRun): ResultRow[] {
  const rows: ResultRow[] = []
  if (run.combined) rows.push({ key: TOTAL, ...run.combined })
  for (const link of run.links) rows.push({ key: link.networkId, ...link })
  return rows
}

/** The same row in the latest earlier run of the same kind that finished, to compare with. */
export function previousRow(
  runs: readonly SpeedTestRun[],
  run: SpeedTestRun,
  key: ResultKey
): ResultRow | undefined {
  for (const earlier of runs) {
    if (earlier.startedAt >= run.startedAt || earlier.scope !== run.scope) continue
    if (earlier.status !== 'done') continue
    const row = resultRows(earlier).find((each) => each.key === key)
    if (!row) continue
    if (key !== TOTAL) {
      const link = earlier.links.find((each) => each.networkId === key)
      if (link?.status !== 'done') continue
    }
    return row
  }
  return undefined
}

/** A network's download speeds in past runs where it finished, oldest first, the last `count`. */
export function downloadTrend(
  runs: readonly SpeedTestRun[],
  networkId: string,
  count = 12
): number[] {
  const speeds: number[] = []
  for (const run of runs) {
    const link = run.links.find((each) => each.networkId === networkId)
    if (link?.status === 'done' && link.downloadBytesPerSec !== undefined) {
      speeds.push(link.downloadBytesPerSec)
      if (speeds.length === count) break
    }
  }
  return speeds.reverse()
}

/** Every network a run of `runs` measured, by id, with the last result that names it. */
export function testedNetworks(runs: readonly SpeedTestRun[]): SpeedTestLinkResult[] {
  const seen = new Map<string, SpeedTestLinkResult>()
  for (const run of runs) {
    for (const link of run.links) if (!seen.has(link.networkId)) seen.set(link.networkId, link)
  }
  return [...seen.values()]
}

/** "Today, 14:05", "Yesterday, 09:12" or "12 Nov, 18:30", in the computer's own clock. */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const day = (value: Date): string => value.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day(date) === day(new Date(now))) return `Today, ${time}`
  if (day(date) === day(yesterday)) return `Yesterday, ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}
