/** Why a YouTube video can't be downloaded. */
export type YoutubeErrorCode =
  /** It needs a sign-in: age-restricted, private or members-only. */
  | 'sign-in'
  /** YouTube asked the network to prove it isn't a bot. */
  | 'bot-check'
  | 'unavailable'
  /** Not offered where the network connects from. */
  | 'geo'
  | 'live'
  | 'premiere'
  | 'drm'
  /** Nothing left that Mergelane may download: every format needs a sign-in, a token or DRM. */
  | 'no-formats'
  | 'rate-limited'
  /** YouTube couldn't be reached. */
  | 'network'
  | 'timeout'
  /** yt-dlp's answer was too large, or not what yt-dlp writes. */
  | 'bad-answer'
  /** The quality picked is no longer offered. */
  | 'format-gone'
  | 'failed'

export const SIGN_IN_MESSAGE =
  'This video needs a sign-in. Mergelane only downloads videos anyone can watch without signing in.'

const MESSAGES: Readonly<Record<Exclude<YoutubeErrorCode, 'failed'>, string>> = {
  'sign-in': SIGN_IN_MESSAGE,
  'bot-check':
    'YouTube asked this network to sign in to prove it isn’t a bot. Mergelane doesn’t sign in, so try again later or on another network.',
  unavailable: 'This video isn’t available on YouTube. It may have been removed.',
  geo: 'YouTube doesn’t offer this video where this network connects from.',
  live: 'This is a live stream that is still being broadcast. Mergelane can download it once it has ended.',
  premiere: 'This video hasn’t premiered yet. Mergelane can download it once it has been shown.',
  drm: 'This video is protected with DRM, which Mergelane doesn’t remove.',
  'no-formats':
    'YouTube offered no version of this video that Mergelane can download without signing in.',
  'rate-limited': 'YouTube is turning away requests from this network for now. Try again later.',
  network: 'Mergelane couldn’t reach YouTube. Check the internet connection and try again.',
  timeout: 'YouTube took too long to answer. Try again.',
  'bad-answer': 'yt-dlp’s answer about this video couldn’t be read.',
  'format-gone': 'YouTube no longer offers the quality that was picked. Start the download again.'
}

/** A YouTube video that can't be downloaded, with a message fit to show as it is. yt-dlp's own
 * words, when there are any, are kept apart in `detail`, for the log. */
export class YoutubeError extends Error {
  constructor(
    readonly code: YoutubeErrorCode,
    message?: string,
    readonly detail?: string
  ) {
    super(message ?? (code === 'failed' ? 'yt-dlp couldn’t read this video.' : MESSAGES[code]))
    this.name = 'YoutubeError'
  }
}

/** yt-dlp's error messages (YoutubeDL.py and extractor/youtube at 2026.10.26) and what they mean,
 * first match wins: the bot check says "Sign in", so it comes before the sign-in ones. */
const PATTERNS: readonly [RegExp, Exclude<YoutubeErrorCode, 'failed'>][] = [
  [/not a bot/i, 'bot-check'],
  [/DRM[- ]protected|DRM protection/i, 'drm'],
  [/confirm your age|age[- ]restrict|inappropriate for some users/i, 'sign-in'],
  [/private video|video is private/i, 'sign-in'],
  [/members[- ]only|channel's members|join this channel|premium members/i, 'sign-in'],
  [/sign in|log ?in to|login required|requires authentication|use --cookies/i, 'sign-in'],
  [
    /not (?:made this video )?available in your country|geo[- ]?restrict|from your location/i,
    'geo'
  ],
  [/premieres? in|premiere will begin|this live event will begin|upcoming/i, 'premiere'],
  [/HTTP Error 429|too many requests/i, 'rate-limited'],
  [
    /video unavailable|video is unavailable|has been removed|no longer available|been terminated|does not exist/i,
    'unavailable'
  ],
  [/requested format is not available|no video formats found/i, 'no-formats'],
  [
    /unable to download|timed out|connection (?:refused|reset)|network is unreachable|name or service not known|nodename nor servname|getaddrinfo|failed to resolve|ssl|tunnel connection failed|proxy/i,
    'network'
  ]
]

/** The error lines yt-dlp printed on stderr ("ERROR: [youtube] <id>: <message>"), without their
 * prefixes. */
function errorLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('ERROR:'))
    .map((line) =>
      line
        .replace(/^ERROR:\s*/, '')
        .replace(/^\[[^\]]+\]\s*(?:[A-Za-z0-9_-]+:\s*)?/, '')
        .trim()
    )
    .filter(Boolean)
}

/** What yt-dlp's failure means for the user. Its own message is kept, shortened, only when it
 * matches none that Mergelane knows. */
export function ytDlpFailure(stderr: string): YoutubeError {
  const detail = stderr.trim().slice(-4000)
  const lines = errorLines(stderr)
  const text = lines.length > 0 ? lines.join('\n') : detail
  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(text)) return new YoutubeError(code, undefined, detail)
  }
  const first = lines[0]
  return new YoutubeError(
    'failed',
    first
      ? `yt-dlp couldn’t read this video: ${first.length > 200 ? `${first.slice(0, 199)}…` : first}`
      : undefined,
    detail
  )
}
