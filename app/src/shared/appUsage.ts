// How much of the Mac Mergelane itself uses (the Dashboard's "Mergelane on this Mac", from the final
// design's UsagePanel), as Activity Monitor counts it: CPU where 100% is one full core, and memory
// in physical RAM. Pure, so it is tested on its own; main/appUsage.ts gathers the numbers.
//
// The app's own processes (main, renderer, GPU, utilities) come from Electron's app.getAppMetrics().
// The helper and the download tools (yt-dlp, FFmpeg, and the Deno yt-dlp runs) are read from `ps`,
// which reports any process's CPU and memory without admin rights (ADR-0035).

export interface PartUsage {
  /** Percent of one core, as Activity Monitor shows it: 200 is two cores flat out. */
  cpu: number
  /** Bytes of physical memory. */
  memory: number
}

export interface AppUsage {
  /** Mergelane's own processes. */
  app: PartUsage
  /** The system-merge helper; null when it isn't running. */
  helper: PartUsage | null
  /** yt-dlp, FFmpeg and what they start; count 0 when none is running. */
  tools: PartUsage & { count: number }
}

export interface PsRow {
  pid: number
  ppid: number
  cpu: number
  /** Bytes (ps reports kilobytes). */
  memory: number
  command: string
}

/** The arguments for one `ps` call that lists every process with what usage needs. */
export const PS_ARGS = ['-A', '-o', 'pid=,ppid=,%cpu=,rss=,comm=']

/** The helper's executable name, as `ps` shows it (its full path ends with it). */
export const HELPER_NAME = 'mergelane-daemon'

/** Processes under the app that aren't download tools: the `ps` that takes this very reading, and
 * Electron's crash reporter, which app.getAppMetrics() doesn't list. */
const NOT_TOOLS = ['ps', 'chrome_crashpad_handler']

/** Reads `ps -A -o pid=,ppid=,%cpu=,rss=,comm=`. A line that isn't one is skipped. */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      memory: Number(match[4]) * 1024,
      command: match[5]
    })
  }
  return rows
}

const sum = (rows: PsRow[]): PartUsage => ({
  cpu: rows.reduce((total, row) => total + row.cpu, 0),
  memory: rows.reduce((total, row) => total + row.memory, 0)
})

/** The helper's usage, and the download tools': every process under the app that isn't one of
 * its own (Electron's helpers are children of the main process too, so they're left out by pid). */
export function partsFromPs(
  rows: PsRow[],
  mainPid: number,
  appPids: ReadonlySet<number>
): Pick<AppUsage, 'helper' | 'tools'> {
  const helper = rows.filter(
    (row) => row.command === HELPER_NAME || row.command.endsWith(`/${HELPER_NAME}`)
  )
  // Descendants of the main process, level by level: a tool's own children (Deno) count too.
  const under = new Set<number>([mainPid])
  for (let grown = true; grown;) {
    grown = false
    for (const row of rows) {
      if (!under.has(row.pid) && under.has(row.ppid)) {
        under.add(row.pid)
        grown = true
      }
    }
  }
  const tools = rows.filter(
    (row) =>
      row.pid !== mainPid &&
      under.has(row.pid) &&
      !appPids.has(row.pid) &&
      !NOT_TOOLS.some((name) => row.command === name || row.command.endsWith(`/${name}`))
  )
  return {
    helper: helper.length > 0 ? sum(helper) : null,
    tools: { ...sum(tools), count: tools.length }
  }
}

/** One of the app's processes as Electron reports it: CPU seconds since it started, and memory in
 * kilobytes (Electron's ProcessMetric). */
export interface AppProcess {
  pid: number
  creationTime: number
  cpuSeconds: number
  memoryKb: number
}

/** The app's CPU between two readings, as a percent of one core, from each process's CPU seconds;
 * a process new since the last reading counts from its start. And its memory now, in bytes. */
export function appPart(
  now: AppProcess[],
  before: AppProcess[] | null,
  elapsedSeconds: number
): PartUsage {
  const key = (process: AppProcess): string => `${process.pid}:${process.creationTime}`
  const previous = new Map((before ?? []).map((process) => [key(process), process.cpuSeconds]))
  const used = now.reduce(
    (total, process) => total + Math.max(0, process.cpuSeconds - (previous.get(key(process)) ?? 0)),
    0
  )
  return {
    cpu: before && elapsedSeconds > 0 ? (used / elapsedSeconds) * 100 : 0,
    memory: now.reduce((total, process) => total + process.memoryKb * 1024, 0)
  }
}
