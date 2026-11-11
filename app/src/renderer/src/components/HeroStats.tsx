// The separator between figures on a download's screen. (The hero's big figure is now the
// Confluence's, components/Confluence.tsx.)

/** Inline "·" separator between adjacent stats. `shrink` pins it at its natural width inside a
 * flex row that might otherwise squeeze it (footer rows), matching each call site's prior style. */
export function Dot(): React.JSX.Element {
  return <span className="opacity-35">·</span>
}
