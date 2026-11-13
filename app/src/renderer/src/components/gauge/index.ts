// Gauge UI (MIT, github.com/thordursk/gauge-ui), the parts Mergelane's speed test uses, copied
// unchanged from commit bdd0c857a112d5e8b9921b7ee03075dc78be7cb9 except gauge.tsx's `cn` import
// (Mergelane uses the `cn` package, not `@/lib/utils`). Upstream's index.ts exports every part;
// this one exports only the files copied (ADR-0064, docs/UPSTREAM.md).
export { Gauge, type GaugeFit, type GaugeProps } from "./gauge"
export {
  useGauge,
  type GaugeContextValue,
  type GaugeDomainProps,
  type GaugeRange,
} from "./context"
export {
  GaugeTrack,
  GaugeArc,
  GaugeZones,
  type GaugeArcProps,
  type GaugeZonesProps,
} from "./arcs"
export {
  DEFAULT_TRANSITION,
  type GaugeSpringTransition,
  type GaugeTransition,
} from "./transition"
