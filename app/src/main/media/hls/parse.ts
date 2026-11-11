// Logic adapted from Awesome Downloader core/hls.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane: a full attribute-list parser, byte ranges, init-section
// byte ranges, rendition metadata and spec-section checks were added; see docs/UPSTREAM.md.
//
// Playlist semantics follow RFC 8216 (HTTP Live Streaming), https://www.rfc-editor.org/rfc/rfc8216.
// Section numbers in comments refer to it.

import {
  HlsLimitError,
  HlsLiveStreamError,
  HlsPlaylistError,
  HlsProtectedStreamError,
  HlsUnsupportedError
} from './errors'

/** More segments than this in one Media Playlist is refused: it bounds memory, request count and
 * the resume record, and no ordinary on-demand video comes close (20,000 six-second segments is
 * more than 33 hours). */
export const MAX_SEGMENTS = 20_000

/** A sub-range of a resource, in bytes (§4.3.2.2). `offset` is always resolved: an offset-less
 * EXT-X-BYTERANGE has been turned into the absolute position it implies. */
export interface ByteRange {
  offset: number
  length: number
}

/** The Media Initialization Section that applies to a segment (§4.3.2.5, EXT-X-MAP). */
export interface InitSection {
  uri: string
  byteRange?: ByteRange
}

/** One Media Segment of a Media Playlist (§3, §4.3.2). */
export interface MediaSegment {
  /** Position in the playlist, from 0. */
  index: number
  /** Media Sequence Number (§4.3.3.2): EXT-X-MEDIA-SEQUENCE (or 0) plus the position. */
  sequence: number
  /** Absolute URL, resolved against the playlist's URL (§4.1). */
  uri: string
  /** EXTINF duration in seconds (§4.3.2.1). */
  duration: number
  /** EXTINF's optional human-readable title. */
  title?: string
  /** Present when the segment is only part of its resource (EXT-X-BYTERANGE, §4.3.2.2). */
  byteRange?: ByteRange
  /** The EXT-X-MAP in effect for this segment, if any (§4.3.2.5). */
  init?: InitSection
  /** An EXT-X-DISCONTINUITY precedes this segment (§4.3.2.3). */
  discontinuity: boolean
}

/** A Media Playlist: the list of segments of one Rendition (§4.1). */
export interface MediaPlaylist {
  kind: 'media'
  /** The URL relative URIs were resolved against (the final URL after redirects, if fetched). */
  url: string
  /** EXT-X-VERSION (§4.3.1.2), when present. */
  version?: number
  /** EXT-X-TARGETDURATION in seconds (§4.3.3.1). */
  targetDuration: number
  /** EXT-X-MEDIA-SEQUENCE (§4.3.3.2); 0 when absent. */
  mediaSequence: number
  /** EXT-X-PLAYLIST-TYPE (§4.3.3.5), when present and recognised. */
  playlistType?: 'VOD' | 'EVENT'
  /** EXT-X-ENDLIST is present: no more segments will be added (§4.3.3.4). */
  endList: boolean
  /** EXT-X-I-FRAMES-ONLY is present (§4.3.3.6). */
  iFramesOnly: boolean
  segments: MediaSegment[]
  /** Sum of the segments' durations, in seconds (§4.1). */
  duration: number
}

/** A Variant Stream from EXT-X-STREAM-INF (§4.3.4.2). */
export interface Variant {
  /** Stable within one master playlist: "v" plus the variant's position in it. Positions survive
   * re-fetching a master whose URLs carry fresh tokens, which URL-based ids would not. */
  id: string
  /** Absolute URL of the variant's Media Playlist. */
  uri: string
  /** Peak segment bit rate, bits per second (REQUIRED). */
  bandwidth: number
  /** Average segment bit rate, bits per second. */
  averageBandwidth?: number
  /** Formats from CODECS (RFC 6381 identifiers), in playlist order. */
  codecs?: string[]
  resolution?: { width: number; height: number }
  frameRate?: number
  /** HDCP-LEVEL as written (e.g. "TYPE-0" or "NONE"). */
  hdcpLevel?: string
  /** GROUP-ID of the audio renditions to play with it (AUDIO attribute). */
  audioGroup?: string
  videoGroup?: string
  subtitlesGroup?: string
}

