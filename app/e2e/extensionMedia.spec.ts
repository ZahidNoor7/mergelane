import { expect as unitExpect, test as unit } from '@playwright/test'
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describe,
  manifestKind,
  MAX_MEDIA,
  mediaKey,
  samePage,
  withItem,
  type MediaItem
} from '../extension/src/media'
import { CHROME_EXTENSION_ID, NATIVE_HOST } from '../src/shared/browserBridge'
import { hostManifest } from '../src/main/nativeHost'
import { expect, PROJECT_ROOT, test } from './fixtures'

// Videos on this page (extension/src/mediaWatch.ts): the HLS and DASH manifests a page loads,
// listed in the popup and handed to Mergelane. Pure parts in Node; the rest in Chromium with the
// real extension, the real mergelane-nmhost (built here from daemon/) and the real app, as in
// extension.spec.ts. Needs Go; tagged @extension.

unit.describe('stream detection rules @extension', () => {
  unit('a manifest is known by its Content-Type, else by its extension', () => {
    unitExpect(manifestKind('https://cdn.test/a/master.m3u8', '')).toBe('HLS')
    unitExpect(manifestKind('https://cdn.test/a/MANIFEST.MPD', undefined)).toBe('DASH')
    unitExpect(manifestKind('https://cdn.test/play', 'application/vnd.apple.mpegurl')).toBe('HLS')
    unitExpect(manifestKind('https://cdn.test/play', 'application/x-mpegURL; charset=utf-8')).toBe(
      'HLS'
    )
    unitExpect(manifestKind('https://cdn.test/play', 'application/dash+xml')).toBe('DASH')
    // The server's word beats the name.
    unitExpect(manifestKind('https://cdn.test/a.m3u8', 'application/dash+xml')).toBe('DASH')
    // An error page at a manifest's address, plain audio playlists, and anything else: no.
    unitExpect(manifestKind('https://cdn.test/a.m3u8', 'text/html; charset=utf-8')).toBeNull()
    unitExpect(manifestKind('https://cdn.test/radio.m3u', 'audio/mpegurl')).toBeNull()
    unitExpect(manifestKind('https://cdn.test/video.mp4', 'video/mp4')).toBeNull()
    unitExpect(manifestKind('https://cdn.test/a.m3u8.js', '')).toBeNull()
    unitExpect(manifestKind('blob:https://cdn.test/1234.m3u8', '')).toBeNull()
    unitExpect(manifestKind('not a url .m3u8', '')).toBeNull()
  })

  unit('a stream is the same whatever its fragment or HLS delivery directives', () => {
    const key = mediaKey('https://cdn.test/live.m3u8?token=a')
    unitExpect(mediaKey('https://cdn.test/live.m3u8?token=a#t=3')).toBe(key)
    unitExpect(mediaKey('https://cdn.test/live.m3u8?_HLS_msn=5&token=a&_HLS_part=2')).toBe(key)
    unitExpect(mediaKey('https://cdn.test/live.m3u8?token=b')).not.toBe(key)
    unitExpect(mediaKey('not a url')).toBe('not a url')
  })

  unit('the same page is the same address up to its fragment', () => {
    unitExpect(samePage('https://site.test/watch?v=1', 'https://site.test/watch?v=1#t=9')).toBe(
      true
    )
    unitExpect(samePage('https://site.test/watch?v=1', 'https://site.test/watch?v=2')).toBe(false)
  })

  unit('the list skips repeats and stops at its limit', () => {
    const item = (n: number): MediaItem => ({ url: `https://cdn.test/${n}.m3u8`, kind: 'HLS' })
    let items: MediaItem[] = []
    for (let n = 0; n < MAX_MEDIA; n += 1) items = withItem(items, item(n)) ?? items
    unitExpect(items).toHaveLength(MAX_MEDIA)
    unitExpect(withItem(items, item(MAX_MEDIA))).toBeNull()
    unitExpect(withItem([item(1)], { url: 'https://cdn.test/1.m3u8#x', kind: 'HLS' })).toBeNull()
    unitExpect(withItem([item(1)], item(2))).toEqual([item(1), item(2)])
  })

  unit('the popup shows the host and a path that fits', () => {
    unitExpect(describe('https://cdn.test/v/master.m3u8?sig=1')).toEqual({
      host: 'cdn.test',
      path: '/v/master.m3u8'
    })
    unitExpect(
      describe('https://cdn.test/a/very/long/path/to/some/rendition/folder/index.m3u8')
    ).toEqual({ host: 'cdn.test', path: '…/index.m3u8' })
    unitExpect(describe('not a url')).toEqual({ host: 'not a url', path: '' })
  })
})

