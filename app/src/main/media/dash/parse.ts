import { DashError, malformed, unsupported } from './errors'
import { compileTemplate, fillTemplate, type TemplatePart } from './template'
import { parseXml, type XmlElement } from './xml'

// Reads a static MPD into what selection and planning need. Sources, by short name:
// - [XSD]: the MPEG DASH schema, DASH-MPD.xsd, https://github.com/MPEGGroup/DASHSchema (5th-Ed):
//   element and attribute names, types, which are required, and defaults.
// - [TM]: DASH-IF Implementation Guidelines: Restricted Timing Model,
//   https://dashif.org/Guidelines-TimingModel/ (section numbers are its own).
// - [Shaka]: Shaka Player, lib/dash/mpd_utils.js and dash_parser.js — a public implementation,
//   used where the rule lives only in ISO/IEC 23009-1, which is paywalled.
// - [RFC3986]: https://www.rfc-editor.org/rfc/rfc3986 §5.2 (relative reference resolution).

/** The MPD namespace: DASH-MPD.xsd's targetNamespace [XSD]. */
export const DASH_NS = 'urn:mpeg:dash:schema:mpd:2011'
const XLINK_HREF = '{http://www.w3.org/1999/xlink}href'
/** Role descriptor scheme whose values include "main". */
const ROLE_SCHEME = 'urn:mpeg:dash:role:2011'
/** "the DASH client shall not select any of the contained Representations for regular playout"
 * (DASH-IF identifier registry, https://dashif.org/identifiers/functionality/, from IOP v3.2
 * §3.2.9). The registry spells it with https; encoders such as FFmpeg's write http. */
const TRICK_MODE = new Set([
  'https://dashif.org/guidelines/trickmode',
  'http://dashif.org/guidelines/trickmode'
])

/** Bytes `start` through `end` of a resource, both included: HTTP's `Range: bytes=start-end`
 * (RFC 9110 §14.1.2), which is how an MPD writes them [XSD SingleRFC7233RangeType]. */
export interface ByteRange {
  start: number
  end: number
}

/** One thing to fetch: a whole resource, or a byte range of it. */
export interface SegmentRequest {
  url: string
  range?: ByteRange
}

/** A length of time as an exact decimal, `units / scale` seconds, so segment counts are worked
 * out without floating-point rounding (0.3 s × 10 is 3, not 3.0000000000000004). */
export interface ExactSeconds {
  units: bigint
  scale: bigint
}

export type ContentType = 'video' | 'audio' | 'text' | 'image' | 'other'

/** One entry of a SegmentTimeline [XSD SegmentTimelineType, TM §18.3]. */
export interface TimelineEntry {
  /** Start on the sample timeline; when absent, the previous entry's end. */
  t?: bigint
  d: bigint
  /** How many more segments of the same duration follow; negative means "up to the next
   * entry's start, or the end of the period". */
  r: bigint
}

/** How a representation's media is addressed, with inheritance and BaseURLs already resolved. */
export type Addressing =
  /** No segment information: the BaseURL is the representation's only media segment. */
  | { kind: 'single-file'; url: string }
  /** SegmentBase: one file, indexed by a sidx box inside it [TM §18.1]. */
  | {
      kind: 'segment-base'
      url: string
      /** The initialization segment, only when it is a separate resource (Initialization@sourceURL). */
      init?: SegmentRequest
      /** Where the initialization segment sits inside `url`. */
      initRange?: ByteRange
      /** Where the segment index (sidx) sits inside `url`. */
      indexRange?: ByteRange
    }
  /** SegmentList: every segment listed. */
  | { kind: 'segment-list'; init?: SegmentRequest; segments: SegmentRequest[] }
  /** SegmentTemplate: segment addresses built from a template [TM §18.3, §18.4]. */
  | {
      kind: 'segment-template'
      baseUrl: string
      init?: SegmentRequest
      media: TemplatePart[]
      timescale: bigint
      startNumber: bigint
      endNumber?: bigint
      presentationTimeOffset: bigint
      /** Simple addressing: every segment's duration, in timescale units. */
      duration?: bigint
      /** Explicit addressing; takes precedence over `duration`. */
      timeline?: TimelineEntry[]
    }

