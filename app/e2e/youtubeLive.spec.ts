// The live YouTube smoke test: the real, pinned yt-dlp and Deno against YouTube itself, over this
// Mac's real network, then the real FFmpeg (ADR-0026). Everything else in the suite uses a fake
// yt-dlp; this is the one test that shows YouTube still works with the versions we pin.
//
// It downloads one small public video, the one yt-dlp's own download tests use
// (test/test_overwrites.py at 2026.10.26: "Me at the zoo", 19 seconds), into the test's temporary
// folder, which is deleted afterwards. It never runs unless asked for, so a normal or @smoke run
// never reaches YouTube:
//
//   MERGELANE_YOUTUBE_LIVE=1 env -u ELECTRON_RUN_AS_NODE npx playwright test --grep @youtube-live
//
// .github/workflows/youtube-live.yml runs it by hand (and nightly once CI resumes, ADR-0020).

import { networkInterfaces } from 'node:os'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { StartStreamDownloadRequest } from '../src/shared/types'
import { expect, expectStream, PROJECT_ROOT, test } from './fixtures'
import { FFMPEG, inspect } from './streamMedia'

/** From yt-dlp's test suite at the pinned tag (test/test_overwrites.py). */
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const LIVE = process.env.MERGELANE_YOUTUBE_LIVE === '1'

/** This Mac's network the LAN address belongs to (see global-setup.ts), by its device name. */
function realNetwork(): string {
  const lan = process.env.MERGELANE_E2E_LAN
  for (const [device, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some((address) => address.address === lan)) return `${device}=${lan}`
  }
  return ''
}

const NETWORK = realNetwork()
const BIN = join(PROJECT_ROOT, 'resources', 'bin')

test.use({
  appEnv: {
    // The real network, pinned with IP_BOUND_IF like any other.
    MERGELANE_E2E_INTERFACES: NETWORK,
    MERGELANE_FFMPEG_PATH: process.env.MERGELANE_FFMPEG_PATH || FFMPEG || '',
    MERGELANE_YTDLP_PATH: process.env.MERGELANE_YTDLP_PATH || join(BIN, 'yt-dlp'),
    MERGELANE_DENO_PATH: process.env.MERGELANE_DENO_PATH || join(BIN, 'deno'),
    // yt-dlp and YouTube take their time; nothing here should give up on them early.
    MERGELANE_E2E_STALL_MS: '30000',
    MERGELANE_E2E_CONNECT_MS: '15000',
    MERGELANE_E2E_RETRY_BASE_MS: '1000'
  }
})

test.describe('YouTube, live @youtube-live', () => {
  test.skip(!LIVE, 'reaches YouTube: run with MERGELANE_YOUTUBE_LIVE=1')
  test.skip(!NETWORK, 'needs this Mac’s LAN address (see global-setup.ts)')

  test('yt-dlp and Deno find a public video, and Mergelane downloads and joins it', async ({
    mergelane,
    dirs
  }) => {
    test.setTimeout(10 * 60_000)
    const network = NETWORK.split('=')[0]
    await mergelane.api.listInterfaces()
    const probe = await mergelane.api.probeUrl(VIDEO)
    expect(probe.kind).toBe('stream')
    if (probe.kind !== 'stream') return
    expect(probe.stream.protocol).toBe('youtube')
    expect(probe.suggestedFileName.length).toBeGreaterThan(0)
    const variants = probe.stream.variants
    expect(variants.length).toBeGreaterThan(0)
    expect(variants.every((variant) => (variant.bytes ?? 0) > 0)).toBe(true)
    // The smallest, to ask as little of YouTube as possible.
    const smallest = [...variants].sort((a, b) => a.bytes! - b.bytes!)[0]

    const request: StartStreamDownloadRequest = {
      kind: 'stream',
      url: probe.finalUrl,
      protocol: 'youtube',
      variantId: smallest.id,
      destinationDir: dirs.dest,
      suggestedFileName: probe.suggestedFileName,
      totalBytes: 0,
      supportsRanges: true,
      interfaceIds: [network],
      etag: null,
      lastModified: null
    }
    const id = await mergelane.api.startDownload(request)
    const done = expectStream(await mergelane.waitForStatus('completed', 8 * 60_000))
    expect(done.id).toBe(id)
    expect(done.bytesDownloaded).toBe(smallest.bytes)
    expect(done.networks.find((entry) => entry.id === network)?.bytesDownloaded).toBe(
      smallest.bytes
    )
    expect(await readdir(dirs.dest)).toEqual([done.fileName])
    const media = await inspect(done.destinationPath)
    expect(media.video.length).toBe(1)
    expect(media.audio.length).toBe(1)
    expect(media.duration).toBeGreaterThan(15)
    expect(media.duration).toBeLessThan(25)
  })
})