/** A Rendition from EXT-X-MEDIA (§4.3.4.1). */
export interface Rendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS'
  groupId: string
  name: string
  language?: string
  /** Absolute URL of its Media Playlist. Absent for an AUDIO or VIDEO rendition whose media is
   * inside the variant's own segments (§4.3.4.2.1). */
  uri?: string
  default: boolean
  autoselect: boolean
  channels?: string
}

/** A Master Playlist: the Variant Streams and Renditions of a presentation (§4.1, §4.3.4). */
export interface MasterPlaylist {
  kind: 'master'
  url: string
  version?: number
  /** Variant streams in playlist order. */
  variants: Variant[]
  renditions: Rendition[]
}

export type HlsPlaylist = MasterPlaylist | MediaPlaylist

/** §4.3.4: Master Playlist tags. */
const MASTER_TAGS = new Set([
  'EXT-X-MEDIA',
  'EXT-X-STREAM-INF',
  'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-SESSION-DATA',
  'EXT-X-SESSION-KEY'
])

/** §4.3.3: Media Playlist tags. Each may appear at most once. */
const MEDIA_PLAYLIST_TAGS = new Set([
  'EXT-X-TARGETDURATION',
  'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE',
  'EXT-X-ENDLIST',
  'EXT-X-PLAYLIST-TYPE',
  'EXT-X-I-FRAMES-ONLY'
])

/** §4.3.2: Media Segment tags. */
const SEGMENT_TAGS = new Set([
  'EXTINF',
  'EXT-X-BYTERANGE',
  'EXT-X-DISCONTINUITY',
  'EXT-X-KEY',
  'EXT-X-MAP',
  'EXT-X-PROGRAM-DATE-TIME',
  'EXT-X-DATERANGE'
])

/** Tags a playlist must not repeat: EXT-X-VERSION (§4.3.1.2) and the Media or Master Playlist
 * tags (§4.3.5). */
const ONCE_TAGS = new Set(['EXT-X-VERSION', 'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START'])

interface Line {
  /** 1-based line number, for error messages. */
  number: number
  /** A URI line (§4.1). */
  uri?: string
  /** Tag name without '#', e.g. "EXT-X-MAP" (§4.1: tags begin with #EXT). */
  tag?: string
  /** What follows the tag's ':'. */
  value: string
}

/**
 * Parses an attribute-list (§4.2): comma-separated AttributeName=AttributeValue pairs, where a
 * quoted-string value may itself contain commas (as in CODECS="mp4a.40.2,avc1.4d401e").
 *
 * Quoted values are returned without their quotes; other values as written. Names must match
 * [A-Z0-9-]+ and must not repeat (§4.2: "Clients SHOULD refuse to parse such Playlists").
 * Deliberately lenient about whitespace between pairs, which §4.1 forbids but real servers emit.
 */
export function parseAttributeList(input: string, line?: number): Map<string, string> {
  const attributes = new Map<string, string>()
  let position = 0
  const skipSpaces = (): void => {
    while (input[position] === ' ' || input[position] === '\t') position++
  }
  while (true) {
    skipSpaces()
    if (position >= input.length) break
    const equals = input.indexOf('=', position)
    if (equals < 0) {
      throw new HlsPlaylistError(`attribute "${input.slice(position)}" has no value`, line)
    }
    const name = input.slice(position, equals)
    if (!/^[A-Z0-9-]+$/.test(name)) {
      throw new HlsPlaylistError(`"${name}" is not a valid attribute name (§4.2)`, line)
    }
    position = equals + 1
    let value: string
    if (input[position] === '"') {
      // §4.2 quoted-string: everything up to the next double quote, which cannot occur inside.
      const close = input.indexOf('"', position + 1)
      if (close < 0) throw new HlsPlaylistError(`attribute ${name} has an unclosed quote`, line)
      value = input.slice(position + 1, close)
      position = close + 1
    } else {
      const comma = input.indexOf(',', position)
      const end = comma < 0 ? input.length : comma
      value = input.slice(position, end).trim()
      position = end
    }
    if (attributes.has(name)) {
      throw new HlsPlaylistError(`attribute ${name} appears twice in one tag (§4.2)`, line)
    }
    attributes.set(name, value)
    skipSpaces()
    if (position < input.length) {
      if (input[position] !== ',') {
        throw new HlsPlaylistError(`unexpected text after attribute ${name}`, line)
      }
      position++
    }
  }
  return attributes
}

