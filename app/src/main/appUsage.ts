import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appPart,
  partsFromPs,
  parsePs,
  PS_ARGS,
  type AppProcess,
  type AppUsage
} from '../shared/appUsage'

// The Dashboard's "Mergelane on this Mac" (shared/appUsage.ts): the app's processes from
// app.getAppMetrics(), whose cpu.cumulativeCPUUsage is CPU seconds since each process started and
// memory.workingSetSize is kilobytes (Electron's ProcessMetric, CPUUsage and MemoryInfo docs); the
// helper and the download tools from one `ps` call (ADR-0035).

const run = promisify(execFile)

let last: { at: number; processes: AppProcess[] } | null = null

export async function readAppUsage(): Promise<AppUsage> {
  const at = Date.now()
  const processes = app.getAppMetrics().map((metric): AppProcess => ({
    pid: metric.pid,
    creationTime: metric.creationTime,
    cpuSeconds: metric.cpu.cumulativeCPUUsage ?? 0,
    memoryKb: metric.memory.workingSetSize
  }))
  const appUsage = appPart(processes, last?.processes ?? null, last ? (at - last.at) / 1000 : 0)
  last = { at, processes }
  let rest: Pick<AppUsage, 'helper' | 'tools'> = {
    helper: null,
    tools: { cpu: 0, memory: 0, count: 0 }
  }
  try {
    const { stdout } = await run('/bin/ps', PS_ARGS, { maxBuffer: 4 * 1024 * 1024 })
    rest = partsFromPs(parsePs(stdout), process.pid, new Set(processes.map((each) => each.pid)))
  } catch {
    // Without ps, only the app's own numbers: the rest reads as not running.
  }
  return { app: appUsage, ...rest }
}