// Short, for the socket's path limit; made in beforeAll, so listing the tests leaves nothing.
const dir = `/tmp/mlmedia-${randomUUID().slice(0, 8)}`
const SOCKET = join(dir, 's')
const HOST_BINARY = join(dir, 'mergelane-nmhost')
// Its own build: extension.spec.ts rebuilds extension/dist, maybe while this one runs.
const EXTENSION = join(dir, 'extension', 'chrome')
// Names the tests need, all answered by the local server (Chromium's --host-resolver-rules).
const EXCLUDED_HOST = 'excluded.test'
const YOUTUBE_HOST = 'www.youtube.com'
const GOOGLEVIDEO_HOST = 'rr1---sn-test.googlevideo.com'

const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n'
const DASH_BODY =
  '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ' +
  'mediaPresentationDuration="PT4S" minBufferTime="PT2S" ' +
  'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period/></MPD>\n'

// A page that fetches each `load` URL in turn, as a player fetches its manifest, then says so in
// its title. Each answer is fully received before the next request starts.
const PAGE = `<!doctype html><title>loading</title><script>
(async () => {
  for (const url of new URLSearchParams(location.search).getAll('load')) {
    try { await (await fetch(url, { cache: 'no-store' })).text() } catch {}
  }
  document.title = 'loaded'
})()
</script>`

let server: Server
let port: number
/** Host and path of every manifest the server answered. */
const served: string[] = []
let profile: string
let browser: BrowserContext
let worker: Worker
/** Pages a test opened, closed after it. */
const opened: Page[] = []

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    const headers = {
      'Cache-Control': 'no-store',
      // The page on 127.0.0.1 also reads manifests from the other test hosts.
      'Access-Control-Allow-Origin': '*'
    }
    if (url.pathname === '/page') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    } else if (url.pathname.startsWith('/media/')) {
      served.push(`${url.hostname}${url.pathname}`)
      // ?refuse: only the player gets it. Mergelane's check asks for a byte range, the page doesn't.
      if (url.searchParams.has('refuse') && request.headers.range) {
        response.writeHead(404, headers)
        response.end()
        return
      }
      const dash = url.pathname.endsWith('.mpd')
      // ?type= gives one the extension can know only by its Content-Type.
      const type =
        url.searchParams.get('type') ??
        (dash ? 'application/dash+xml' : 'application/vnd.apple.mpegurl')
      response.writeHead(200, { ...headers, 'Content-Type': type })
      response.end(dash ? DASH_BODY : HLS_BODY)
    } else {
      response.writeHead(404, headers)
      response.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve()
    })
  })
}

const at = (host: string, path: string): string => `http://${host}:${port}${path}`
/** The test page on `host`, loading each of `loads` in turn. */
const pageAt = (host: string, ...loads: string[]): string =>
  at(host, `/page?${loads.map((load) => `load=${encodeURIComponent(load)}`).join('&')}`)

interface Chrome {
  tabs: { query: (query: object) => Promise<{ id?: number; url?: string }[]> }
  action: {
    getBadgeText: (details: { tabId: number }) => Promise<string>
    getBadgeBackgroundColor: (details: { tabId: number }) => Promise<number[]>
    getBadgeTextColor: (details: { tabId: number }) => Promise<number[]>
  }
  storage: {
    local: { set: (items: object) => Promise<void> }
    session: { get: (key: string) => Promise<Record<string, unknown>> }
  }
  runtime: {
    sendNativeMessage: (host: string, message: object) => Promise<unknown>
    sendMessage: (message: object) => Promise<unknown>
  }
}

const nativeMessage = (message: unknown): Promise<unknown> =>
  worker.evaluate(
    ([host, body]) =>
      (globalThis as unknown as { chrome: Chrome }).chrome.runtime.sendNativeMessage(
        host as string,
        body as object
      ),
    [NATIVE_HOST, message] as const
  )

