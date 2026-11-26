import { ShieldCheck } from 'lucide-react'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Badge } from './ui/badge'

// Settings › Downloads › "If something goes wrong" (the design's SafetySettings; docs/plans/
// 2026-11-new-features-plan.md, features 5 and 6). Saving progress can't be turned off: it is
// what makes a crash cost seconds rather than the download.

export function SafetySettings(): React.JSX.Element {
  return (
    <SettingsGroup
      title="If something goes wrong"
      description="Downloads survive crashes, power cuts and links that stop working."
    >
      <SettingRow
        label="Save progress every 2 seconds"
        hint="Each chunk is written and its place in the file recorded together. After a crash, a force quit or a power cut, downloads resume from the last save."
      >
        <Badge>
          <ShieldCheck aria-hidden />
          Always on
        </Badge>
      </SettingRow>
    </SettingsGroup>
  )
}
