/** The containers this module writes. */
export type Container = 'mp4' | 'mkv'

/** How one codec fits the MP4 container. */
type Fit = 'mp4' | 'mkv' | 'ignore'

/**
 * Codec identifiers as manifests write them, keyed by their first dot-separated element: RFC 6381
 * §3.3 says that element "is a sample description entry four-character code", as HLS CODECS and
 * DASH `@codecs` use, plus the plain names WebM DASH manifests use (`vp8`, `vp9`, `opus`, `vorbis`).
 *
 * 'mp4' means two things hold: the sample entry is registered for ISO BMFF at mp4ra.org
 * (registered-types/codecs: avc1, avc3, hvc1, hev1, av01, vp09, mp4a, Opus, fLaC, ac-3, ec-3), and
 * FFmpeg's mp4 muxer accepted a stream copy of it (checked with FFmpeg 8.1.2 for h264, hevc, av1,
 * vp9 × aac, mp3, opus, flac, ac3, eac3).
 *
 * 'mkv' marks codecs MP4 can't usefully hold: VP8 (registered as vp08, but FFmpeg's mp4 muxer
 * refuses it: "Could not find tag for codec vp8 … codec not currently supported in container"),
 * and Vorbis and Theora (no ISO BMFF registration; FFmpeg writes Vorbis into MP4 only under a
 * private object type that MP4 players don't read).
 *
 * 'ignore' is for subtitle formats (wvtt, stpp): they appear in CODECS lists but the muxer never
 * maps subtitle streams, so they don't constrain the container.
 */
const FOURCC: Readonly<Record<string, Fit>> = {
  avc1: 'mp4',
  avc3: 'mp4',
  hvc1: 'mp4',
  hev1: 'mp4',
  av01: 'mp4',
  vp09: 'mp4',
  vp9: 'mp4',
  opus: 'mp4',
  flac: 'mp4',
  'ac-3': 'mp4',
  'ec-3': 'mp4',
  vp08: 'mkv',
  vp8: 'mkv',
  vorbis: 'mkv',
  theora: 'mkv',
  wvtt: 'ignore',
  stpp: 'ignore'
}

/** `mp4a.<OTI>` object type indications (hex) that MP4 holds, from mp4ra.org
 * registered-types/object-types: 40 MPEG-4 Audio (AAC and the rest of ISO/IEC 14496-3), 66–68
 * MPEG-2 AAC, 69 MPEG-2 Audio (MP3), 6B MPEG-1 Audio (MP3), AD Opus. Others (A5/A6 are withdrawn,
 * C0–E0 are user private, e.g. DD for Vorbis) are not trusted. */
const MP4A_OTI = new Set(['40', '66', '67', '68', '69', '6b', 'ad'])

function fit(codec: string): Fit | undefined {
  const [fourcc, oti] = codec.toLowerCase().split('.')
  if (fourcc === 'mp4a') return oti !== undefined && MP4A_OTI.has(oti) ? 'mp4' : undefined
  return Object.hasOwn(FOURCC, fourcc) ? FOURCC[fourcc] : undefined
}

/**
 * The container for `'auto'`: MP4 when every codec is one MP4 holds, Matroska otherwise.
 *
 * Decided from the codecs the manifest already declares (HLS CODECS, DASH `@codecs`) rather than by
 * probing the files, so it needs no extra FFmpeg run and no parsing of FFmpeg's human-oriented
 * stderr, and the file extension is known before FFmpeg starts. An unknown codec, or none given,
 * picks Matroska: it holds every codec listed above, so the guess can't fail the mux. Items may
 * themselves be comma-separated lists, as in `["mp4a.40.2,avc1.4d401e"]`. Matching ignores case
 * (RFC 6381 values are case-sensitive, but `Opus` and `opus` name the same codec, and a container
 * choice is not a codec negotiation).
 */
export function containerForCodecs(codecs: readonly string[] | undefined): Container {
  const list = (codecs ?? [])
    .flatMap((item) => item.split(','))
    .map((codec) => codec.trim())
    .filter((codec) => codec !== '')
  const fits = list.map(fit).filter((value) => value !== 'ignore')
  if (fits.length === 0) return 'mkv'
  return fits.every((value) => value === 'mp4') ? 'mp4' : 'mkv'
}
