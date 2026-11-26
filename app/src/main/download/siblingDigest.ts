import { sha256FromFile } from '../../shared/digests'
import { plainLink } from '../../shared/history'

// The `.sha256` file many sites keep beside a download (ADR-0081): asked for only when a finished
// file of the same name and size came from another site (shared/duplicates.ts worthAskingForDigest),
// so a match would mean something. One small request to the site the user is about to download from,
// without cookies, given 5 seconds; anything else (no such file, a page, too big) says nothing.

const MAX_BYTES = 16 * 1024

export async function siblingDigest(url: string, fileName: string): Promise<string | undefined> {
  try {
    const sibling = new URL(`${plainLink(url)}.sha256`)
    if (sibling.protocol !== 'https:' && sibling.protocol !== 'http:') return undefined
    const response = await fetch(sibling, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok || !response.body) return undefined
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_BYTES) return undefined
    // Read no more than MAX_BYTES, whatever the site sends (a chunked answer says no length).
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let read = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      read += value.byteLength
      if (read > MAX_BYTES) {
        await reader.cancel()
        return undefined
      }
    }
    return sha256FromFile(Buffer.concat(chunks).toString('utf-8'), fileName)
  } catch {
    return undefined
  }
}
