import {
  malformed,
  MAX_SEGMENTS,
  missingDuration,
  protectedStream,
  tooManySegments
} from './errors'
import {
  resolveUrl,
  type Addressing,
  type ByteRange,
  type Mpd,
  type Representation,
  type SegmentRequest
} from './parse'
import type { Selection } from './select'
import { fillTemplate, usesIdentifier } from './template'

// Turns a representation into the requests a segment downloader makes. Timing rules are from
// the DASH-IF Restricted Timing Model, https://dashif.org/Guidelines-TimingModel/ ([TM]); where
// it is silent, from Shaka Player's lib/dash/mpd_utils.js createTimeline ([Shaka]).

/** Everything to fetch for one representation. */
export interface TrackPlan {
  representationId: string
  /** The initialization segment, when it is fetched on its own. */
  init?: SegmentRequest
  /** The media segments, in presentation order. */
  media: SegmentRequest[]
  /** `init` and then `media`: the requests in the order their bytes are joined into the track. */
  requests: SegmentRequest[]
  /** SegmentBase: where the initialization segment and the segment index (sidx) sit inside the
   * single file. The plan fetches the whole file; these let a later step split it by the sidx. */
  initRange?: ByteRange
  indexRange?: ByteRange
}

/** One media segment of a template: its $Number$ and its $Time$. */
interface Point {
  number: bigint
  time: bigint
}

type TemplateAddressing = Extract<Addressing, { kind: 'segment-template' }>

/** a ÷ b rounded up, for b > 0. BigInt division truncates toward zero. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return a <= 0n ? -(-a / b) : (a + b - 1n) / b
}

function checkCount(count: bigint): void {
  if (count > BigInt(MAX_SEGMENTS)) throw tooManySegments()
}

/** How many numbers endNumber leaves from `first` on, if it is set. */
function numbersLeft(template: TemplateAddressing, first: bigint): bigint | undefined {
  if (template.endNumber === undefined) return undefined
  const left = template.endNumber - first + 1n
  return left > 0n ? left : 0n
}

/**
 * Simple addressing [TM §18.4]: segments of SegmentTemplate@duration back to back from the
 * period start, "SegmentCount = Ceil(period duration ÷ segment duration)" (§18.4.3; the
 * @eptDelta term isn't supported). On the sample timeline segment k starts at
 * presentationTimeOffset + k × duration (§9.1's conversion with §18.4's equal time spans).
 */
function simplePoints(mpd: Mpd, template: TemplateAddressing, duration: bigint): Point[] {
  if (!mpd.duration) throw missingDuration()
  const { units, scale } = mpd.duration
  let count = ceilDiv(units * template.timescale, scale * duration)
  const left = numbersLeft(template, template.startNumber)
  if (left !== undefined && left < count) count = left
  checkCount(count)
  const points: Point[] = []
  for (let k = 0n; k < count; k++) {
    points.push({
      number: template.startNumber + k,
      time: template.presentationTimeOffset + k * duration
    })
  }
  return points
}

/**
 * Explicit addressing [TM §18.3]: each S is a segment of S@d starting at S@t, followed by S@r
 * more of the same duration. Without S@t a segment starts where the previous one ended; the
 * first S without S@t starts at 0 [Shaka]. A negative S@r repeats up to the next S's start or,
 * on the last S, to the end of the period: ceil((end − t) ÷ d) segments [Shaka], with the
 * period's end on the sample timeline at presentationTimeOffset + duration × timescale [TM §9.1].
 * Numbers run on from SegmentTemplate@startNumber [TM §18.3].
 */