export interface Representation {
  id: string
  /** Bits per second, as the MPD declares it. */
  bandwidth: number
  width?: number
  height?: number
  codecs?: string
  mimeType?: string
  contentType: ContentType
  /** Its adaptation set's position in {@link Mpd.adaptationSets}. */
  adaptationSet: number
  /** A ContentProtection descriptor on it, its adaptation set or its period. */
  protected: boolean
  addressing: Addressing
}

export interface AdaptationSet {
  id?: string
  contentType: ContentType
  lang?: string
  /** Role values in the urn:mpeg:dash:role:2011 scheme ("main", "alternate", "commentary", …). */
  roles: string[]
  /** Higher is preferred; 1 when the MPD doesn't say [XSD: default="1"]. */
  selectionPriority: number
  /** A trick-mode set (fast-forward frames), never chosen for the programme itself. */
  trickMode: boolean
  protected: boolean
  representations: Representation[]
}

/** A parsed static MPD, reduced to its one period. */
export interface Mpd {
  /** The address the MPD was fetched from (after redirects): where relative addresses start. */
  url: string
  /** The period's length when the MPD gives it, for display and estimates. */
  durationSeconds?: number
  /** The same, exactly, for counting segments. */
  duration?: ExactSeconds
  adaptationSets: AdaptationSet[]
}

const UNSIGNED = /^\+?[0-9]+$/
const INTEGER = /^[+-]?[0-9]+$/
const BYTE_RANGE = /^([0-9]+)-([0-9]+)$/
/** xs:duration, without negative values and with whole-second-or-decimal seconds. */
const XS_DURATION =
  /^P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)(?:\.([0-9]+))?S)?)?$/
const MAX_UNSIGNED_INT = 0xffff_ffffn

/** An absolute http or https address for `reference`, resolved against `base` the way RFC 3986
 * §5.2 says (WHATWG URL implements it). Any other scheme is refused: nothing in a downloaded
 * manifest may point the downloader at a local file or a data: URL. */
