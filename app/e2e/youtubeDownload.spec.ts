// YouTube downloads end to end, in the app (ADR-0026): a YouTube link pasted into New download is
// looked up by yt-dlp (a fake one, youtubeFake.ts: no real YouTube data), its qualities offered
// with their sizes, and the one picked fetched by Mergelane's own downloader over the networks
// chosen, each with the addresses it asked for itself, then joined by FFmpeg. Nothing here talks
// to YouTube.

import { rmSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartStreamDownloadRequest } from '../src/shared/types'
import { YOUTUBE_PLAYLIST } from '../src/shared/youtube'
import { expect, expectStream, LAN_ADDRESS, test, type MergelaneApp } from './fixtures'
import { APP_FFMPEG, NEEDS_FFMPEG, inspect } from './streamMedia'
import {
  FORMAT_HEADERS,
  FakeYtDlp,
  YT_SECONDS,
  YoutubeServer,
  mediaSizes,
  removeYoutubeMedia,
  videoInfo,
  youtubeMedia
} from './youtubeFake'

/** One fake yt-dlp per test worker, in a folder fixed before the app starts (its path goes in the
 * app's environment). Made again before each test: fully parallel, a worker can be handed more of
 * this file's tests after its afterAll removed it. */
const FAKE_DIR = join(tmpdir(), `mergelane-yt-app-${process.pid}`)
/** Made in beforeEach, never as the file loads: the runner loads it too, only to list its tests. */
let fake: FakeYtDlp

const ID = {
  card: 'testcardvid',
  signIn: 'signinsign1',
  live: 'livelivelve'
}
const watch = (id: string): string => `https://www.youtube.com/watch?v=${id}`
const CHUNK = 4096
const SIGN_IN =
  'This video needs a sign-in. Mergelane only downloads videos anyone can watch without signing in.'

test.use({
  appEnv: {
    MERGELANE_FFMPEG_PATH: APP_FFMPEG ?? '',
    MERGELANE_YTDLP_PATH: join(FAKE_DIR, 'yt-dlp'),
    MERGELANE_DENO_PATH: join(FAKE_DIR, 'deno')
  }
})

let server: YoutubeServer
test.beforeEach(async () => {
  if (NEEDS_FFMPEG) return
  server = await new YoutubeServer(await youtubeMedia()).start()
  fake = new FakeYtDlp(FAKE_DIR)
  fake.serve(server)
  fake.set(ID.card, { info: await videoInfo(ID.card, { title: 'Test card', chunk: CHUNK }) })
  fake.set(ID.signIn, { stderr: `ERROR: [youtube] ${ID.signIn}: Sign in to confirm your age` })
  fake.set(ID.live, { info: await videoInfo(ID.live, { live: 'is_live' }) })
})
test.afterEach(async () => server?.stop())
test.afterAll(async () => {
  await removeYoutubeMedia()
  rmSync(FAKE_DIR, { recursive: true, force: true })
})

/** Checks `link` and starts quality `variantId` as New download's Download button does. */
async function startYoutube(
  app: MergelaneApp,
  link: string,
  options: { networks?: string[]; variantId?: string } = {}
): Promise<string> {
  await app.api.listInterfaces()
  const probe = await app.api.probeUrl(link)
  if (probe.kind !== 'stream') throw new Error(`Expected a stream, got ${probe.kind}`)
  const request: StartStreamDownloadRequest = {
    kind: 'stream',
    url: probe.finalUrl,
    protocol: probe.stream.protocol,
    variantId: options.variantId ?? probe.stream.variants[0].id,
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

const rangeStart = (range: string | undefined): number =>
  Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1])

/** Every file under `dir`, read as text. */
async function textsUnder(dir: string): Promise<string[]> {
  const texts: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if ((await stat(path)).size < 1_000_000) texts.push(await readFile(path, 'utf8'))
  }
  return texts
}

