import type { SpeedTestLive, SpeedTestRequest, SpeedTestRun } from '@shared/speedTest'
import { useCallback, useEffect, useState } from 'react'

export interface SpeedTestState {
  /** The test in progress, if any. */
  live: SpeedTestLive | null
  /** Past tests, newest first. */
  history: SpeedTestRun[]
  /** The last test that ended while the view was open, kept or not (a cancelled or unavailable one
   * isn't in history). */
  last: SpeedTestRun | null
  /** Why the last start or clear was refused. */
  error: string | null
  start: (request: SpeedTestRequest) => Promise<void>
  cancel: () => void
  clearHistory: () => Promise<void>
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // Electron prefixes errors thrown in the main process with where they came from.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** The speed test's state, kept in step with the main process (main/speedTest, ADR-0064): the test
 * may already be running when the view opens, and goes on while it's closed. */
export function useSpeedTest(): SpeedTestState {
  const [live, setLive] = useState<SpeedTestLive | null>(null)
  const [history, setHistory] = useState<SpeedTestRun[]>([])
  const [last, setLast] = useState<SpeedTestRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const api = window.mergelane
    let current = true
    const reload = (): void =>
      void api.speedTestHistory().then(
        (runs) => current && setHistory(runs),
        () => {}
      )
    const stopLive = api.onSpeedTestLive(setLive)
    const stopFinished = api.onSpeedTestFinished((run) => {
      setLast(run)
      reload()
    })
    // A push may already have said more than this answer, which was asked for earlier.
    api.speedTestLive().then(
      (now) => current && setLive((pushed) => pushed ?? now),
      () => {}
    )
    reload()
    return () => {
      current = false
      stopLive()
      stopFinished()
    }
  }, [])

  const start = useCallback(async (request: SpeedTestRequest) => {
    setError(null)
    setLast(null)
    try {
      await window.mergelane.speedTestStart(request)
    } catch (caught) {
      setError(message(caught))
    }
  }, [])

  const cancel = useCallback(() => void window.mergelane.speedTestCancel().catch(() => {}), [])

  const clearHistory = useCallback(async () => {
    setError(null)
    try {
      await window.mergelane.speedTestClearHistory()
      setHistory([])
    } catch (caught) {
      setError(message(caught))
    }
  }, [])

  return { live, history, last, error, start, cancel, clearHistory }
}