/** §4.2 decimal-integer, limited to what a JavaScript number holds exactly. */
function decimalInteger(value: string, what: string, line: number): number {
  const parsed = /^\d{1,20}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) {
    throw new HlsPlaylistError(`${what} "${value}" is not a whole number`, line)
  }
  return parsed
}

/** §4.2 decimal-floating-point (a decimal-integer is accepted too, per §4.3.2.1). */
function decimalFloat(value: string, what: string, line: number): number {
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) {
    throw new HlsPlaylistError(`${what} "${value}" is not a number`, line)
  }
  return Number(value)
}

/** §4.3.2.2 `<n>[@<o>]`, with the offset left undefined when absent. */
function byteRangeSpec(value: string, line: number): { length: number; offset?: number } {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value)
  if (!match) throw new HlsPlaylistError(`byte range "${value}" is not of the form n[@o]`, line)
  const length = decimalInteger(match[1], 'byte range length', line)
  if (length === 0) throw new HlsPlaylistError('byte range has a length of 0', line)
  return {
    length,
    offset: match[2] === undefined ? undefined : decimalInteger(match[2], 'byte range offset', line)
  }
}

/** §4.1: relative URIs are relative to the playlist's URI. §6.3.1: a client that can't handle a
 * URI's scheme must stop, so anything but http(s) is refused rather than fetched. */
function resolveUri(reference: string, base: string, line: number): string {
  let resolved: URL
  try {
    resolved = new URL(reference, base)
  } catch {
    throw new HlsPlaylistError(`"${reference}" is not a valid URI`, line)
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new HlsUnsupportedError(
      `The playlist points at a ${resolved.protocol} address, which Mergelane can't download from.`
    )
  }
  return resolved.href
}

/** Splits a playlist into lines (§4.1: LF or CRLF terminated; blank lines ignored; '#EXT' starts
 * a tag, any other '#' a comment, anything else is a URI). Comments are dropped. */
function tokenize(text: string): Line[] {
  // §4.1 forbids a byte order mark; tolerate one rather than refuse an otherwise fine playlist.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines: Line[] = []
  let sawHeader = false
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const text = raw.trim()
    if (!text) continue
    const number = index + 1
    if (!sawHeader) {
      // §4.3.1.1: EXTM3U MUST be the first line of every playlist.
      if (text !== '#EXTM3U') {
        throw new HlsPlaylistError('it does not start with #EXTM3U, so it is not an HLS playlist')
      }
      sawHeader = true
      continue
    }
    if (text.startsWith('#EXT')) {
      const colon = text.indexOf(':')
      lines.push({
        number,
        tag: (colon < 0 ? text : text.slice(0, colon)).slice(1),
        value: colon < 0 ? '' : text.slice(colon + 1)
      })
    } else if (!text.startsWith('#')) {
      lines.push({ number, uri: text, value: '' })
    }
  }
  if (!sawHeader) throw new HlsPlaylistError('it is empty')
  return lines
}

/** Refuses EXT-X-KEY / EXT-X-SESSION-KEY that signal encryption. Any METHOD other than NONE is
 * refused, including AES-128, SAMPLE-AES, methods this module doesn't recognise (§6.3.6: a client
 * MUST NOT decrypt with one) and a missing METHOD (§4.3.2.4: REQUIRED). This deliberately ignores
 * §6.3.6's "MUST ignore any EXT-X-KEY tag with an unsupported or unrecognized KEYFORMAT": skipping
 * such a key would mean saving segments that are still encrypted. Mergelane never fetches keys.
 * (An EXT-X-SESSION-KEY with METHOD=NONE is invalid, §4.3.4.5, but encrypts nothing.) */
