import type { SpeedUnit } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** MB/s or Mbps for every speed in the app: a segmented control. It moves to Settings › General
 * with the Settings screen (M3.1 pull request 5e). */
export function SpeedUnitToggle(): React.JSX.Element {
  const speedUnit = useAppStore((store) => store.speedUnit)
  const setSpeedUnit = useAppStore((store) => store.setSpeedUnit)
  return (
    <ToggleGroup
      aria-label="Speed units"
      value={[speedUnit]}
      onValueChange={(values) => {
        if (values[0] !== undefined) setSpeedUnit(values[0] as SpeedUnit)
      }}
      size="xs"
      spacing={0.5}
    >
      {(['bytes', 'bits'] as const).map((unit) => (
        <ToggleGroupItem key={unit} value={unit}>
          {unit === 'bytes' ? 'MB/s' : 'Mbps'}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
