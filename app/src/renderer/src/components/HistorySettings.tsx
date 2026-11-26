import type { DuplicateCheck } from '@shared/duplicates'
import { HISTORY_KEEP, type HistoryKeep } from '@shared/history'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Button } from './ui/button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Settings › Downloads › "Duplicates and history" (the design's HistorySettings; ADR-0080): how
// long History keeps what is no longer in the list, and forgetting it now.

const DUPLICATE_CHOICES: { value: DuplicateCheck; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'No warning.' },
  { value: 'link', label: 'Same link', hint: 'When the link matches one in your history.' },
  {
    value: 'both',
    label: 'Link or file',
    hint: 'When the link matches, or the same file is offered from another site: same name and size, and the SHA-256 the site publishes matches the file you have.'
  }
]

export function HistorySettings(): React.JSX.Element {
  const duplicateCheck = useAppStore((store) => store.duplicateCheck)
  const setDuplicateCheck = useAppStore((store) => store.setDuplicateCheck)
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
        label="Warn before downloading something you already have"
        hint={DUPLICATE_CHOICES.find((choice) => choice.value === duplicateCheck)?.hint}
      >
        <ToggleGroup
          aria-label="Duplicate warning"
          value={[duplicateCheck]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setDuplicateCheck(values[0] as DuplicateCheck)
          }}
        >
          {DUPLICATE_CHOICES.map((choice) => (
            <ToggleGroupItem key={choice.value} value={choice.value}>
              {choice.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
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