function refuseEncryption(line: Line): void {
  const method = parseAttributeList(line.value, line.number).get('METHOD')
  if (method === 'NONE') return
  throw new HlsProtectedStreamError(
    method ? `encrypted with ${method}` : 'encrypted with an unnamed method'
  )
}

/**
 * Parses an HLS playlist (RFC 8216) into a Master or Media Playlist.
 *
 * `url` is the playlist's own URL (after redirects); every relative URI is resolved against it.
 *
 * Throws {@link HlsPlaylistError} for playlists §4 says a client must fail to parse,
 * {@link HlsProtectedStreamError} for any encryption (EXT-X-KEY with a METHOD other than NONE, or
 * EXT-X-SESSION-KEY), {@link HlsLimitError} past {@link MAX_SEGMENTS} segments, and
 * {@link HlsUnsupportedError} for non-HTTP URIs. Live playlists parse; see
 * {@link assertDownloadable} for refusing them.
 */
export function parsePlaylist(text: string, url: string): HlsPlaylist {
  let base: string
  try {
    base = new URL(url).href
  } catch {
    throw new HlsPlaylistError(`its address "${url}" is not a valid URL`)
  }
  const lines = tokenize(text)
  let master = false
  let media = false
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.tag) continue
    if (MASTER_TAGS.has(line.tag)) master = true
    if (MEDIA_PLAYLIST_TAGS.has(line.tag) || SEGMENT_TAGS.has(line.tag)) media = true
    if (ONCE_TAGS.has(line.tag) || MEDIA_PLAYLIST_TAGS.has(line.tag)) {
      // §4.3.1.2, §4.3.3, §4.3.5: these tags MUST NOT appear more than once.
      if (seen.has(line.tag)) throw new HlsPlaylistError(`#${line.tag} appears twice`, line.number)
      seen.add(line.tag)
    }
  }
  if (master && media) {
    // §4.3.4: clients MUST fail to parse a playlist with both Master and Media Playlist tags.
    throw new HlsPlaylistError('it mixes master playlist and media playlist tags (§4.3.4)')
  }
  return master ? parseMaster(lines, base) : parseMedia(lines, base)
}

function versionOf(lines: Line[]): number | undefined {
  const line = lines.find((candidate) => candidate.tag === 'EXT-X-VERSION')
  return line ? decimalInteger(line.value, 'EXT-X-VERSION', line.number) : undefined
}

