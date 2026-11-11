import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Keeps the store's `update` in step with the main process's update check (main/updater.ts), and
 * opens Settings › Updates when the app menu's "Check for Updates…" asks to. */
export function useUpdates(): void {
  useEffect(() => {
    const { setUpdate, openSettings } = useAppStore.getState()
    const stopState = window.mergelane.onUpdateState(setUpdate)
    const stopShow = window.mergelane.onShowUpdates(() => openSettings('updates'))
    window.mergelane.updateState().then(setUpdate, () => {})
    return () => {
      stopState()
      stopShow()
    }
  }, [])
}

/** Whether there's an update to tell the user about: found, on its way, or ready. */
export const hasUpdate = (update: { status: string } | null): boolean =>
  ['available', 'downloading', 'verifying', 'ready'].includes(update?.status ?? '')
