import { useCallback, useEffect, useState } from 'react'
import type { SystemMergeSnapshot } from '../../../shared/types'

const POLL_MS = 1000

/** mergelane-daemon's state and per-link traffic, polled every second while `active` (the
 * networks menu is open). `run` sends one request and adopts the snapshot it returns; while it is
 * in flight `busy` is true, so the switch can't be flipped twice. */
export function useSystemMerge(active: boolean): {
  snapshot: SystemMergeSnapshot | null
  busy: boolean
  run: (request: () => Promise<SystemMergeSnapshot>) => void
} {
  const [snapshot, setSnapshot] = useState<SystemMergeSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    let disposed = false
    const load = (): void => {
      void window.mergelane
        .systemMerge()
        .then((next) => !disposed && setSnapshot(next))
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [active])

  const run = useCallback((request: () => Promise<SystemMergeSnapshot>) => {
    setBusy(true)
    void request()
      .then(setSnapshot)
      .catch(() => {})
      .finally(() => setBusy(false))
  }, [])

  return { snapshot, busy, run }
}
