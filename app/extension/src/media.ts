// Video streams a page loads (docs/YOUTUBE-REVIEW.md, option D): HLS and DASH manifests the
// browser fetched for the page anyway, seen only from their response headers. Nothing here is
// specific to a site, reads a response body, or changes a request. No extension APIs either, so
// e2e/extensionMedia.spec.ts tests it in Node.

export type MediaKind = 'HLS' | 'DASH'

export interface MediaItem {
  url: string
  kind: MediaKind
}

/** The streams one tab's page loaded. `page` is the tab's URL when they were seen. */
export interface PageMedia {
  page: string
  items: MediaItem[]
}

/** Extension pages → background, one field at a time: a tab's list (answered with PageMedia or
 * null), or hand one of its streams to Mergelane (answered with HandOver). */
export interface MediaRequest {
  mediaOf?: number
  sendMedia?: { tabId: number; url: string }
}
/** Background → extension pages, after a tab's list changed. */
export interface MediaChanged {
  mediaChanged: number
}
/** How handing something to Mergelane ended: taken, refused, or Mergelane isn't running. */
export type HandOver = 'sent' | 'kept' | 'closed'

/** Per tab: a master playlist and its variants fit, a live stream's refetches can't flood it. */
export const MAX_MEDIA = 20

/** Not listed or handed over until the owner decides how Mergelane treats YouTube
 * (docs/YOUTUBE-REVIEW.md). Its web player streams over its own protocol anyway, so plain
 * manifests from these hosts are rare (live streams); they are skipped, not detected. */
export const PENDING_SITES: readonly string[] = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'googlevideo.com'
]

// HLS: RFC 8216 section 4 names "application/vnd.apple.mpegurl" or "audio/mpegurl"; the second,
// like the .m3u extension it allows, is also used by plain audio playlists, so only the first and
// the common x-mpegurl are taken. DASH: IANA's application/dash+xml registration (ISO/IEC 23009-1,
// extension .mpd).
const HLS_TYPES = /^\s*application\/(?:vnd\.apple\.mpegurl|x-mpegurl)\s*(?:;|$)/i
const DASH_TYPES = /^\s*application\/dash\+xml\s*(?:;|$)/i

/** HLS or DASH, by the server's Content-Type or else the path's extension; null for anything
 * else. A server that says what it sends is believed over the name. */
export function manifestKind(url: string, contentType: string | undefined): MediaKind | null {
  if (contentType && HLS_TYPES.test(contentType)) return 'HLS'
  if (contentType && DASH_TYPES.test(contentType)) return 'DASH'
  let path: string
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    path = parsed.pathname.toLowerCase()
  } catch {
    return null
  }
  // An HTML error page at a manifest's address isn't one.
  if (contentType && /^\s*text\/html\b/i.test(contentType)) return null
  if (path.endsWith('.m3u8')) return 'HLS'
  if (path.endsWith('.mpd')) return 'DASH'
  return null
}

/** The same stream, whatever its fragment or HLS delivery directives: draft-pantos-hls-rfc8216bis
 * (section 6.2.5) reserves query parameters starting "_HLS_", which a low-latency live player
 * changes on every reload of its playlist. */
export function mediaKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const name of [...parsed.searchParams.keys()]) {
      if (name.startsWith('_HLS_')) parsed.searchParams.delete(name)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/** Whether two tab URLs show the same page: only the fragment may differ. */
export function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0]
}

/** `items` plus one more stream, or null when it's already listed or the list is full. */
export function withItem(items: readonly MediaItem[], item: MediaItem): MediaItem[] | null {
  const key = mediaKey(item.url)
  if (items.length >= MAX_MEDIA || items.some(({ url }) => mediaKey(url) === key)) return null
  return [...items, item]
}

/** The host, and a path short enough for one line of the popup. */
export function describe(url: string): { host: string; path: string } {
  try {
    const { hostname, pathname } = new URL(url)
    if (pathname.length <= 34) return { host: hostname, path: pathname }
    const last = pathname.split('/').filter(Boolean).pop() ?? ''
    return { host: hostname, path: `…/${last}` }
  } catch {
    return { host: url, path: '' }
  }
}