async function tabIdOf(page: Page): Promise<number> {
  const id = await worker.evaluate(
    async (url) =>
      (await (globalThis as unknown as { chrome: Chrome }).chrome.tabs.query({})).find(
        (tab) => tab.url === url
      )?.id,
    page.url()
  )
  expect(id).toBeDefined()
  return id as number
}

const badgeOf = (tabId: number): Promise<string> =>
  worker.evaluate(
    (id) => (globalThis as unknown as { chrome: Chrome }).chrome.action.getBadgeText({ tabId: id }),
    tabId
  )

/** The badge's background and text colours, as RGBA. */
const badgeColoursOf = (tabId: number): Promise<number[][]> =>
  worker.evaluate(async (id) => {
    const { action } = (globalThis as unknown as { chrome: Chrome }).chrome
    return [
      await action.getBadgeBackgroundColor({ tabId: id }),
      await action.getBadgeTextColor({ tabId: id })
    ]
  }, tabId)

const storedFor = (tabId: number): Promise<unknown> =>
  worker.evaluate(async (id) => {
    const key = `media:${id}`
    return (await (globalThis as unknown as { chrome: Chrome }).chrome.storage.session.get(key))[
      key
    ]
  }, tabId)

const setExcluded = (sites: string[]): Promise<void> =>
  worker.evaluate(
    (list) =>
      (globalThis as unknown as { chrome: Chrome }).chrome.storage.local.set({ sites: list }),
    sites
  )

