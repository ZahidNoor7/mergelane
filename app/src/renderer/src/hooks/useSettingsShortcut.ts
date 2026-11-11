import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** ⌘, (Ctrl+, elsewhere) opens Settings, as in every Mac app. */
export function useSettingsShortcut(): void {
  useEffect(() => {
    const mac = window.mergelane.platform === 'darwin'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ',' || !(mac ? event.metaKey : event.ctrlKey)) return
      event.preventDefault()
      useAppStore.getState().openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
