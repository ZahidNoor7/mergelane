// Logic adapted from Awesome Downloader core/hls.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane; see docs/UPSTREAM.md.

/** What went wrong, for code that branches on it (the message is for people). */
export type HlsErrorCode =
  | 'invalid-playlist'
  | 'live-stream'
  | 'protected-stream'
  | 'limit-exceeded'
  | 'unsupported'
  | 'http-status'
  | 'variant-not-found'
  | 'segment-failed'

/** Base class of every error this module throws on purpose. `message` is written to be shown to
 * the user as-is; `code` is for code. Aborts are not HlsErrors: they reject with the signal's
 * reason, as the platform does. */
export class HlsError extends Error {
  constructor(
    readonly code: HlsErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The playlist breaks a rule of RFC 8216 that a client must fail on (RFC 8216 §4: "Playlists that
 * violate these rules are invalid; clients MUST fail to parse them"). */
export class HlsPlaylistError extends HlsError {
  constructor(
    readonly detail: string,
    /** 1-based line of the playlist the problem is on, when there is one. */
    readonly line?: number
  ) {
    super(
      'invalid-playlist',
      `The HLS playlist is not valid: ${detail}${line === undefined ? '' : ` (line ${line})`}.`
    )
  }
}

/** A Media Playlist without EXT-X-ENDLIST: the server is still adding segments (RFC 8216 §6.2.1),
 * so there is no finished file to download. */
export class HlsLiveStreamError extends HlsError {
  constructor() {
    super(
      'live-stream',
      'This is a live stream that is still being broadcast. Mergelane downloads only finished (on-demand) HLS videos.'
    )
  }
}

/** The stream is encrypted or needs output protection. Mergelane never fetches keys or decrypts:
 * it refuses (CLAUDE.md: no DRM circumvention). */
export class HlsProtectedStreamError extends HlsError {
  constructor(
    /** What protects it, e.g. "encrypted with AES-128". */
    readonly protection: string
  ) {
    super(
      'protected-stream',
      `This stream is protected (${protection}). Mergelane doesn't download protected streams.`
    )
  }
}

/** Which safety limit a playlist or server went past. */
export type HlsLimit = 'segments' | 'nesting' | 'playlist-size' | 'redirects'

/** A playlist or server went past one of the limits that keep a hostile or broken stream from
 * exhausting memory, disk or time. */
export class HlsLimitError extends HlsError {
  constructor(
    readonly limit: HlsLimit,
    message: string
  ) {
    super('limit-exceeded', message)
  }
}

/** A valid stream that uses something this module doesn't handle yet. */
export class HlsUnsupportedError extends HlsError {
  constructor(message: string) {
    super('unsupported', message)
  }
}

/** Origin and path only: query strings of media URLs often carry signed tokens, which don't belong
 * in messages that end up in logs or on screen. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return 'the server'
  }
}

/** The server answered with a status that isn't the content asked for. */
export class HlsHttpError extends HlsError {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super('http-status', `The server answered HTTP ${status} for ${describeUrl(url)}.`)
  }

  /** Busy, briefly broken or rate limiting: worth asking again after a pause. */
  get transient(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

/** The quality asked for isn't in the master playlist. */
export class HlsVariantNotFoundError extends HlsError {
  constructor(readonly variantId: string) {
    super(
      'variant-not-found',
      `The quality "${variantId}" is not offered by this stream any more. Choose another quality.`
    )
  }
}

/** A segment still failed after every retry. Segments already finished stay saved for resume. */
export class HlsSegmentError extends HlsError {
  constructor(
    /** Position in the track's request list (0 is the initialization section, if there is one). */
    readonly index: number,
    readonly url: string,
    cause: unknown
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      'segment-failed',
      `Part ${index + 1} of the stream could not be downloaded from ${describeUrl(url)}: ${reason}`,
      { cause }
    )
  }
}