function parseMedia(lines: Line[], base: string): MediaPlaylist {
  const segments: MediaSegment[] = []
  let targetDuration: number | undefined
  let mediaSequence = 0
  let playlistType: MediaPlaylist['playlistType']
  let endList = false
  let iFramesOnly = false
  let duration = 0
  let init: InitSection | undefined
  // Tags that apply to the next URI line only.
  let pendingInfo: { duration: number; title?: string; line: number } | undefined
  let pendingRange: { length: number; offset?: number } | undefined
  let pendingDiscontinuity = false

  for (const line of lines) {
    if (line.uri !== undefined) {
      if (!pendingInfo) {
        // §4.3.2.1: EXTINF is REQUIRED for each Media Segment.
        throw new HlsPlaylistError('a segment has no #EXTINF duration (§4.3.2.1)', line.number)
      }
      const uri = resolveUri(line.uri, base, line.number)
      let byteRange: ByteRange | undefined
      if (pendingRange) {
        let offset = pendingRange.offset
        if (offset === undefined) {
          // §4.3.2.2: without an offset, the range continues the previous segment's sub-range of
          // the same resource; with no such segment the client MUST fail to parse.
          const previous = segments.at(-1)
          if (!previous?.byteRange || previous.uri !== uri) {
            throw new HlsPlaylistError(
              '#EXT-X-BYTERANGE has no offset and does not continue a range of the same resource (§4.3.2.2)',
              line.number
            )
          }
          offset = previous.byteRange.offset + previous.byteRange.length
        }
        byteRange = { offset, length: pendingRange.length }
      }
      if (segments.length >= MAX_SEGMENTS) {
        throw new HlsLimitError(
          'segments',
          `This playlist has more than ${MAX_SEGMENTS.toLocaleString('en-US')} segments, which is more than Mergelane will download.`
        )
      }
      segments.push({
        index: segments.length,
        sequence: mediaSequence + segments.length,
        uri,
        duration: pendingInfo.duration,
        ...(pendingInfo.title === undefined ? {} : { title: pendingInfo.title }),
        ...(byteRange ? { byteRange } : {}),
        ...(init ? { init } : {}),
        discontinuity: pendingDiscontinuity
      })
      duration += pendingInfo.duration
      pendingInfo = undefined
      pendingRange = undefined
      pendingDiscontinuity = false
      continue
    }

    switch (line.tag) {
      case 'EXTINF': {
        // §4.3.2.1: #EXTINF:<duration>,[<title>]. A missing comma is tolerated.
        const comma = line.value.indexOf(',')
        const value = (comma < 0 ? line.value : line.value.slice(0, comma)).trim()
        const title = comma < 0 ? '' : line.value.slice(comma + 1).trim()
        pendingInfo = {
          duration: decimalFloat(value, 'EXTINF duration', line.number),
          line: line.number,
          ...(title ? { title } : {})
        }
        break
      }
      case 'EXT-X-BYTERANGE':
        pendingRange = byteRangeSpec(line.value, line.number)
        break
      case 'EXT-X-DISCONTINUITY':
        pendingDiscontinuity = true
        break
      case 'EXT-X-KEY':
        refuseEncryption(line)
        break
      case 'EXT-X-MAP': {
        // §4.3.2.5: applies to every following segment until the next EXT-X-MAP.
        const attributes = parseAttributeList(line.value, line.number)
        const uri = attributes.get('URI')
        if (!uri) throw new HlsPlaylistError('#EXT-X-MAP has no URI (§4.3.2.5)', line.number)
        const rangeText = attributes.get('BYTERANGE')
        let byteRange: ByteRange | undefined
        if (rangeText !== undefined) {
          const range = byteRangeSpec(rangeText, line.number)
          // §4.3.2.5 borrows §4.3.2.2's format, whose offset-less form is defined only relative
          // to a previous Media Segment. An initialization section has none, so require it.
          if (range.offset === undefined) {
            throw new HlsPlaylistError('#EXT-X-MAP BYTERANGE has no offset', line.number)
          }
          byteRange = { offset: range.offset, length: range.length }
        }
        init = { uri: resolveUri(uri, base, line.number), ...(byteRange ? { byteRange } : {}) }
        break
      }
      case 'EXT-X-TARGETDURATION':
        targetDuration = decimalInteger(line.value, 'EXT-X-TARGETDURATION', line.number)
        break
      case 'EXT-X-MEDIA-SEQUENCE':
        // §4.3.3.2: MUST appear before the first Media Segment.
        if (segments.length > 0) {
          throw new HlsPlaylistError(
            '#EXT-X-MEDIA-SEQUENCE comes after the first segment (§4.3.3.2)',
            line.number
          )
        }
        mediaSequence = decimalInteger(line.value, 'EXT-X-MEDIA-SEQUENCE', line.number)
        break
      case 'EXT-X-ENDLIST':
        endList = true
        break
      case 'EXT-X-PLAYLIST-TYPE':
        // §4.3.3.5: EVENT or VOD. §6.3.1: ignore a tag whose enumerated-string is unrecognised.
        if (line.value === 'VOD' || line.value === 'EVENT') playlistType = line.value
        break
      case 'EXT-X-I-FRAMES-ONLY':
        iFramesOnly = true
        break
      default:
      // §6.3.1: unrecognised tags are ignored for forward compatibility.
    }
  }

  if (pendingInfo || pendingRange) {
    throw new HlsPlaylistError(
      'it ends with segment tags that have no segment URI after them',
      pendingInfo?.line
    )
  }
  if (targetDuration === undefined) {
    // §4.3.3.1: the EXT-X-TARGETDURATION tag is REQUIRED.
    throw new HlsPlaylistError('#EXT-X-TARGETDURATION is missing (§4.3.3.1)')
  }
  const version = versionOf(lines)
  return {
    kind: 'media',
    url: base,
    ...(version === undefined ? {} : { version }),
    targetDuration,
    mediaSequence,
    ...(playlistType ? { playlistType } : {}),
    endList,
    iFramesOnly,
    segments,
    duration
  }
}

