// The hero band's figures, shared by a download's screen and the dashboard.

/** Inline "·" separator between adjacent stats. `shrink` pins it at its natural width inside a
 * flex row that might otherwise squeeze it (footer rows), matching each call site's prior style. */
export function Dot(): React.JSX.Element {
  return <span className="opacity-35">·</span>
}

export function InlineStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span>
      {label} <span className="font-semibold text-foreground">{value}</span>
    </span>
  )
}

/** The hero band's headline figure: a tracked-out label over one big tabular number and its unit. */
export function BigStat({
  label,
  value,
  unit,
  valueClass,
  note
}: {
  label: string
  value: string | number
  unit?: string
  valueClass: string
  /** Beside the label, e.g. a warning about what holds the value down. */
  note?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.2em] text-muted-foreground">
        {label}
        {note}
      </div>
      <div className="flex items-baseline gap-[7px]">
        <div
          className={`font-mono text-[38px] leading-[0.88] font-semibold tracking-[-0.03em] tabular-nums ${valueClass}`}
        >
          {value}
        </div>
        {unit && (
          <div className="font-mono text-[12px] leading-none font-medium text-muted-foreground">
            {unit}
          </div>
        )}
      </div>
    </>
  )
}
