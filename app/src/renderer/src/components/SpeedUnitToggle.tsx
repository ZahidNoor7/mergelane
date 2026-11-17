import { SPEED_UNIT_LABELS, SPEED_UNITS } from '@shared/speedText'
import type { SpeedUnit } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** KB/s, MB/s or Mbps for every speed in the app (the design's three, ADR-0071): a segmented control, in
 * Settings › General. */
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
      {SPEED_UNITS.map((unit) => (
        <ToggleGroupItem key={unit} value={unit}>
          {SPEED_UNIT_LABELS[unit]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
