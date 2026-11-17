import type { TrafficRate } from '@shared/interfaceCounters'
import { SPEED_HISTORY_SECONDS } from '@shared/types'
import { useEffect, useState } from 'react'

const POLL_MS = 1000

export interface NetworkTraffic {
  /** Each network's speed now, by id. Undefined until the first answer; null where the computer's counters can't
   * be read (Windows, for now), so the caller shows Mergelane's own downloads instead. */
  traffic: Record<string, TrafficRate> | null | undefined
  /** Each network's speed, received and sent together, a sample a second, oldest first: the last minute, for the
   * Dashboard's chart. Every series is as long as the longest, as the chart expects. */
  history: Record<string, number[]>
}

/** Each network's speed from every app on the Mac, by network id, once a second while `active` (ADR-0070): the
 * Dashboard's "Total speed, all apps" and its last minute (ADR-0071). */
export function useNetworkTraffic(active: boolean): NetworkTraffic {
  const [state, setState] = useState<NetworkTraffic>({ traffic: undefined, history: {} })

  useEffect(() => {
    if (!active) return
    let current = true
    const read = (): void => {
      window.mergelane.networkTraffic().then(
        (latest) => {
          if (!current) return
          setState((previous) => ({
            traffic: latest,
            history: appendSample(previous.history, latest)
          }))
        },
        () => {
          if (current) setState((previous) => ({ ...previous, traffic: null }))
        }
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [active])

  return state
}

/** The history with this second's speeds on the end, a minute kept. A network not in this reading reads 0. */
function appendSample(
  history: Record<string, number[]>,
  latest: Record<string, TrafficRate> | null
): Record<string, number[]> {
  if (!latest) return history
  const ids = new Set([...Object.keys(history), ...Object.keys(latest)])
  const length = Math.max(0, ...Object.values(history).map((series) => series.length))
  const next: Record<string, number[]> = {}
  for (const id of ids) {
    const before = history[id] ?? Array<number>(length).fill(0)
    const rate = latest[id]
    next[id] = [...before, rate ? rate.rx + rate.tx : 0].slice(-SPEED_HISTORY_SECONDS)
  }
  return next
}
