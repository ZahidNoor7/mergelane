import { ShieldCheck } from 'lucide-react'
import { useId } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Badge } from './ui/badge'
import { Switch } from './ui/switch'

// Settings › Downloads › "If something goes wrong" (the design's SafetySettings; docs/plans/
// 2026-11-new-features-plan.md, features 5 and 6). Saving progress can't be turned off: it is
// what makes a crash cost seconds rather than the download.

export function SafetySettings(): React.JSX.Element {
  const catchFreshLinks = useAppStore((store) => store.catchFreshLinks)
  const setCatchFreshLinks = useAppStore((store) => store.setCatchFreshLinks)
  const freshId = useId()
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
      <SettingRow
        label="Pick up fresh links from the browser"
        htmlFor={freshId}
        hint="When a link expires, click the same download again in a browser with the extension. Mergelane continues the stopped download instead of starting over."
      >
        <Switch id={freshId} checked={catchFreshLinks} onCheckedChange={setCatchFreshLinks} />
      </SettingRow>
    </SettingsGroup>
  )
}
