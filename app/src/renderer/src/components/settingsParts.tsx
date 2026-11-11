// The parts every Settings section is built from, as the final design draws them
// (design-system/mergelane/redesign/prototype.html, SettingsGroup and SettingRow).

export function SettingsGroup({
  title,
  description,
  aside,
  children
}: {
  title?: string
  description?: string
  /** A control beside the title (the design's "Scan again"). */
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      {title && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5 px-1">
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
            <h3 className="text-[13.5px] font-[650] tracking-[-0.005em]">{title}</h3>
            {description && (
              <p className="max-w-[64ch] text-[12.5px] leading-[1.5] text-ink-2">{description}</p>
            )}
          </div>
          {aside}
        </div>
      )}
      <div className="flex flex-col rounded-[14px] bg-card px-4 shadow-[inset_0_0_0_1px_var(--border)]">
        {children}
      </div>
    </section>
  )
}

export function SettingRow({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint?: React.ReactNode
  htmlFor?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const Label = htmlFor ? 'label' : 'span'
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-rule py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <Label htmlFor={htmlFor} className="text-[13.5px] font-[600]">
          {label}
        </Label>
        {hint && <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">{hint}</p>}
      </div>
      {children && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  )
}
