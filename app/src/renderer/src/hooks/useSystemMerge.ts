import { useCallback, useEffect, useRef, useState } from 'react'
import type { SystemMergeSnapshot } from '../../../shared/types'

const POLL_MS = 1000

/** What a request from the System merge section does, so only its own control says it's busy. */
export type SystemMergeAction = 'merge' | 'install' | 'update' | 'autoResume'

/** mergelane-daemon's state, per-link traffic and recent link changes, polled every second while
 * `active` (the networks menu is open). `now` is when the snapshot arrived, for "2 min ago". `run`
 * sends one request and adopts the snapshot it returns; while it is in flight `busy` is true (and
 * `pending` names it), so nothing can be flipped twice. A poll that was asked before a request
 * started or finished is dropped, so a switch never flicks back to the old state. */
export function useSystemMerge(active: boolean): {
  snapshot: SystemMergeSnapshot | null
  now: number
  busy: boolean
  pending: SystemMergeAction | null
  run: (request: () => Promise<SystemMergeSnapshot>, action?: SystemMergeAction) => void
} {
  const [latest, setLatest] = useState<{ snapshot: SystemMergeSnapshot | null; now: number }>(
    () => ({ snapshot: null, now: Date.now() })
  )
  const [pending, setPending] = useState<SystemMergeAction | null>(null)
  const requests = useRef(0)
  const adopt = useCallback(
    (snapshot: SystemMergeSnapshot) => setLatest({ snapshot, now: Date.now() }),
    []
  )

  useEffect(() => {
    if (!active) return
    let disposed = false
    const load = (): void => {
      const asked = requests.current
      void window.mergelane
        .systemMerge()
        .then((next) => !disposed && asked === requests.current && adopt(next))
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [active, adopt])

  const run = useCallback(
    (request: () => Promise<SystemMergeSnapshot>, action: SystemMergeAction = 'merge') => {
      setPending(action)
      requests.current += 1
      void request()
        .then(adopt)
        .catch(() => {})
        .finally(() => {
          requests.current += 1
          setPending(null)
        })
    },
    [adopt]
  )

  return { snapshot: latest.snapshot, now: latest.now, busy: pending !== null, pending, run }
}
