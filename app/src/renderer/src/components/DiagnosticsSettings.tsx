import { cn } from 'cn'
import { FileArchive, FolderOpen } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Button } from './ui/button'

// Settings › General › Troubleshooting (M3.7, docs/DECISIONS.md ADR-0042). The design has no place for
// a diagnostics bundle, so it is a row in Settings' own parts, and an app menu item ("Save
// Diagnostics…") that comes here and saves one. Mergelane never sends it anywhere.

const ABOUT =
  'A zip file of Mergelane’s versions, your Mac’s networks, settings and recent downloads, to attach to a GitHub issue. Links keep only their site; file names, passwords, cookies and your home folder are left out. Mergelane never sends it anywhere.'

export function DiagnosticsSettings(): React.JSX.Element {
  const diagnostics = useAppStore((store) => store.diagnostics)
  const saveDiagnostics = useAppStore((store) => store.saveDiagnostics)
  const saving = diagnostics.status === 'saving'

  return (
    <SettingsGroup title="Troubleshooting">
      <SettingRow
        label="Diagnostics"
        hint={
          <>
            {ABOUT}
            <span
              role="status"
              aria-atomic="true"
              className={cn(
                'block',
                (diagnostics.status === 'saved' || diagnostics.status === 'error') && 'pt-1',
                diagnostics.status === 'error' ? 'text-destructive' : 'text-foreground'
              )}
            >
              {diagnostics.status === 'saving' && (
                <span className="sr-only">Saving the diagnostics…</span>
              )}
              {diagnostics.status === 'saved' && `Saved as ${diagnostics.fileName}.`}
              {diagnostics.status === 'error' && diagnostics.error}
            </span>
          </>
        }
      >
        {diagnostics.status === 'saved' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void window.mergelane.revealDiagnostics()}
          >
            <FolderOpen data-icon="inline-start" />
            Show in Finder
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={saving}
          onClick={() => void saveDiagnostics()}
        >
          <FileArchive data-icon="inline-start" />
          {saving ? 'Saving…' : 'Save Diagnostics…'}
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}