/** popup.html for `tabId`, open in a tab of its own (the toolbar popup can't be driven). */
async function openPopup(tabId: number): Promise<Page> {
  const popup = await newPage()
  await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html?tab=${tabId}`)
  return popup
}

/** The background's list for `tabId`, once everything it has seen so far is on it. */
const listedBy = (popup: Page, tabId: number): Promise<unknown> =>
  popup.evaluate(
    (id) =>
      (globalThis as unknown as { chrome: Chrome }).chrome.runtime.sendMessage({ mediaOf: id }),
    tabId
  )

async function newPage(): Promise<Page> {
  const page = await browser.newPage()
  opened.push(page)
  return page
}

/** Opens `url` in a new tab and waits until its page has fetched everything it was told to. */
async function visit(url: string): Promise<{ page: Page; tabId: number }> {
  const page = await newPage()
  await page.goto(url)
  await expect(page).toHaveTitle('loaded')
  return { page, tabId: await tabIdOf(page) }
}

test.describe('Videos on this page @extension', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ appEnv: { MERGELANE_E2E_BROWSER_SOCKET: SOCKET } })

  test.beforeAll(async () => {
    mkdirSync(dir)
    execFileSync('go', ['build', '-o', HOST_BINARY, './cmd/mergelane-nmhost'], {
      cwd: join(PROJECT_ROOT, '..', 'daemon'),
      stdio: 'inherit'
    })
    execFileSync('node', ['extension/build.mjs', join(dir, 'extension')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    })
    await startServer()
    profile = mkdtempSync(join(tmpdir(), 'mergelane-chromium-'))
    // Chrome looks up user-level hosts in a custom profile's own NativeMessagingHosts folder
    // (Chrome's native messaging docs), so nothing goes into ~/Library.
    mkdirSync(join(profile, 'NativeMessagingHosts'))
    writeFileSync(
      join(profile, 'NativeMessagingHosts', `${NATIVE_HOST}.json`),
      hostManifest(HOST_BINARY, false)
    )
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        `--host-resolver-rules=${[EXCLUDED_HOST, YOUTUBE_HOST, GOOGLEVIDEO_HOST]
          .map((host) => `MAP ${host} 127.0.0.1`)
          .join(',')}`
      ],
      env: {
        ...(process.env as Record<string, string>),
        MERGELANE_BROWSER_SOCKET: SOCKET,
        MERGELANE_NMHOST_NO_LAUNCH: '1'
      }
    })
    worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
  })

  test.afterAll(async () => {
    await browser?.close()
    await new Promise((resolve) => server?.close(resolve))
    if (profile) rmSync(profile, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test.afterEach(async () => {
    await setExcluded([])
    for (const page of opened.splice(0)) await page.close()
  })

  test('a page’s HLS and DASH manifests are listed, and Download hands one to Mergelane', async ({
    mergelane
  }) => {
    const hls = at('127.0.0.1', '/media/show/master.m3u8')
    const dash = at('127.0.0.1', '/media/show/stream.mpd')
    const { tabId } = await visit(pageAt('127.0.0.1', hls, dash))
    const popup = await openPopup(tabId)
    const videos = popup.getByRole('region', { name: 'Videos on this page' })
    await expect(videos.getByRole('listitem')).toHaveText([
      /^HLS\s*127\.0\.0\.1\s*\/media\/show\/master\.m3u8\s*Download$/,
      /^DASH\s*127\.0\.0\.1\s*\/media\/show\/stream\.mpd\s*Download$/
    ])
    // The toolbar badge counts them, for this tab only, in the extension's accent (#b45309).
    expect(await badgeOf(tabId)).toBe('2')
    expect(await badgeColoursOf(tabId)).toEqual([
      [180, 83, 9, 255],
      [255, 255, 255, 255]
    ])

    await expect
      .poll(() => nativeMessage({ type: 'ping' }), { timeout: 15_000 })
      .toMatchObject({ ok: true, app: 'mergelane' })
    const download = videos.getByRole('button', {
      name: 'Download with Mergelane: HLS stream from 127.0.0.1'
    })
    await download.click()
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(hls, {
      timeout: 20_000
    })
    await expect(download).toHaveText('Sent')
    await expect(videos.getByRole('status')).toHaveText(
      'Sent to Mergelane. Finish in its New download window.'
    )
  })

  test('a manifest known by its Content-Type or its name is listed; repeats once; at most 20', async () => {
    const byType = at('127.0.0.1', '/media/play?type=application/x-mpegURL')
    // As many CDNs label them: only the name says what it is.
    const byName = at('127.0.0.1', '/media/cdn.m3u8?type=application/octet-stream')
    // An error page where a manifest was: not one.
    const errorPage = at('127.0.0.1', '/media/gone.mpd?type=text/html')
    const live = at('127.0.0.1', '/media/live.m3u8')
    const many = Array.from({ length: 25 }, (_, n) => at('127.0.0.1', `/media/v${n}.m3u8`))
    const { tabId } = await visit(
      pageAt(
        '127.0.0.1',
        byType,
        errorPage,
        byName,
        live,
        `${live}?_HLS_msn=4&_HLS_part=1`,
        `${live}?_HLS_msn=5`,
        byType,
        ...many
      )
    )
    const popup = await openPopup(tabId)
    const items = async (): Promise<{ url: string; kind: string }[]> =>
      ((await listedBy(popup, tabId)) as { items: { url: string; kind: string }[] } | null)
        ?.items ?? []
    await expect.poll(async () => (await items()).length).toBe(20)
    const listed = { items: await items() }
    expect(listed.items.slice(0, 4)).toEqual([
      { url: byType, kind: 'HLS' },
      { url: byName, kind: 'HLS' },
      { url: live, kind: 'HLS' },
      { url: many[0], kind: 'HLS' }
    ])
    expect(await badgeOf(tabId)).toBe('20')
  })

  test('a stream Mergelane can’t open says so, and can be tried again', async ({ mergelane }) => {
    void mergelane
    const refused = at('127.0.0.1', '/media/signed/master.m3u8?refuse')
    const { tabId } = await visit(pageAt('127.0.0.1', refused))
    const popup = await openPopup(tabId)
    await expect
      .poll(() => nativeMessage({ type: 'ping' }), { timeout: 15_000 })
      .toMatchObject({ ok: true, app: 'mergelane' })
    const videos = popup.getByRole('region', { name: 'Videos on this page' })
    const download = videos.getByRole('button', { name: /^Download with Mergelane: HLS/ })
    await download.click()
    await expect(videos.getByRole('status')).toHaveText(
      'Mergelane couldn’t open this stream. Reload the page and try again.',
      { timeout: 20_000 }
    )
    await expect(download).toHaveText('Download')
    await expect(download).not.toHaveAttribute('aria-disabled')
  })

  test('with Mergelane closed, Download offers to open it', async ({ mergelane }) => {
    const hls = at('127.0.0.1', '/media/closed/master.m3u8')
    const { tabId } = await visit(pageAt('127.0.0.1', hls))
    await mergelane.quit()
    const popup = await openPopup(tabId)
    const videos = popup.getByRole('region', { name: 'Videos on this page' })
    const download = videos.getByRole('button', { name: /^Download with Mergelane: HLS/ })
    await download.click()
    // The host is told not to start the app here (MERGELANE_NMHOST_NO_LAUNCH), so waking it gives
    // up after its 10 s.
    await expect(download).toHaveText('Sending…')
    await expect(download).toHaveAttribute('aria-busy', 'true')
    await expect(videos.getByRole('status')).toHaveText(
      'Mergelane isn’t open. Open it, then try again.',
      { timeout: 30_000 }
    )
    await expect(download).toHaveText('Download')
    await expect(popup.getByRole('button', { name: 'Open Mergelane' })).toBeVisible()
  })

  test('navigating the tab elsewhere, or closing it, clears its list', async () => {
    const hls = at('127.0.0.1', '/media/nav/master.m3u8')
    const { page, tabId } = await visit(pageAt('127.0.0.1', hls))
    const popup = await openPopup(tabId)
    const videos = popup.getByRole('region', { name: 'Videos on this page' })
    await expect(videos.getByRole('listitem')).toHaveCount(1)

    // Same page, another fragment: kept.
    await page.goto(`${page.url()}#later`)
    await expect(page).toHaveURL(/#later$/)
    expect(await listedBy(popup, tabId)).toMatchObject({ items: [{ url: hls }] })

    await page.goto(pageAt('127.0.0.1'))
    await expect(page).toHaveTitle('loaded')
    await expect(videos).toBeHidden()
    expect(await listedBy(popup, tabId)).toBeNull()
    await expect.poll(() => badgeOf(tabId)).toBe('')

    // A new page's streams are its own.
    const next = at('127.0.0.1', '/media/nav/next.mpd')
    await page.goto(pageAt('127.0.0.1', next))
    await expect(videos.getByRole('listitem')).toHaveText([/^DASH.*next\.mpd/])

    await page.close()
    await expect.poll(() => storedFor(tabId)).toBeUndefined()
  })

  test('streams on an excluded site are not listed, and excluding a site drops them', async () => {
    await setExcluded([EXCLUDED_HOST])
    // From an excluded host, on a page that isn't: skipped, and the next one still listed.
    const offSite = at(EXCLUDED_HOST, '/media/off/master.m3u8')
    const onSite = at('127.0.0.1', '/media/on/master.m3u8')
    const mixed = await visit(pageAt('127.0.0.1', offSite, onSite))
    const popup = await openPopup(mixed.tabId)
    await expect(
      popup.getByRole('region', { name: 'Videos on this page' }).getByRole('listitem')
    ).toHaveText([/127\.0\.0\.1/])
    expect(served).toContain(`${EXCLUDED_HOST}/media/off/master.m3u8`)

    // On an excluded page: nothing, though the page loaded both.
    const excluded = await visit(
      pageAt(EXCLUDED_HOST, '/media/page/master.m3u8', '/media/page/stream.mpd')
    )
    expect(served).toContain(`${EXCLUDED_HOST}/media/page/stream.mpd`)
    expect(await listedBy(popup, excluded.tabId)).toBeNull()
    expect(await badgeOf(excluded.tabId)).toBe('')

    // Turning a site off (the popup's switch, or Options) drops what it already listed.
    await setExcluded([EXCLUDED_HOST, '127.0.0.1'])
    await expect.poll(() => listedBy(popup, mixed.tabId)).toBeNull()
    await expect.poll(() => badgeOf(mixed.tabId)).toBe('')
  })

  test('YouTube and googlevideo streams are not listed (pending the owner’s decision)', async () => {
    const youtube = at(GOOGLEVIDEO_HOST, '/media/yt/manifest.m3u8')
    const control = at('127.0.0.1', '/media/yt-control/master.m3u8')
    const elsewhere = await visit(pageAt('127.0.0.1', youtube, control))
    const popup = await openPopup(elsewhere.tabId)
    await expect(
      popup.getByRole('region', { name: 'Videos on this page' }).getByRole('listitem')
    ).toHaveText([/yt-control/])
    expect(served).toContain(`${GOOGLEVIDEO_HOST}/media/yt/manifest.m3u8`)

    const onYoutube = await visit(pageAt(YOUTUBE_HOST, '/media/yt/watch.mpd'))
    expect(served).toContain(`${YOUTUBE_HOST}/media/yt/watch.mpd`)
    expect(await listedBy(popup, onYoutube.tabId)).toBeNull()
    expect(await badgeOf(onYoutube.tabId)).toBe('')
  })
})
