/**
 * MPEG-DASH: from a static MPD to the requests that download one video and one audio track.
 *
 * ```ts
 * const mpd = parseMpd(text, finalUrl)              // refuses live, multi-period, malformed MPDs
 * const qualities = listVideoQualities(mpd)         // for a quality picker, best first
 * const choice = selectRepresentations(mpd, { height: 1080 })  // refuses protected streams
 * const { video, audio } = planSelection(mpd, choice)
 * // video.requests: [{ url, range? }, …], the init segment first, then the media segments
 * ```
 *
 * Every refusal is a {@link DashError} whose `code` says why and whose `message` can be shown to
 * the user as is. Protected (DRM) content is never planned: a ContentProtection descriptor on
 * the period, adaptation set or representation makes it unavailable (CLAUDE.md, Legal).
 *
 * Not supported: live (dynamic) MPDs, more than one period, remote (xlink) elements, $SubNumber$,
 * S@n, SegmentTemplate@eptDelta, open-ended byte ranges, and text tracks. Segments are planned,
 * not fetched; the SegmentBase index (sidx) is not read.
 *
 * @module
 */

export { DashError, MAX_SEGMENTS, type DashErrorCode } from './errors'
export {
  DASH_NS,
  parseMpd,
  type AdaptationSet,
  type Addressing,
  type ByteRange,
  type ContentType,
  type ExactSeconds,
  type Mpd,
  type Representation,
  type SegmentRequest,
  type TimelineEntry
} from './parse'
export {
  listVideoQualities,
  selectRepresentations,
  type Selection,
  type SelectOptions,
  type VideoQuality
} from './select'
export { planRepresentation, planSelection, type TrackPlan } from './plan'