const RENDITION_TYPES = new Set<Rendition['type']>([
  'AUDIO',
  'VIDEO',
  'SUBTITLES',
  'CLOSED-CAPTIONS'
])

/** YES/NO enumerated-string; undefined when the value is something else. */
function yesNo(value: string | undefined): boolean | undefined {
  if (value === undefined || value === 'NO') return false
  return value === 'YES' ? true : undefined
}

/** §4.3.4.1 EXT-X-MEDIA. Undefined when §6.3.1 says to ignore the tag (an unrecognised
 * enumerated-string value). */
function parseRendition(line: Line, base: string): Rendition | undefined {
  const attributes = parseAttributeList(line.value, line.number)
  const type = attributes.get('TYPE') as Rendition['type'] | undefined
  const groupId = attributes.get('GROUP-ID')
  const name = attributes.get('NAME')
  if (!type || groupId === undefined || name === undefined) {
    throw new HlsPlaylistError(
      '#EXT-X-MEDIA is missing TYPE, GROUP-ID or NAME (§4.3.4.1)',
      line.number
    )
  }
  const isDefault = yesNo(attributes.get('DEFAULT'))
  const autoselect = yesNo(attributes.get('AUTOSELECT'))
  if (!RENDITION_TYPES.has(type) || isDefault === undefined || autoselect === undefined) {
    return undefined
  }
  const uri = attributes.get('URI')
  const language = attributes.get('LANGUAGE')
  const channels = attributes.get('CHANNELS')
  return {
    type,
    groupId,
    name,
    ...(language === undefined ? {} : { language }),
    ...(uri === undefined ? {} : { uri: resolveUri(uri, base, line.number) }),
    default: isDefault,
    // §4.3.4.1: AUTOSELECT MUST be YES when DEFAULT is YES; treat it so even if omitted.
    autoselect: autoselect || isDefault,
    ...(channels === undefined ? {} : { channels })
  }
}

/** §4.3.4.2 EXT-X-STREAM-INF plus the URI line after it. */
function parseVariant(line: Line, uri: string, index: number): Variant {
  const attributes = parseAttributeList(line.value, line.number)
  const bandwidth = attributes.get('BANDWIDTH')
  if (bandwidth === undefined) {
    // §4.3.4.2: every EXT-X-STREAM-INF tag MUST include the BANDWIDTH attribute.
    throw new HlsPlaylistError('#EXT-X-STREAM-INF has no BANDWIDTH (§4.3.4.2)', line.number)
  }
  const variant: Variant = {
    id: `v${index}`,
    uri,
    bandwidth: decimalInteger(bandwidth, 'BANDWIDTH', line.number)
  }
  const average = attributes.get('AVERAGE-BANDWIDTH')
  if (average !== undefined) {
    variant.averageBandwidth = decimalInteger(average, 'AVERAGE-BANDWIDTH', line.number)
  }
  const codecs = attributes.get('CODECS')
  if (codecs !== undefined) {
    variant.codecs = codecs
      .split(',')
      .map((codec) => codec.trim())
      .filter(Boolean)
  }
  const resolution = attributes.get('RESOLUTION')
  if (resolution !== undefined) {
    // §4.2 decimal-resolution: <width>x<height>.
    const match = /^(\d+)x(\d+)$/.exec(resolution)
    if (!match) {
      throw new HlsPlaylistError(`RESOLUTION "${resolution}" is not WIDTHxHEIGHT`, line.number)
    }
    variant.resolution = {
      width: decimalInteger(match[1], 'RESOLUTION width', line.number),
      height: decimalInteger(match[2], 'RESOLUTION height', line.number)
    }
  }
  const frameRate = attributes.get('FRAME-RATE')
  if (frameRate !== undefined) {
    variant.frameRate = decimalFloat(frameRate, 'FRAME-RATE', line.number)
  }
  const groups = [
    ['AUDIO', 'audioGroup'],
    ['VIDEO', 'videoGroup'],
    ['SUBTITLES', 'subtitlesGroup']
  ] as const
  for (const [attribute, field] of groups) {
    const value = attributes.get(attribute)
    if (value !== undefined) variant[field] = value
  }
  const hdcp = attributes.get('HDCP-LEVEL')
  if (hdcp !== undefined) variant.hdcpLevel = hdcp
  return variant
}

