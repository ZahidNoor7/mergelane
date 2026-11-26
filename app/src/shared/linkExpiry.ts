// Links that expire (docs/plans/2026-11-new-features-plan.md, feature 6). Many sites hand out
// signed links that stop working after a while. When one does mid-download, the download should
// stop at once and wait for a fresh link, rather than spend every network's retries first. The main
// process applies these rules (main/download/httpTransfer.ts); everything here is pure.

/** The answers a server gives a link that no longer works for this request: not signed in, not
 * allowed, gone. 404 isn't one: a file that was removed answers so, and so does a typo. */
const EXPIRED_STATUSES: ReadonlySet<number> = new Set([401, 403, 410])

/** An answer that refuses the link itself (see EXPIRED_STATUSES). */
export const isRefusal = (status: number): boolean => EXPIRED_STATUSES.has(status)

/** Query keys signed links carry: AWS S3 and CloudFront, Google Cloud Storage, Azure Blob
 * Storage's shared access signatures, and the plain names many sites use. */
const SIGNED_KEYS: ReadonlySet<string> = new Set([
  'expires',
  'x-amz-expires',
  'x-amz-signature',
  'x-amz-credential',
  'x-goog-expires',
  'x-goog-signature',
  'signature',
  'key-pair-id',
  'policy',
  'sig',
  'se',
  'token',
  'exp',
  'expiry'
])

/** Whether a link looks signed: a query key that signs it or says when it stops working. */
export function signedLink(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_KEYS.has(key.toLowerCase())) return true
  }
  return false
}

/** What a download has seen since the last bytes arrived on any network. */
export interface Refusals {
  /** The status of the answer just in. */
  status: number
  /** The download's link looks signed (signedLink). */
  signed: boolean
  /** Answers like this one in a row, on any network, with no bytes in between. */
  count: number
  /** How many networks have had one. */
  networks: number
  /** How many networks the download can use now. */
  usable: number
}

/**
 * Whether the link has stopped working. A signed link refused twice in a row is taken at its word.
 * Any other needs three in a row on every network it can use: one site turns away connections over
 * its limit with a 403 (the other streams keep receiving, which starts the count over), and a
 * network of its own can be blocked where another isn't.
 */
export function linkStopped(refusals: Refusals): boolean {
  if (!EXPIRED_STATUSES.has(refusals.status)) return false
  if (refusals.signed) return refusals.count >= 2
  return refusals.networks >= Math.max(1, refusals.usable) && refusals.count >= 3
}

/** What a download whose link stopped working says (DownloadState.error). */
export const LINK_EXPIRED_MESSAGE = 'The link stopped working. Paste a fresh one to carry on.'

/** The file name at the end of a link's path, as the user would read it, or '' when it has none. */
export function fileNameOfLink(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

/** Whether what the user typed or pasted is a web link at all. */
export function isWebLink(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')
  } catch {
    return false
  }
}
