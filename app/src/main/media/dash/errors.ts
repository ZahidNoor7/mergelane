/** Why a DASH manifest can't be downloaded. Each one is a different thing to tell the user. */
export type DashErrorCode =
  /** Not XML, not an MPD, or an MPD with a value its schema doesn't allow. */
  | 'malformed'
  /** `MPD@type="dynamic"`: a live stream, whose segments come and go with the clock. */
  | 'live'
  /** A ContentProtection descriptor: the stream is DRM-protected, and Mergelane doesn't download it. */
  | 'protected'
  /** More than one Period (ad breaks, chapters, joined programmes). */
  | 'multi-period'
  /** More media segments than {@link MAX_SEGMENTS}. */
  | 'too-many-segments'
  /** The segment list depends on a duration the MPD doesn't give. */
  | 'missing-duration'
  /** Valid DASH that this module doesn't handle (remote xlink elements, $SubNumber$, …). */
  | 'unsupported'
  /** Nothing in the MPD matches what was asked for (no video, an unknown representation id). */
  | 'no-match'

/** The most media segments one representation may have. Far above any on-demand programme
 * (20,000 two-second segments is 11 hours), and a ceiling on what a hostile MPD can make us list. */
export const MAX_SEGMENTS = 20_000

/** A DASH manifest that can't be downloaded, with a message fit to show the user as is. */
export class DashError extends Error {
  constructor(
    readonly code: DashErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DashError'
  }
}

/** The MPD isn't one this module can read; `detail` says where. */
export function malformed(detail: string): DashError {
  return new DashError('malformed', `This isn’t a DASH manifest Mergelane can read: ${detail}.`)
}

/** Valid DASH that uses `feature`, which this module doesn't handle. */
export function unsupported(feature: string): DashError {
  return new DashError(
    'unsupported',
    `This DASH stream uses ${feature}, which Mergelane doesn’t support yet.`
  )
}

/** Protected content is never downloaded (CLAUDE.md: no DRM circumvention). */
export function protectedStream(): DashError {
  return new DashError(
    'protected',
    'This stream is protected with DRM. Mergelane doesn’t download protected streams.'
  )
}

export function tooManySegments(): DashError {
  return new DashError(
    'too-many-segments',
    `This stream has more than ${MAX_SEGMENTS.toLocaleString('en-US')} segments, more than Mergelane downloads from one stream.`
  )
}

export function missingDuration(): DashError {
  return new DashError(
    'missing-duration',
    'This DASH stream doesn’t say how long it is, so Mergelane can’t work out its segments.'
  )
}
