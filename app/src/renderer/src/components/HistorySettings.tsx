import { HISTORY_KEEP, type HistoryKeep } from '@shared/history'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Button } from './ui/button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Settings › Downloads › "Duplicates and history" (the design's HistorySettings; ADR-0080): how
// long History keeps what is no longer in the list, and forgetting it now.

export function HistorySettings(): React.JSX.Element {
  const keep = useAppStore((store) => store.historyKeep)
  const setKeep = useAppStore((store) => store.setHistoryKeep)
  const [removed, setRemoved] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [cleared, setCleared] = useState(false)

  const count = useCallback(() => {
    void window.mergelane.historyEntries().then(
      (entries) => setRemoved(entries.filter((entry) => !entry.inList).length),
      () => {}
    )
  }, [])
  useEffect(() => {
    count()
    return window.mergelane.onHistoryChanged(count)
  }, [count])

  const clear = async (): Promise<void> => {
    setConfirming(false)
    await window.mergelane.forgetHistory().catch(() => 0)
    setCleared(true)
    count()
  }

  return (
    <SettingsGroup title="Duplicates and history">
      <SettingRow
        label="Keep download history"
        hint="History is stored only on this computer. Removing a download from the list doesn’t remove it from history."
      >
        <ToggleGroup
          aria-label="Keep download history"
          value={[keep]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setKeep(values[0] as HistoryKeep)
          }}
        >
          {HISTORY_KEEP.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <SettingRow
        label="Clear history"
        hint={
          cleared
            ? 'History cleared. Everything in the list stays.'
            : `Forgets the ${removed} download${removed === 1 ? '' : 's'} no longer in the list. Files on disk aren’t touched.`
        }
      >
        {confirming ? (
          <span
            role="group"
            aria-label="Confirm clearing history"
            className="flex items-center gap-2"
          >
            <Button type="button" size="sm" variant="destructive" onClick={() => void clear()}>
              Clear
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={removed === 0}
            onClick={() => {
              setCleared(false)
              setConfirming(true)
            }}
          >
            <Trash2 aria-hidden data-icon="inline-start" />
            Clear history…
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  )
}