export function resolveUrl(reference: string, base: string): string {
  let url: URL
  try {
    url = new URL(reference, base)
  } catch {
    throw malformed(`“${reference}” isn’t a valid address`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw unsupported(`an address that isn’t http or https (${url.protocol})`)
  }
  return url.href
}

/** Reads an xs:duration [XSD] such as "PT1H2M3.5S" exactly. Years and months have no fixed
 * length, so a non-zero one is refused; MPDs write durations in days, hours, minutes, seconds. */
export function parseDuration(raw: string, where: string): ExactSeconds {
  const value = raw.trim()
  const match = XS_DURATION.exec(value)
  if (!match || value === 'P' || value.endsWith('T')) {
    throw malformed(`${where} is “${raw}”, which isn’t a duration`)
  }
  const [, years, months, days, hours, minutes, seconds, fraction] = match
  if (BigInt(years ?? 0) !== 0n || BigInt(months ?? 0) !== 0n) {
    throw malformed(`${where} is “${raw}”, a length in years or months, which has no fixed size`)
  }
  const scale = 10n ** BigInt(fraction?.length ?? 0)
  const whole =
    ((BigInt(days ?? 0) * 24n + BigInt(hours ?? 0)) * 60n + BigInt(minutes ?? 0)) * 60n +
    BigInt(seconds ?? 0)
  return { units: whole * scale + BigInt(fraction ?? 0), scale }
}

function subtract(a: ExactSeconds, b: ExactSeconds): ExactSeconds {
  // Both scales are powers of ten, so the larger is a multiple of the smaller.
  const scale = a.scale > b.scale ? a.scale : b.scale
  return { units: a.units * (scale / a.scale) - b.units * (scale / b.scale), scale }
}

/** `element`'s attribute `name`, trimmed (the schema's numeric and range types collapse white
 * space), with how to name it in a message. */
function attribute(
  element: XmlElement | undefined,
  name: string
): { raw: string; where: string } | undefined {
  if (!element) return undefined
  const raw = element.attrs.get(name)
  return raw === undefined ? undefined : { raw: raw.trim(), where: `${element.name}@${name}` }
}

/** An xs:unsignedInt or xs:unsignedLong; `max` bounds the former. */
function unsignedAttr(
  element: XmlElement | undefined,
  name: string,
  max?: bigint
): bigint | undefined {
  const found = attribute(element, name)
  if (!found) return undefined
  if (!UNSIGNED.test(found.raw)) {
    throw malformed(`${found.where} is “${found.raw}”, which isn’t a whole number`)
  }
  const value = BigInt(found.raw)
  if (max !== undefined && value > max) {
    throw malformed(`${found.where} is ${value}, larger than DASH allows`)
  }
  return value
}

/** An xs:unsignedInt, which fits a JavaScript number exactly. */
function unsignedIntAttr(element: XmlElement | undefined, name: string): number | undefined {
  const value = unsignedAttr(element, name, MAX_UNSIGNED_INT)
  return value === undefined ? undefined : Number(value)
}

function rangeAttr(element: XmlElement | undefined, name: string): ByteRange | undefined {
  const found = attribute(element, name)
  if (!found) return undefined
  const match = BYTE_RANGE.exec(found.raw)
  const start = Number(match?.[1])
  const end = Number(match?.[2])
  // The schema also allows open ("500-") and suffix ("-500") ranges [XSD]; segment
  // addresses in practice give both ends, and a downloader needs to know the size.
  if (!match || !Number.isSafeInteger(end) || end < start) {
    throw malformed(`${found.where} is “${found.raw}”, which isn’t a byte range like 0-999`)
  }
  return { start, end }
}

function durationAttr(element: XmlElement, name: string): ExactSeconds | undefined {
  const raw = element.attrs.get(name)
  return raw === undefined ? undefined : parseDuration(raw, `${element.name}@${name}`)
}

function rejectRemote(element: XmlElement | undefined): void {
  // xlink:href on Period, AdaptationSet and SegmentList [XSD] points at content to fetch
  // and splice in. Following it would mean fetching from inside a parser; not supported.
  if (element?.attrs.has(XLINK_HREF)) {
    throw unsupported(`a remote ${element.name} (xlink:href)`)
  }
}

function contentTypeOf(value: string | undefined): ContentType | undefined {
  if (value === undefined) return undefined
  const major = value.split('/')[0].trim().toLowerCase()
  return major === 'video' || major === 'audio' || major === 'text' || major === 'image'
    ? major
    : 'other'
}

function withRange(url: string, range: ByteRange | undefined): SegmentRequest {
  return range ? { url, range } : { url }
}

interface Base {
  url: string
  /** Whether a BaseURL element named it, rather than it being the MPD's own address. */
  named: boolean
}

type SegmentKind = 'SegmentBase' | 'SegmentList' | 'SegmentTemplate'
const SEGMENT_KINDS: readonly SegmentKind[] = ['SegmentBase', 'SegmentList', 'SegmentTemplate']

/** What a Representation needs from the levels above it. */
interface Inherited {
  set: XmlElement
  period: XmlElement
  base: Base
  protected: boolean
  setContentType?: ContentType
  setIndex: number
}

class MpdReader {
  constructor(
    /** The namespace the root element is in; MPD elements are those in it. */
    private readonly ns: string
  ) {}

  /** The children of `element` named `name` in the MPD namespace. Elements in other namespaces
   * (cenc:pssh, scte35:…, vendor extensions) are someone else's and are skipped. */
  kids(element: XmlElement, name: string): XmlElement[] {
    return element.children.filter((child) => child.ns === this.ns && child.name === name)
  }

  /** The base for everything below `element`: its first BaseURL, resolved against `parent`'s.
   * Each level resolves against the one above, starting from the MPD's own address (ISO/IEC
   * 23009-1 §5.6 as quoted on vlc-devel, February 2012; [RFC3986] §5.2). Further BaseURL
   * elements are alternative locations for the same content, so the first one is used. */
  base(parent: Base, element: XmlElement): Base {
    const first = this.kids(element, 'BaseURL')[0]
    return first ? { url: resolveUrl(first.text.trim(), parent.url), named: true } : parent
  }

  /** A ContentProtection descriptor on `element` or, for a Representation, on one of its
   * SubRepresentations, which can carry one too (both are RepresentationBaseType [XSD]). */
  hasProtection(element: XmlElement): boolean {
    return (
      this.kids(element, 'ContentProtection').length > 0 ||
      this.kids(element, 'SubRepresentation').some((sub) => this.hasProtection(sub))
    )
  }

  /** The one SegmentBase, SegmentList or SegmentTemplate at this level, if any. */
  segmentInfo(element: XmlElement): { kind: SegmentKind; element: XmlElement } | undefined {
    const found = SEGMENT_KINDS.flatMap((kind) =>
      this.kids(element, kind).map((info) => ({ kind, element: info }))
    )
    // The schema's sequence admits all three [XSD]; more than one at a level is ambiguous,
    // and guessing which one the packager meant would download the wrong bytes.
    if (found.length > 1) {
      throw malformed(`<${element.name}> describes its segments more than one way`)
    }
    return found[0]
  }

  firstChild(chain: readonly XmlElement[], name: string): XmlElement | undefined {
    for (const element of chain) {
      const child = this.kids(element, name)[0]
      if (child) return child
    }
    return undefined
  }

  /** An Initialization element as a request: its sourceURL (or, without one, the base itself)
   * and its range [XSD URLType]. */
  initialization(element: XmlElement | undefined, base: Base): SegmentRequest | undefined {
    if (!element) return undefined
    const sourceURL = element.attrs.get('sourceURL')
    if (sourceURL === undefined && !base.named) {
      throw malformed('an Initialization element has no address')
    }
    return withRange(
      sourceURL === undefined ? base.url : resolveUrl(sourceURL, base.url),
      rangeAttr(element, 'range')
    )
  }

  timeline(element: XmlElement): TimelineEntry[] {
    const entries = this.kids(element, 'S').map((s) => {
      // S@n isn't used in the restricted timing model [TM §18.3]; numbers are counted from
      // startNumber. Honouring a gap in them isn't supported.
      if (s.attrs.has('n')) throw unsupported('numbered SegmentTimeline entries (S@n)')
      const d = unsignedAttr(s, 'd')
      if (d === undefined || d === 0n) {
        throw malformed('a SegmentTimeline entry has no duration (S@d)')
      }
      const rawRepeat = s.attrs.get('r')?.trim() ?? '0'
      if (!INTEGER.test(rawRepeat)) throw malformed(`S@r is “${rawRepeat}”, not a whole number`)
      return { t: unsignedAttr(s, 't'), d, r: BigInt(rawRepeat) }
    })
    if (entries.length === 0) throw malformed('a SegmentTimeline has no entries')
    return entries
  }

  addressing(
    representation: XmlElement,
    up: Inherited,
    base: Base,
    id: string,
    bandwidth: number
  ): Addressing {
    // Segment information may sit on the Period, AdaptationSet or Representation [XSD], and is
    // inherited downwards with the lowest level's attributes and children winning (ISO/IEC
    // 23009-1 §5.3.9; as implemented by Shaka's inheritAttribute and inheritChild, which walk
    // Representation → AdaptationSet → Period). The scheme is the lowest level's.
    const levels = [representation, up.set, up.period]
    const infos = levels.map((level) => this.segmentInfo(level))
    const kind = infos.find((info) => info !== undefined)?.kind
    const chain = infos.flatMap((info) => (info && info.kind === kind ? [info.element] : []))
    const attr = (name: string): XmlElement | undefined =>
      chain.find((element) => element.attrs.has(name))

    if (kind === undefined) {
      if (!base.named) throw malformed(`Representation ${id} names no media`)
      return { kind: 'single-file', url: base.url }
    }
    if (kind === 'SegmentBase') {
      // Indexed addressing: the Representation's BaseURL is the file [TM §18.1].
      if (!base.named) throw malformed(`Representation ${id} names no media`)
      const init = this.firstChild(chain, 'Initialization')
      const separate = init?.attrs.has('sourceURL') === true
      return {
        kind: 'segment-base',
        url: base.url,
        init: separate ? this.initialization(init, base) : undefined,
        initRange: separate ? undefined : rangeAttr(init, 'range'),
        indexRange: rangeAttr(attr('indexRange'), 'indexRange')
      }
    }
    if (kind === 'SegmentList') {
      chain.forEach(rejectRemote)
      const list = chain.find((element) => this.kids(element, 'SegmentURL').length > 0)
      if (!list) throw malformed(`the SegmentList for Representation ${id} lists no segments`)
      const segments = this.kids(list, 'SegmentURL').map((segment) => {
        const media = segment.attrs.get('media')
        // Without @media the segment is (a range of) the BaseURL [XSD SegmentURLType].
        if (media === undefined && !base.named) throw malformed('a SegmentURL has no address')
        return withRange(
          media === undefined ? base.url : resolveUrl(media, base.url),
          rangeAttr(segment, 'mediaRange')
        )
      })
      return {
        kind: 'segment-list',
        init: this.initialization(this.firstChild(chain, 'Initialization'), base),
        segments
      }
    }

    const mediaTemplate = attr('media')?.attrs.get('media')
    if (mediaTemplate === undefined) {
      throw malformed(`the SegmentTemplate for Representation ${id} has no media template`)
    }
    const timescale = unsignedAttr(attr('timescale'), 'timescale') ?? 1n
    if (timescale === 0n) throw malformed('SegmentTemplate@timescale is 0')
    const duration = unsignedAttr(attr('duration'), 'duration')
    if (duration === 0n) throw malformed('SegmentTemplate@duration is 0')
    const timeline = this.firstChild(chain, 'SegmentTimeline')
    const initTemplate = attr('initialization')?.attrs.get('initialization')
    return {
      kind: 'segment-template',
      baseUrl: base.url,
      // An initialization template names the representation, never a segment.
      init:
        initTemplate !== undefined
          ? {
              url: resolveUrl(
                fillTemplate(
                  compileTemplate(
                    initTemplate,
                    ['RepresentationID', 'Bandwidth'],
                    'initialization'
                  ),
                  { representationId: id, bandwidth, number: 0n, time: 0n }
                ),
                base.url
              )
            }
          : this.initialization(this.firstChild(chain, 'Initialization'), base),
      media: compileTemplate(
        mediaTemplate,
        ['RepresentationID', 'Number', 'Time', 'Bandwidth'],
        'media'
      ),
      timescale,
      // "default value 1" [TM §18.3, §18.4].
      startNumber: unsignedAttr(attr('startNumber'), 'startNumber') ?? 1n,
      endNumber: unsignedAttr(attr('endNumber'), 'endNumber'),
      // "defaults to 0" [TM §9.1].
      presentationTimeOffset:
        unsignedAttr(attr('presentationTimeOffset'), 'presentationTimeOffset') ?? 0n,
      duration,
      timeline: timeline ? this.timeline(timeline) : undefined
    }
  }

  representation(element: XmlElement, up: Inherited): Representation {
    const id = element.attrs.get('id')
    // Representation@id and @bandwidth are required [XSD RepresentationType].
    if (!id) throw malformed('a Representation has no id')
    const bandwidth = unsignedIntAttr(element, 'bandwidth')
    if (bandwidth === undefined) throw malformed(`Representation ${id} has no bandwidth`)
    // Common attributes (RepresentationBaseType [XSD]) may sit on the AdaptationSet instead.
    const own = (name: string): XmlElement => (element.attrs.has(name) ? element : up.set)
    const mimeType = own('mimeType').attrs.get('mimeType')
    const base = this.base(up.base, element)
    return {
      id,
      bandwidth,
      width: unsignedIntAttr(own('width'), 'width'),
      height: unsignedIntAttr(own('height'), 'height'),
      codecs: own('codecs').attrs.get('codecs'),
      mimeType,
      contentType: up.setContentType ?? contentTypeOf(mimeType) ?? 'other',
      adaptationSet: up.setIndex,
      protected: up.protected || this.hasProtection(element),
      addressing: this.addressing(element, up, base, id, bandwidth)
    }
  }

  adaptationSet(
    element: XmlElement,
    index: number,
    period: XmlElement,
    periodBase: Base,
    periodProtected: boolean
  ): AdaptationSet {
    rejectRemote(element)
    // contentType, else the set's mimeType, else an old-style ContentComponent [XSD].
    const setContentType =
      contentTypeOf(element.attrs.get('contentType')) ??
      contentTypeOf(element.attrs.get('mimeType')) ??
      contentTypeOf(this.kids(element, 'ContentComponent')[0]?.attrs.get('contentType'))
    const isProtected = periodProtected || this.hasProtection(element)
    const up: Inherited = {
      set: element,
      period,
      base: this.base(periodBase, element),
      protected: isProtected,
      setContentType,
      setIndex: index
    }
    const representations = this.kids(element, 'Representation').map((representation) =>
      this.representation(representation, up)
    )
    const types = new Set(representations.map((representation) => representation.contentType))
    return {
      id: element.attrs.get('id'),
      contentType: setContentType ?? (types.size === 1 ? [...types][0] : 'other'),
      lang: element.attrs.get('lang'),
      roles: this.kids(element, 'Role')
        .filter((role) => role.attrs.get('schemeIdUri') === ROLE_SCHEME)
        .map((role) => role.attrs.get('value') ?? ''),
      selectionPriority: unsignedIntAttr(element, 'selectionPriority') ?? 1,
      trickMode: this.kids(element, 'EssentialProperty').some((property) =>
        TRICK_MODE.has(property.attrs.get('schemeIdUri') ?? '')
      ),
      protected: isProtected,
      representations
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw malformed('it isn’t UTF-8 text')
  }
}

/**
 * Parses a static MPD. `source` is the manifest as text, or as bytes in UTF-8; `mpdUrl` is the
 * address it was fetched from (after redirects), which relative BaseURLs resolve against.
 *
 * Throws a {@link DashError}: 'live' for a dynamic MPD, 'multi-period' for more than one period,
 * 'unsupported' for remote (xlink) elements and other features this module doesn't handle, and
 * 'malformed' for anything that isn't a well-formed MPD. Protection is recorded here and refused
 * when a representation is chosen or planned.
 */
export function parseMpd(source: string | Uint8Array, mpdUrl: string): Mpd {
  const documentUrl = resolveUrl(mpdUrl, mpdUrl)
  const root = parseXml(typeof source === 'string' ? source : decodeUtf8(source))
  if (root.name !== 'MPD' || (root.ns !== DASH_NS && root.ns !== '')) {
    throw malformed('its root element isn’t <MPD>')
  }
  // MPD@type defaults to "static" [XSD]. A dynamic MPD's segments come and go with the clock
  // [TM §7]: there is no whole programme to download.
  const type = root.attrs.get('type') ?? 'static'
  if (type === 'dynamic') {
    throw new DashError(
      'live',
      'This is a live DASH stream. Mergelane downloads on-demand DASH streams, not live ones.'
    )
  }
  if (type !== 'static') throw malformed(`MPD@type is “${type}”`)

  const reader = new MpdReader(root.ns)
  const periods = reader.kids(root, 'Period')
  periods.forEach(rejectRemote)
  // "A period SHALL NOT have a duration of zero" and clients ignore one that does [TM §8].
  const counted = periods.filter((period) => durationAttr(period, 'duration')?.units !== 0n)
  if (counted.length === 0) throw malformed('it has no Period')
  // Joining periods would need each one's tracks matched up and their timestamps offset,
  // and they are usually ad breaks or other programmes. One period, or refuse.
  if (counted.length > 1) {
    throw new DashError(
      'multi-period',
      `This DASH stream is split into ${counted.length} periods (for example around ad breaks). Mergelane downloads single-period DASH streams only.`
    )
  }
  const period = counted[0]

  // A period lasts Period@duration, or until the presentation ends [TM §8]; the first period
  // of a static MPD starts at 0 unless Period@start says otherwise.
  const start = durationAttr(period, 'start') ?? { units: 0n, scale: 1n }
  const total = durationAttr(root, 'mediaPresentationDuration')
  const duration = durationAttr(period, 'duration') ?? (total && subtract(total, start))
  if (duration && duration.units < 0n) {
    throw malformed('its Period starts after the presentation ends')
  }

  const mpdBase = reader.base({ url: documentUrl, named: false }, root)
  const periodBase = reader.base(mpdBase, period)
  const periodProtected = reader.hasProtection(period)
  return {
    url: documentUrl,
    durationSeconds: duration && Number(duration.units) / Number(duration.scale),
    duration,
    adaptationSets: reader
      .kids(period, 'AdaptationSet')
      .map((set, index) => reader.adaptationSet(set, index, period, periodBase, periodProtected))
  }
}
