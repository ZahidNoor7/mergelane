// What Mergelane can download, recognised in text: what New download takes, what ⌘V and a drop on
// the window take, and what the clipboard offer looks for (main/clipboardOffers.ts, ADR-0043).

/** What Mergelane can download: a web link, a magnet link, or a .torrent or .nzb file on this
 * computer. */
export function acceptedLink(text: string): string | null {
  const link = text.trim()
  if (/^(https?:\/\/|magnet:\?)/i.test(link)) return link
  if (/^(\/|[a-z]:\\).*\.(torrent|nzb)$/i.test(link)) return link
  return null
}

/** Longer than this, what was copied is a document, not a link (a long magnet link is a few
 * kilobytes). */
export const COPIED_LINK_MAX = 16 * 1024

/** The link a person copied, when the clipboard holds just one: a web or magnet link with no
 * space in it, or a .torrent or .nzb file's path (which may have spaces). A paragraph that only
 * starts with a link isn't one. */
export function copiedLink(text: string): string | null {
  if (text.length > COPIED_LINK_MAX) return null
  const link = acceptedLink(text)
  if (!link) return null
  if (/^(https?:|magnet:)/i.test(link) && /\s/.test(link)) return null
  return link
}

/** A link, short enough to recognise: a web link's host and path, a magnet link's name, a file's
 * name. */
export function describeCopiedLink(link: string): string {
  if (/^magnet:/i.test(link)) {
    const name = new URLSearchParams(link.slice(link.indexOf('?') + 1)).get('dn')
    return name?.trim() || 'A magnet link'
  }
  if (/^https?:/i.test(link)) {
    try {
      const url = new URL(link)
      return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
    } catch {
      return link
    }
  }
  return link.split(/[\\/]/).pop() || link
}