function parseMaster(lines: Line[], base: string): MasterPlaylist {
  const variants: Variant[] = []
  const renditions: Rendition[] = []
  let pending: Line | undefined
  for (const line of lines) {
    if (line.uri !== undefined) {
      if (!pending) {
        // §4.1: in a Master Playlist every URI line names a Media Playlist, which §4.3.4.2
        // introduces with EXT-X-STREAM-INF.
        throw new HlsPlaylistError(
          'a URI in a master playlist does not follow #EXT-X-STREAM-INF',
          line.number
        )
      }
      variants.push(parseVariant(pending, resolveUri(line.uri, base, line.number), variants.length))
      pending = undefined
      continue
    }
    switch (line.tag) {
      case 'EXT-X-STREAM-INF':
        if (pending) {
          throw new HlsPlaylistError('#EXT-X-STREAM-INF has no URI line after it', pending.number)
        }
        pending = line
        break
      case 'EXT-X-MEDIA': {
        const rendition = parseRendition(line, base)
        if (rendition) renditions.push(rendition)
        break
      }
      case 'EXT-X-SESSION-KEY':
        // §4.3.4.5: preloads keys the Media Playlists use, so the media is encrypted.
        refuseEncryption(line)
        break
      default:
      // EXT-X-I-FRAME-STREAM-INF (trick-play only), EXT-X-SESSION-DATA and unrecognised tags
      // (§6.3.1) are not needed to download the presentation.
    }
  }
  if (pending) {
    throw new HlsPlaylistError('#EXT-X-STREAM-INF has no URI line after it', pending.number)
  }
  if (variants.length === 0) throw new HlsPlaylistError('the master playlist lists no streams')
  const version = versionOf(lines)
  return {
    kind: 'master',
    url: base,
    ...(version === undefined ? {} : { version }),
    variants,
    renditions
  }
}

function sameInit(a: InitSection | undefined, b: InitSection | undefined): boolean {
  return (
    a?.uri === b?.uri &&
    a?.byteRange?.offset === b?.byteRange?.offset &&
    a?.byteRange?.length === b?.byteRange?.length
  )
}

/**
 * Throws unless the Media Playlist can be saved as one file: it must be finished (EXT-X-ENDLIST,
 * §4.3.3.4 / §6.2.1), hold real segments rather than I-frames only (§4.3.3.6), list at least one
 * segment, and use a single initialization section throughout (§4.3.2.5).
 */
export function assertDownloadable(playlist: MediaPlaylist): void {
  // §6.2.1: a playlist that holds the final segment MUST contain EXT-X-ENDLIST; without it the
  // server keeps adding segments. EVENT playlists are the same until they end.
  if (!playlist.endList) throw new HlsLiveStreamError()
  if (playlist.iFramesOnly) {
    throw new HlsUnsupportedError(
      'This playlist holds only the key frames used for fast-forward previews, not the full video.'
    )
  }
  if (playlist.segments.length === 0) {
    throw new HlsPlaylistError('it lists no media segments')
  }
  const first = playlist.segments[0].init
  if (playlist.segments.some((segment) => !sameInit(segment.init, first))) {
    throw new HlsUnsupportedError(
      "This stream switches its initialization section part-way through, which Mergelane can't save as one file yet."
    )
  }
}
