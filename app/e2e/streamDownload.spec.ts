// HLS and DASH downloads end to end, in the app: the link checked, the quality picked, the
// segments fetched over the networks chosen, paused and resumed, joined into one file by FFmpeg.
// The streams are real media made with FFmpeg (see streamMedia.ts), served from a local server
// that logs which segments it was asked for and over which network.

import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StartStreamDownloadRequest } from '../src/shared/types'
import { expect, expectStream, LAN_ADDRESS, test, type MergelaneApp } from './fixtures'
import {
  FFMPEG,
  NO_FFMPEG,
  PATHS,
  SECONDS,
  StreamServer,
  inspect,
  removeStreamMedia,
  streamMedia
} from './streamMedia'

test.use({ appEnv: { MERGELANE_FFMPEG_PATH: FFMPEG ?? '' } })

let server: StreamServer
test.beforeEach(async () => {
  if (FFMPEG !== null) server = await new StreamServer(await streamMedia()).start()
})
test.afterEach(async () => server?.stop())
test.afterAll(removeStreamMedia)

/** Checks `url` and starts it as New download's Download button does. */
async function startStream(
  app: MergelaneApp,
  url: string,
  options: { networks?: string[]; variantId?: string } = {}
): Promise<string> {
  await app.api.listInterfaces()
  const probe = await app.api.probeUrl(url)
  if (probe.kind !== 'stream') throw new Error(`Expected a stream, got ${probe.kind}`)
  const request: StartStreamDownloadRequest = {
    kind: 'stream',
    url: probe.finalUrl,
    protocol: probe.stream.protocol,
    variantId: options.variantId,
    destinationDir: app.dirs.dest,
    suggestedFileName: probe.suggestedFileName,
    totalBytes: 0,
    supportsRanges: true,
    interfaceIds: options.networks ?? ['a'],
    etag: null,
    lastModified: null
  }
  return app.api.startDownload(request)
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The segment's index in its playlist, from `seg003.ts`. */
const segmentIndex = (path: string): number => Number(/seg(\d+)\.ts$/.exec(path)?.[1] ?? -1)

test.describe('stream downloads @smoke', () => {
  test.skip(FFMPEG === null, NO_FFMPEG)
  test('an HLS stream becomes one file with its video and audio', async ({ mergelane, dirs }) => {
    // Left by an FFmpeg run a crash cut short: swept when a stream download starts.
    const stale = join(dirs.dest, 'old.mp4.0123abcd.mergelane-mux')
    await writeFile(stale, 'partial')
    // Slow enough for the window to be sent segments while they're in flight.
    server.delayMs = 150
    const id = await startStream(mergelane, server.url(PATHS.master))
    const done = expectStream(await mergelane.waitUntil((state) => state.status === 'completed'))
    expect(done.id).toBe(id)
    expect(done.protocol).toBe('hls')
    expect(done.quality).toBe('240p')
    expect(done.fileName).toBe('video.mp4')
    expect(done.bytesDownloaded).toBe(done.totalBytes)
    expect(await readdir(dirs.dest)).toEqual(['video.mp4'])
    expect(existsSync(stale)).toBe(false)

    const media = await inspect(done.destinationPath)
    expect(media.format).toContain('mp4')
    expect(media.video).toEqual(['h264'])
    expect(media.audio).toEqual(['aac'])
    expect(media.size).toBe('320x240')
    expect(media.duration).toBeGreaterThan(SECONDS - 1)

    // The window saw its segments come in, and it's in history as a stream download.
    const seen = mergelane.sessions[0].filter((state) => state.id === id).map(expectStream)
    expect(seen.some((state) => state.blocks.some((block) => block.status === 'downloading'))).toBe(
      true
    )
    expect(seen.at(-1)!.blocks.every((block) => block.status === 'completed')).toBe(true)
    const [entry] = await mergelane.api.listHistory()
    expect(entry).toMatchObject({ id, kind: 'stream', unitsWritten: done.totalBlocks })
  })

  test('a DASH stream downloads the quality asked for', async ({ mergelane, dirs }) => {
    await startStream(mergelane, server.url(PATHS.mpd), { variantId: '1' })
    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(done.protocol).toBe('dash')
    expect(done.quality).toBe('120p')
    const media = await inspect(done.destinationPath)
    expect([media.video, media.audio, media.size]).toEqual([['h264'], ['aac'], '160x120'])
    const paths = server.segments().map((entry) => entry.path)
    expect(paths.some((path) => /\/(init|chunk)-0[-.]/.test(path))).toBe(false)
    expect(paths.filter((path) => /\/(init|chunk)-1[-.]/.test(path))).toHaveLength(9)
    expect(await readdir(dirs.dest)).toEqual(['video.mp4'])
  })

  test('the quality picked in New download is the one downloaded', async ({ mergelane, dirs }) => {
    const { page } = mergelane
    // Saved in the test's folder, never the computer's Downloads: its folder dialog answers so.
    await mergelane.evaluateMain(({ dialog }, dest) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    }, dirs.dest)
    const link = await mergelane.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(server.url(PATHS.master))
    const quality = page.getByRole('group', { name: 'Quality' })
    const best = quality.getByRole('button', { name: '240p' })
    const low = quality.getByRole('button', { name: '120p' })
    // Best first, and picked unless another is.
    await expect(best).toHaveAttribute('aria-pressed', 'true')
    await expect(low).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByText('HLS', { exact: true })).toBeVisible()
    await low.click()
    await expect(low).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Download' }).click()
    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(done.destinationPath).toBe(join(dirs.dest, 'video.mp4'))
    expect(done.quality).toBe('120p')
    expect((await inspect(done.destinationPath)).size).toBe('160x120')
    const segments = server.segments().map((entry) => entry.path)
    expect(segments.some((path) => path.includes('/v240/'))).toBe(false)
    expect(segments.filter((path) => path.includes('/v120/'))).toHaveLength(SECONDS)
  })

  test('two networks share the segments', async ({ mergelane }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    await startStream(mergelane, server.url(PATHS.master), { networks: ['a', 'b'] })
    const done = expectStream(await mergelane.waitForStatus('completed'))
    const from = new Set(server.segments().map((entry) => entry.from))
    expect([...from].sort()).toEqual(['127.0.0.1', LAN_ADDRESS!].sort())
    const used = done.networks.filter((network) => network.bytesDownloaded > 0)
    expect(used.map((network) => network.id).sort()).toEqual(['a', 'b'])
  })

  test('paused and resumed, it fetches only the segments it hadn’t', async ({ mergelane }) => {
    // Segments from the fourth on wait: the first three of each track come in, then the two
    // requests each track runs at once (MERGELANE_E2E_STREAMS=2, one network) are held.
    server.hold = (path) => segmentIndex(path) >= 3
    const id = await startStream(mergelane, server.url(PATHS.master))
    await waitFor(() => server.log.filter((entry) => entry.held && !entry.endedAt).length === 4)
    await mergelane.api.pauseDownload(id)
    const paused = expectStream(await mergelane.waitForStatus('paused'))
    expect(paused.blocks.filter((block) => block.status === 'completed')).toHaveLength(6)

    const resumedAt = Date.now()
    server.release()
    await mergelane.api.resumeDownload(id)
    const done = expectStream(await mergelane.waitForStatus('completed'))
    const again = server
      .segments()
      .filter((entry) => entry.at >= resumedAt && segmentIndex(entry.path) < 3)
    expect(again).toEqual([])
    expect((await inspect(done.destinationPath)).audio).toEqual(['aac'])
  })

  test('quit mid-download, it picks up after a relaunch where it stopped', async ({
    mergelane
  }) => {
    server.hold = (path) => segmentIndex(path) >= 3
    const id = await startStream(mergelane, server.url(PATHS.master))
    await waitFor(() => server.log.filter((entry) => entry.held && !entry.endedAt).length === 4)
    // Quitting pauses it and saves it: its segments' sizes too, which only the server could
    // tell it again.
    await mergelane.quit()
    const relaunchedAt = Date.now()
    server.release()
    await mergelane.relaunch()
    const restored = expectStream((await mergelane.byId(id))!)
    expect(restored.status).toBe('paused')
    expect(restored.blocks.filter((block) => block.status === 'completed')).toHaveLength(6)
    expect(
      restored.blocks
        .filter((block) => block.status === 'completed')
        .every((block) => block.rangeEnd !== null)
    ).toBe(true)
    await mergelane.api.resumeDownload(id)
    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(
      server.segments().filter((entry) => entry.at >= relaunchedAt && segmentIndex(entry.path) < 3)
    ).toEqual([])
    const media = await inspect(done.destinationPath)
    expect([media.video, media.audio]).toEqual([['h264'], ['aac']])
  })

  test('cancelled, it leaves nothing behind', async ({ mergelane, dirs }) => {
    server.delayMs = 150
    const id = await startStream(mergelane, server.url(PATHS.master))
    await mergelane.waitUntil(
      (state) =>
        state.kind === 'stream' && state.blocks.some((block) => block.status === 'completed')
    )
    await mergelane.api.cancelDownload(id)
    await mergelane.waitForStatus('cancelled')
    await expect.poll(() => readdir(dirs.dest)).toEqual([])
  })

  test('live, encrypted and protected streams are refused when the link is checked', async ({
    mergelane
  }) => {
    const { page } = mergelane
    const link = await mergelane.newDownload()
    await link.fill(server.url(PATHS.live))
    await expect(
      page.getByText('This is a live stream that is still being broadcast')
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download' })).toBeDisabled()

    await expect(mergelane.api.probeUrl(server.url(PATHS.encrypted))).rejects.toThrow(
      /This stream is protected \(encrypted with AES-128\)/
    )
    await expect(mergelane.api.probeUrl(server.url(PATHS.liveMpd))).rejects.toThrow(
      /This is a live DASH stream/
    )
    await expect(mergelane.api.probeUrl(server.url(PATHS.protectedMpd))).rejects.toThrow(
      /protected with DRM/
    )
    // Nothing but the manifests was ever asked for.
    expect(server.segments()).toEqual([])
  })
})

test.describe('stream downloads without FFmpeg @smoke', () => {
  test.skip(FFMPEG === null, NO_FFMPEG)
  test.use({ appEnv: { MERGELANE_FFMPEG_PATH: '/nonexistent/ffmpeg' } })

  test('fail at once, saying FFmpeg is missing', async ({ mergelane, dirs }) => {
    await startStream(mergelane, server.url(PATHS.master))
    const failed = expectStream(await mergelane.waitForStatus('error'))
    expect(failed.error).toContain('Mergelane needs FFmpeg')
    expect(failed.error).toContain('/nonexistent/ffmpeg')
    // It can be retried once FFmpeg is there: nothing was thrown away, and nothing fetched.
    expect(failed.resumable).toBe(true)
    expect(server.segments()).toEqual([])
    await mergelane.api.removeDownload(failed.id)
    await expect.poll(() => readdir(dirs.dest)).toEqual([])
  })
})
