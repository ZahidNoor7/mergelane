import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { net } from 'electron'
import { downloadableUrl, parseChecksums } from '../shared/releases'

// Downloads an update's disk image and checks it against the SHA-256 its release publishes in
// SHA256SUMS (docs/DECISIONS.md ADR-0036). Electron's net.fetch, so the Mac's proxy settings apply.
// The file is written as <name>.part and renamed only once its hash matches; a failed or cancelled
// download leaves nothing behind.

/** A failure worth telling the user as it is. */
export class UpdateFailure extends Error {}

/** The SHA-256 the release publishes for `name`. */
export async function publishedChecksum(
  url: string,
  name: string,
  { headers, signal }: { headers: Record<string, string>; signal: AbortSignal }
): Promise<string> {
  if (!downloadableUrl(url)) throw new UpdateFailure('The release’s checksum link isn’t secure.')
  const response = await net.fetch(url, { headers, signal })
  if (!response.ok) {
    throw new UpdateFailure(
      `GitHub answered ${response.status} for the release’s checksums. Try again later.`
    )
  }
  const sum = parseChecksums(await response.text()).get(name)
  if (!sum) {
    throw new UpdateFailure(
      'This release publishes no checksum for its disk image, so Mergelane won’t download it.'
    )
  }
  return sum
}

/** Downloads the disk image into `dir`, checks it, and returns where it is. */
export async function downloadDiskImage(options: {
  url: string
  name: string
  size: number
  expected: string
  dir: string
  headers: Record<string, string>
  signal: AbortSignal
  onProgress: (received: number) => void
  onVerifying: () => void
}): Promise<string> {
  const { url, name, size, expected, dir, headers, signal, onProgress, onVerifying } = options
  if (!downloadableUrl(url)) throw new UpdateFailure('The disk image’s link isn’t secure.')
  await mkdir(dir, { recursive: true })
  const final = join(dir, name)
  const part = `${final}.part`
  await rm(part, { force: true })
  await rm(final, { force: true })
  try {
    const response = await net.fetch(url, { headers, signal })
    if (!response.ok || !response.body) {
      throw new UpdateFailure(
        `GitHub answered ${response.status} for the disk image. Try again later.`
      )
    }
    const hash = createHash('sha256')
    let received = 0
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk)
          received += chunk.length
          onProgress(received)
          yield chunk
        }
      },
      createWriteStream(part, { flags: 'wx', mode: 0o600 }),
      { signal }
    )
    if (received !== size) {
      throw new UpdateFailure('The download stopped before the end. Try again.')
    }
    onVerifying()
    if (hash.digest('hex') !== expected) {
      throw new UpdateFailure(
        'The download didn’t match the checksum published with the release, so it was deleted. Try again.'
      )
    }
    await rename(part, final)
    return final
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}