function timelinePoints(
  mpd: Mpd,
  template: TemplateAddressing,
  timeline: NonNullable<TemplateAddressing['timeline']>
): Point[] {
  const points: Point[] = []
  let next = 0n
  for (let index = 0; index < timeline.length; index++) {
    const { t = next, d, r } = timeline[index]
    let count: bigint
    if (r >= 0n) {
      count = r + 1n
    } else if (index + 1 < timeline.length) {
      const following = timeline[index + 1].t
      if (following === undefined) {
        throw malformed('a SegmentTimeline entry repeats up to the next one, which has no S@t')
      }
      count = ceilDiv(following - t, d)
    } else {
      if (!mpd.duration) throw missingDuration()
      const { units, scale } = mpd.duration
      const end = template.presentationTimeOffset * scale + units * template.timescale
      count = ceilDiv(end - t * scale, d * scale)
    }
    const first = template.startNumber + BigInt(points.length)
    const left = numbersLeft(template, first)
    if (left !== undefined && left < count) count = left
    if (count < 0n) count = 0n
    checkCount(BigInt(points.length) + count)
    for (let k = 0n; k < count; k++) points.push({ number: first + k, time: t + k * d })
    next = t + count * d
  }
  return points
}

function templateSegments(
  mpd: Mpd,
  representation: Representation,
  template: TemplateAddressing
): SegmentRequest[] {
  const points = template.timeline
    ? timelinePoints(mpd, template, template.timeline)
    : template.duration !== undefined
      ? simplePoints(mpd, template, template.duration)
      : // Neither: one segment as long as the period. dash.js quotes the rule from ISO/IEC
        // 23009-1 ("If neither @duration attribute nor SegmentTimeline element is present, then
        // the Representation shall contain …") and uses the period's duration as the segment's
        // (src/dash/utils/SegmentsUtils.js).
        [{ number: template.startNumber, time: template.presentationTimeOffset }]
  if (points.length === 0) throw malformed('its segment template lists no segments')
  // "Either the $Time$ or $Number$ template variable SHALL be present" [TM §18.3]: without
  // one every segment would have the same address.
  if (
    points.length > 1 &&
    !usesIdentifier(template.media, 'Number') &&
    !usesIdentifier(template.media, 'Time')
  ) {
    throw malformed('its media template has neither $Number$ nor $Time$')
  }
  return points.map((point) => ({
    url: resolveUrl(
      fillTemplate(template.media, {
        representationId: representation.id,
        bandwidth: representation.bandwidth,
        number: point.number,
        time: point.time
      }),
      template.baseUrl
    )
  }))
}

function trackPlan(
  representation: Representation,
  init: SegmentRequest | undefined,
  media: SegmentRequest[]
): TrackPlan {
  return {
    representationId: representation.id,
    init,
    media,
    requests: init ? [init, ...media] : [...media]
  }
}

/**
 * The requests that fetch `representation`, in order: the initialization segment (when it is
 * separate) and then every media segment. Joined in that order, the responses are the track.
 *
 * - SegmentTemplate: one request per segment, the template filled in for each.
 * - SegmentList: the listed segments, with their byte ranges.
 * - SegmentBase, or no segment information: one request for the whole file (the init segment
 *   and index are inside it; their ranges are returned for reference).
 *
 * Throws a {@link DashError}: 'protected' for a protected representation, 'too-many-segments'
 * past {@link MAX_SEGMENTS}, 'missing-duration' when counting the segments needs a duration the
 * MPD doesn't give, and 'malformed' for a template that can't tell its segments apart.
 */
export function planRepresentation(mpd: Mpd, representation: Representation): TrackPlan {
  // Checked again here, whoever chose the representation.
  if (representation.protected) throw protectedStream()
  const addressing = representation.addressing
  switch (addressing.kind) {
    case 'single-file':
      return trackPlan(representation, undefined, [{ url: addressing.url }])
    case 'segment-base':
      return {
        ...trackPlan(representation, addressing.init, [{ url: addressing.url }]),
        initRange: addressing.initRange,
        indexRange: addressing.indexRange
      }
    case 'segment-list':
      checkCount(BigInt(addressing.segments.length))
      return trackPlan(representation, addressing.init, addressing.segments)
    case 'segment-template':
      return trackPlan(
        representation,
        addressing.init,
        templateSegments(mpd, representation, addressing)
      )
  }
}

/** {@link planRepresentation} for each representation of a {@link Selection}. */
export function planSelection(
  mpd: Mpd,
  selection: Selection
): { video?: TrackPlan; audio?: TrackPlan } {
  return {
    video: selection.video && planRepresentation(mpd, selection.video),
    audio: selection.audio && planRepresentation(mpd, selection.audio)
  }
}