test.describe('YouTube downloads @smoke', () => {
  test.skip(!!NEEDS_FFMPEG, NEEDS_FFMPEG)

  test('a pasted YouTube link offers its qualities with their sizes, and downloads the one picked', async ({
    mergelane,
    dirs
  }) => {
    const { page } = mergelane
    // Saved in the test's folder, never the computer's Downloads: its folder dialog answers so.
    await mergelane.evaluateMain(({ dialog }, dest) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    }, dirs.dest)
    fake.set(ID.card, {
      info: await videoInfo(ID.card, { title: 'Test card', chunk: CHUNK }),
      // Slow enough to see what the window says while yt-dlp looks.
      delayMs: 1500
    })
    const link = await mergelane.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(`https://youtu.be/${ID.card}?si=shared`)
    await expect(
      page.getByText('Asking YouTube about this video… it can take a minute.')
    ).toBeVisible()
    const quality = page.getByRole('group', { name: 'Quality' })
    const best = quality.getByRole('button', { name: '240p' })
    const low = quality.getByRole('button', { name: '120p' })
    await expect(best).toHaveAttribute('aria-pressed', 'true')
    // Only qualities Mergelane may download: not the DRM ones (480p, 720p).
    await expect(quality.getByRole('button')).toHaveText(['240p', '120p'])
    await expect(page.getByRole('textbox', { name: 'File name' })).toHaveValue('Test card')
    const sizes = await mediaSizes()
    const sizeText = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
    await expect(
      page.getByText(sizeText(sizes['v240.mp4'] + sizes['a.m4a']), { exact: false })
    ).toBeVisible()
    await expect(page.getByText('from YouTube', { exact: false })).toBeVisible()
    await low.click()
    await expect(
      page.getByText(sizeText(sizes['v120.mp4'] + sizes['a.m4a']), { exact: false })
    ).toBeVisible()
    // Slow enough for its own screen to be seen while it downloads, with the source beside its
    // name.
    server.delayMs = 150
    await page.getByRole('button', { name: 'Download' }).click()
    // In its row, and in its details beside the list in a wide window.
    await expect(page.getByText('YouTube', { exact: true }).first()).toBeVisible()

    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(done.protocol).toBe('youtube')
    expect(done.quality).toBe('120p')
    expect(done.url).toBe(watch(ID.card))
    expect(done.destinationPath).toBe(join(dirs.dest, 'Test card.mp4'))
    expect(done.bytesDownloaded).toBe(sizes['v120.mp4'] + sizes['a.m4a'])
    expect(await readdir(dirs.dest)).toEqual(['Test card.mp4'])
    const media = await inspect(done.destinationPath)
    expect([media.video, media.audio, media.size]).toEqual([['h264'], ['aac'], '160x120'])
    expect(media.duration).toBeGreaterThan(YT_SECONDS - 1)

    // Only the picked quality's files, in ranges of yt-dlp's chunk at most, with the format's
    // headers.
    const served = server.served()
    expect(new Set(served.map((entry) => entry.file))).toEqual(new Set(['v120.mp4', 'a.m4a']))
    expect(served.every((entry) => entry.userAgent === FORMAT_HEADERS['User-Agent'])).toBe(true)
    for (const entry of served) {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(entry.range ?? '')!.map(Number)
      expect(end - start + 1).toBeLessThanOrEqual(CHUNK)
    }
    // yt-dlp ran once for New download (straight), then once per network the download used
    // (through that network's pinned proxy); each time with the safety flags, our Deno and the
    // watch page only.
    const networks = done.networks.filter((network) => network.enabled).length
    const calls = fake.calls(ID.card)
    expect(calls).toHaveLength(1 + networks)
    for (const call of calls) {
      expect(call.argv.slice(0, 5)).toEqual([
        '--ignore-config',
        '--no-plugin-dirs',
        '--no-cookies',
        '--no-cookies-from-browser',
        '--no-cache-dir'
      ])
      expect(call.argv.at(-1)).toBe(watch(ID.card))
      expect(call.argv[call.argv.indexOf('--js-runtimes') + 1]).toBe(`deno:${fake.deno}`)
    }
    const proxies = calls.map((call) => call.argv[call.argv.indexOf('--proxy') + 1])
    expect(proxies[0]).toBe('')
    for (const proxy of proxies.slice(1)) expect(proxy).toMatch(/^http:\/\/mergelane:/)
    const [entry] = await mergelane.api.listHistory()
    expect(entry).toMatchObject({ kind: 'stream', protocol: 'youtube', quality: '120p' })
  })

  test('playlists, sign-in videos and live streams are refused in plain words', async ({
    mergelane
  }) => {
    const { page } = mergelane
    const link = await mergelane.newDownload()
    await link.fill('https://www.youtube.com/playlist?list=PL0123456789')
    await expect(page.getByText(YOUTUBE_PLAYLIST)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download' })).toBeDisabled()
    await link.fill(watch(ID.signIn))
    await expect(page.getByText(SIGN_IN)).toBeVisible()
    await expect(mergelane.api.probeUrl(watch(ID.live))).rejects.toThrow(
      /This is a live stream that is still being broadcast/
    )
    // Nothing was downloaded, and no playlist was ever handed to yt-dlp.
    expect(server.log).toEqual([])
    expect(fake.calls().map((call) => call.id)).toEqual([ID.signIn, ID.live])
  })

  test('two networks: each asks YouTube for its own addresses and fetches with them', async ({
    mergelane
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    await startYoutube(mergelane, watch(ID.card), { networks: ['a', 'b'] })
    const done = expectStream(await mergelane.waitForStatus('completed'))
    const served = server.served()
    expect(new Set(served.map((entry) => entry.from))).toEqual(new Set(['127.0.0.1', LAN_ADDRESS]))
    expect(served.every((entry) => entry.ip === entry.from)).toBe(true)
    expect(server.log.some((entry) => entry.status === 403)).toBe(false)
    expect(
      done.networks
        .filter((network) => network.bytesDownloaded > 0)
        .map((n) => n.id)
        .sort()
    ).toEqual(['a', 'b'])
    // New download's look, then one per network.
    expect(fake.calls(ID.card)).toHaveLength(3)
  })

  test('refused mid-download (403), the network asks again and it finishes', async ({
    mergelane
  }) => {
    let honoured = 0
    // The addresses of yt-dlp's second run (the network's own) stop working after a few parts.
    server.refuse = (entry) => entry.gen === 2 && ++honoured > 3
    await startYoutube(mergelane, watch(ID.card))
    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(server.log.some((entry) => entry.status === 403)).toBe(true)
    expect(fake.calls(ID.card).length).toBeGreaterThanOrEqual(3)
    expect((await inspect(done.destinationPath)).video).toEqual(['h264'])
  })

  test('quit mid-download, it keeps no signed address; relaunched, it asks again and fetches only the rest', async ({
    mergelane,
    dirs
  }) => {
    server.hold = (entry) => rangeStart(entry.range) >= 2 * CHUNK
    const id = await startYoutube(mergelane, watch(ID.card))
    await waitFor(() => server.log.filter((entry) => entry.held && !entry.endedAt).length >= 4)
    await mergelane.quit()
    // Saved: the watch page and the formats picked, never the addresses YouTube gave.
    const saved = (await textsUnder(dirs.userData)).join('\n')
    expect(saved).toContain(watch(ID.card))
    expect(saved).toContain('"variantId":"133+140"')
    expect(saved).not.toContain('videoplayback')
    expect(saved).not.toContain('sig=fake')

    const asked = fake.calls(ID.card).length
    const relaunchedAt = Date.now()
    server.release()
    await mergelane.relaunch()
    const restored = expectStream((await mergelane.byId(id))!)
    expect(restored.status).toBe('paused')
    await mergelane.api.resumeDownload(id)
    const done = expectStream(await mergelane.waitForStatus('completed'))
    expect(fake.calls(ID.card).length).toBe(asked + 1)
    expect(
      server
        .served()
        .filter((entry) => entry.at >= relaunchedAt && rangeStart(entry.range) < 2 * CHUNK)
    ).toEqual([])
    const media = await inspect(done.destinationPath)
    expect([media.video, media.audio]).toEqual([['h264'], ['aac']])
  })
})
