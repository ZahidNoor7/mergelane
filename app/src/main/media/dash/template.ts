import { malformed, unsupported } from './errors'

// SegmentTemplate URL templates: ISO/IEC 23009-1 §5.3.9.4.4 and its Table 16 (the clause Shaka
// Player's fillUriTemplate cites). The standard is paywalled, so the rules here rest on public
// sources that restate it:
// - the identifiers are $$, $RepresentationID$, $Number$, $Bandwidth$ and $Time$ (3GPP TS 26.247
//   §8.4.4, which lists Table 16's identifiers, and the Shaka Packager "Segment template
//   formatting" page, https://shaka-project.github.io/shaka-packager/html/options/segment_template_formatting.html);
// - "$$" stands for one "$" (Shaka Packager page; Shaka Player lib/dash/mpd_utils.js);
// - a format tag has the printf form %0[width]d; without one the width is 1; a longer value is
//   not truncated (Shaka Packager page);
// - $RepresentationID$ takes no format tag (FFmpeg libavformat/dashenc.c, citing §5.3.9.4.4;
//   Shaka Player ignores one with a warning);
// - $Number$ and $Time$ are what tell segments apart (DASH-IF Restricted Timing Model §18.3,
//   https://dashif.org/Guidelines-TimingModel/).
// Identifiers are case-sensitive (Shaka Packager page). $SubNumber$ (a later amendment) isn't
// supported, and anything else between dollars is refused rather than passed through.

export type TemplateIdentifier = 'RepresentationID' | 'Number' | 'Time' | 'Bandwidth'

/** A compiled template: literal text and the identifiers to fill in, in order. */
export type TemplatePart = string | { id: TemplateIdentifier; width: number }

/** The values a template is filled with. */
export interface TemplateValues {
  representationId: string
  bandwidth: number
  number: bigint
  time: bigint
}

const IDENTIFIER = /^(RepresentationID|Number|Time|Bandwidth|SubNumber)(%.*)?$/
const FORMAT_TAG = /^%0([0-9]{1,2})d$/

/**
 * Checks `template` and splits it into literal text and identifiers. `allowed` is what this use
 * of a template may contain: an initialization template can't name a segment's number or time.
 * `what` names the template in error messages ("media", "initialization").
 */
export function compileTemplate(
  template: string,
  allowed: readonly TemplateIdentifier[],
  what: string
): TemplatePart[] {
  const parts: TemplatePart[] = []
  let literal = ''
  let at = 0
  while (at < template.length) {
    const open = template.indexOf('$', at)
    if (open === -1) {
      literal += template.slice(at)
      break
    }
    literal += template.slice(at, open)
    const close = template.indexOf('$', open + 1)
    if (close === -1) {
      throw malformed(`the ${what} template “${template}” has a “$” with no closing “$”`)
    }
    const inner = template.slice(open + 1, close)
    at = close + 1
    if (inner === '') {
      literal += '$'
      continue
    }
    const match = IDENTIFIER.exec(inner)
    if (!match) throw malformed(`the ${what} template “${template}” uses an unknown $${inner}$`)
    const name = match[1]
    if (name === 'SubNumber') throw unsupported('the $SubNumber$ template identifier')
    const id = name as TemplateIdentifier
    if (!allowed.includes(id))
      throw malformed(`the ${what} template “${template}” can’t use $${id}$`)
    let width = 1
    if (match[2] !== undefined) {
      const format = FORMAT_TAG.exec(match[2])
      if (!format || id === 'RepresentationID') {
        throw malformed(`the ${what} template “${template}” has a format tag DASH doesn’t allow`)
      }
      width = Number(format[1])
    }
    if (literal) parts.push(literal)
    literal = ''
    parts.push({ id, width })
  }
  if (literal) parts.push(literal)
  return parts
}

/** Whether a compiled template names `id`. */
export function usesIdentifier(parts: readonly TemplatePart[], id: TemplateIdentifier): boolean {
  return parts.some((part) => typeof part !== 'string' && part.id === id)
}

/** The template with every identifier replaced; numbers zero-padded to their width. */
export function fillTemplate(parts: readonly TemplatePart[], values: TemplateValues): string {
  let out = ''
  for (const part of parts) {
    if (typeof part === 'string') out += part
    else if (part.id === 'RepresentationID') out += values.representationId
    else {
      const value =
        part.id === 'Number' ? values.number : part.id === 'Time' ? values.time : values.bandwidth
      out += String(value).padStart(part.width, '0')
    }
  }
  return out
}
