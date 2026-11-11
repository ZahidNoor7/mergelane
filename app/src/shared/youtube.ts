// Which links are YouTube videos (ADR-0026). The extension imports this file too, so its "Send this
// video to Mergelane" button and the app agree on what a video link is.
//
// Only a single video the user pasted or opened is taken: a playlist, a channel or any other page
// is refused in plain words, never crawled. Live streams and premieres are only known once yt-dlp
// has looked, so they are refused there (main/media/youtube).

/** A YouTube video's id: 11 characters of the URL-safe Base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const WATCH_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com'
])
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])
const NOCOOKIE_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com'])
/** Paths of youtube.com whose second part is the video's id. */
const ID_PATHS = new Set(['shorts', 'embed', 'live'])
/** Paths of youtube.com that are a channel's pages. */
const CHANNEL_PATHS = new Set(['channel', 'c', 'user'])

export const YOUTUBE_PLAYLIST =
  'This is a YouTube playlist. Mergelane downloads one video at a time: open a video in it and copy that video’s link.'
export const YOUTUBE_CHANNEL =
  'This is a YouTube channel. Mergelane downloads one video at a time: open a video and copy its link.'
export const YOUTUBE_NOT_A_VIDEO =
  'This YouTube link isn’t a video. Open the video and copy its link.'

/** A YouTube video, with the one address Mergelane hands yt-dlp for it; or a YouTube page that
 * isn't one video, with what to tell the user. */
export type YoutubeLink =
  { kind: 'video'; id: string; url: string } | { kind: 'refused'; reason: string }

/** The watch page of video `id`: whatever link it came from, this is what yt-dlp is given, so
 * `list=`, `t=` and tracking parameters never reach it. */
export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

/**
 * What `link` is on YouTube: a video (`youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`,
 * `/embed/` and `youtube-nocookie.com/embed/`), a page that is refused (a playlist, a channel,
 * anything else on those sites), or null when it isn't a YouTube link at all.
 */
export function youtubeLink(link: string): YoutubeLink | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  const refused = (reason: string): YoutubeLink => ({ kind: 'refused', reason })

  let id: string | null | undefined
  if (SHORT_HOSTS.has(host)) {
    id = parts.length === 1 ? parts[0] : undefined
  } else if (NOCOOKIE_HOSTS.has(host)) {
    id = parts.length === 2 && parts[0] === 'embed' ? parts[1] : undefined
  } else if (WATCH_HOSTS.has(host)) {
    const [first] = parts
    if (first === 'watch' && parts.length === 1) id = url.searchParams.get('v')
    else if (first !== undefined && ID_PATHS.has(first) && parts.length === 2) id = parts[1]
    else if (first === 'playlist') return refused(YOUTUBE_PLAYLIST)
    else if (first?.startsWith('@') || (first !== undefined && CHANNEL_PATHS.has(first))) {
      return refused(YOUTUBE_CHANNEL)
    }
  } else {
    return null
  }
  if (!id || !VIDEO_ID.test(id)) return refused(YOUTUBE_NOT_A_VIDEO)
  return { kind: 'video', id, url: youtubeWatchUrl(id) }
}
