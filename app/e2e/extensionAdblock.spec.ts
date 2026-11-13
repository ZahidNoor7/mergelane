import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ASK } from '../extension/src/ask'
import { CHROME_EXTENSION_ID } from '../src/shared/browserBridge'

/** The extension API these tests call inside the browser (in functions Playwright runs there, so
 * each reaches it itself), where `chrome` is the real thing: the e2e config has no extension types. */
interface ExtensionApi {
  tabs: { query(query: object): Promise<{ id?: number; url?: string }[]> }
  runtime: { sendMessage(message: object): Promise<unknown> }
  action: { getBadgeText(details: { tabId: number }): Promise<string> }
  storage: { session: { get(key: string): Promise<Record<string, unknown>> } }
}

// Ad blocking in the browser extension (ADR-0063): uBO Lite's pinned build, merged into Mergelane's
// extension, in Chromium. No app and no native host are needed. Chromium resolves a site, an ad
// server named in the default filter lists (2mdn.net, in Peter Lowe's list) and a site on uBlock's
// badware list (007itshop.com) to a local server, so nothing leaves the machine, and the server
// records which requests reached it. The tests run in order in one browser: the last one checks that
// nothing before it left an error behind.
test.describe.configure({ mode: 'serial' })

const PROJECT_ROOT = resolve(__dirname, '..')
const AD_HOST = 'ads.2mdn.net'
const SITE = 'site.test'
const BADWARE_HOST = '007itshop.com'
// An element EasyList's generic rules hide ("#AdBillboard"), next to the page's own content. uBO Lite
// applies generic hiding rules only in its "complete" mode; its default, "optimal", hides with rules
// written for particular sites.
const SITE_PAGE =
  '<!doctype html><title>A site with ads</title><p id="story">Story</p><div id="AdBillboard">An ad box</div>'

let work: string
let browser: BrowserContext
let server: Server
let port: number
const reached: string[] = []
/** Errors on the extension's own pages (popup, options, uBO Lite's settings and block pages). */
const pageErrors: string[] = []

function watchErrors(page: Page): Page {
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`${page.url()}: ${message.text()}`)
  })
  return page
}

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'mergelane-adblock-'))
  const extension = join(work, 'extension')
  // Its own copy, so another spec's rebuild never pulls the extension out from under this one.
  execFileSync('node', ['extension/build.mjs', extension], { cwd: PROJECT_ROOT, stdio: 'inherit' })

  server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0]
    reached.push(`${host}${request.url}`)
    if (host === SITE && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(SITE_PAGE)
      return
    }
    response.writeHead(200, {
      'content-type': 'text/javascript',
      'access-control-allow-origin': '*'
    })
    response.end('// an ad\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  port = (server.address() as AddressInfo).port

  const profile = join(work, 'profile')
  // Anything the browser keeps lands here, never in ~/Downloads (as extension.spec.ts does).
  const home = join(profile, 'home')
  mkdirSync(join(home, 'Downloads'), { recursive: true })
  mkdirSync(join(profile, 'Default'), { recursive: true })
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: join(profile, 'downloads') } })
  )
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${join(extension, 'chrome')}`,
      `--load-extension=${join(extension, 'chrome')}`,
      `--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${AD_HOST} 127.0.0.1, MAP ${BADWARE_HOST} 127.0.0.1`
    ],
    env: { ...(process.env as Record<string, string>), HOME: home, CFFIXED_USER_HOME: home }
  })
  // Both backgrounds load in one service worker.
  if (browser.serviceWorkers().length === 0) await browser.waitForEvent('serviceworker')
})

test.afterAll(async () => {
  await browser?.close()
  await new Promise((done) => server?.close(done))
  rmSync(work, { recursive: true, force: true })
})

/** Whether the page can fetch from the ad server: 'ok', or 'blocked' when the request failed. A
 * page that is reloading at that moment counts as neither. */
async function adFetch(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      (url) =>
        fetch(url).then(
          () => 'ok',
          () => 'blocked'
        ),
      `http://${AD_HOST}:${port}/banner.js`
    )
  } catch {
    return 'reloading'
  }
}

const adRequests = (): number => reached.filter((line) => line.startsWith(AD_HOST)).length

async function sitePage(): Promise<{ page: Page; tabId: number }> {
  const page = await browser.newPage()
  await page.goto(`http://${SITE}:${port}/`)
  const [worker] = browser.serviceWorkers()
  const tabId = await worker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url === url)?.id ?? -1
  }, page.url())
  expect(tabId).toBeGreaterThan(0)
  return { page, tabId }
}

test('the extension blocks a request to an ad server and lets the site load', async () => {
  const { page } = await sitePage()
  const before = adRequests()
  // uBO Lite's rules are on from the start; poll while its background finishes starting.
  await expect.poll(() => adFetch(page)).toBe('blocked')
  expect(adRequests()).toBe(before)
  expect(reached).toContain(`${SITE}/`)
  await page.close()
})

test("Mergelane's messages and uBO Lite's share the extension", async () => {
  const { page, tabId } = await sitePage()
  const popup = watchErrors(await browser.newPage())
  await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html?tab=${tabId}`)
  const answers = await popup.evaluate(
    async ({ tab, what }) => {
      const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
      return {
        // Mergelane's background: the tab's video list (none on this page).
        media: await chrome.runtime.sendMessage({ what, mediaOf: tab }),
        // uBO Lite's background: the blocking level sites get.
        level: await chrome.runtime.sendMessage({ what: 'getDefaultFilteringMode' })
      }
    },
    { tab: tabId, what: ASK }
  )
  expect(answers).toEqual({ media: null, level: 2 })
  await popup.close()
  await page.close()
})

test('the popup turns ad blocking off for one site, and back on', async () => {
  const { page, tabId } = await sitePage()
  await expect.poll(() => adFetch(page)).toBe('blocked')

  const popup = watchErrors(await browser.newPage())
  await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html?tab=${tabId}`)
  const toggle = popup.getByRole('switch', { name: /Block ads on this site/ })
  const hint = popup.locator('#block-hint')
  await expect(toggle).toBeChecked()
  await expect(hint).toHaveText('Ads and trackers are blocked here.')

  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(hint).toHaveText('Ads load as usual on this site.')
  // The tab reloads, and the site's requests to the ad server now go through.
  const before = adRequests()
  await expect.poll(() => adFetch(page)).toBe('ok')
  expect(adRequests()).toBeGreaterThan(before)

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(hint).toHaveText('Ads and trackers are blocked here.')
  await expect.poll(() => adFetch(page)).toBe('blocked')

  await popup.close()
  await page.close()
})

test('the settings page opens as Mergelane, with uBO Lite credited', async () => {
  const options = watchErrors(await browser.newPage())
  await options.goto(`chrome-extension://${CHROME_EXTENSION_ID}/options.html`)
  await expect(
    options.getByText(/uBO Lite by Raymond Hill and contributors, GPL-3\.0/)
  ).toBeVisible()
  const opened = browser.waitForEvent('page')
  await options.getByRole('button', { name: 'Ad-blocking settings' }).click()
  const dashboard = watchErrors(await opened)
  await dashboard.waitForLoadState()
  expect(dashboard.url()).toBe(`chrome-extension://${CHROME_EXTENSION_ID}/dashboard.html`)
  await expect(dashboard).toHaveTitle(/Mergelane/)
  await expect(dashboard.locator('img[alt="Mergelane"]')).toHaveCount(1)
  await dashboard.close()
  await options.close()
})

test('the scripts that hide ad boxes are registered for every site', async () => {
  const [worker] = browser.serviceWorkers()
  const scripts = await worker.evaluate(async () => {
    const { chrome } = globalThis as unknown as {
      chrome: {
        scripting: { getRegisteredContentScripts(): Promise<{ id: string; matches?: string[] }[]> }
      }
    }
    return chrome.scripting.getRegisteredContentScripts()
  })
  const byId = new Map(scripts.map((script) => [script.id, script.matches]))
  // Site-specific hiding, and the scriptlets, on every site at the default level.
  for (const id of ['css-specific', 'scriptlets-isolated', 'scriptlets-main']) {
    expect(byId.get(id), id).toContain('<all_urls>')
  }
})

test("at the complete level, hides an ad box the page draws and leaves the page's own content", async () => {
  const { page } = await sitePage()
  await expect(page.locator('#AdBillboard')).toBeVisible()
  const popup = watchErrors(await browser.newPage())
  await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html`)
  // What uBO Lite's settings page sends when the user picks "complete" for a site.
  const level = await popup.evaluate(
    (hostname) =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({
        what: 'setFilteringMode',
        hostname,
        level: 3
      }),
    SITE
  )
  expect(level).toBe(3)
  await page.reload()
  await expect(page.locator('#AdBillboard')).toBeHidden()
  await expect(page.locator('#story')).toBeVisible()
  // Back to the default, so the tests after this one see the site as a user first would.
  await popup.evaluate(
    (hostname) =>
      (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({
        what: 'setFilteringMode',
        hostname,
        level: 2
      }),
    SITE
  )
  await popup.close()
  await page.close()
})

test('the toolbar badge does not count blocked requests: it stays for the videos Mergelane finds', async () => {
  const { page, tabId } = await sitePage()
  await expect.poll(() => adFetch(page)).toBe('blocked')
  const [worker] = browser.serviceWorkers()
  const badge = await worker.evaluate(async (tab) => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    return chrome.action.getBadgeText({ tabId: tab })
  }, tabId)
  expect(badge).toBe('')
  await page.close()
})

test('a site on the badware list is stopped before it loads, on a page that says Mergelane', async () => {
  const page = watchErrors(await browser.newPage())
  await page.goto(`http://${BADWARE_HOST}:${port}/`).catch(() => {})
  await expect(page).toHaveURL(
    new RegExp(`^chrome-extension://${CHROME_EXTENSION_ID}/strictblock\\.html`)
  )
  await expect(
    page.getByText('Mergelane has prevented the following page from loading')
  ).toBeVisible()
  expect(reached.some((line) => line.startsWith(BADWARE_HOST))).toBe(false)
  await page.close()
})

test("the popup offers no ad-blocking switch on the browser's own pages", async () => {
  const options = await browser.newPage()
  await options.goto(`chrome-extension://${CHROME_EXTENSION_ID}/options.html`)
  const [worker] = browser.serviceWorkers()
  const tabId = await worker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    return (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? -1
  }, options.url())
  const popup = watchErrors(await browser.newPage())
  await popup.goto(`chrome-extension://${CHROME_EXTENSION_ID}/popup.html?tab=${tabId}`)
  await expect(popup.getByRole('switch', { name: 'Capture downloads' })).toBeVisible()
  await expect(popup.locator('#blocking')).toBeHidden()
  await popup.close()
  await options.close()
})

test("nothing above left an error: uBO Lite's log and the extension's pages are clean", async () => {
  const [worker] = browser.serviceWorkers()
  const log = await worker.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: ExtensionApi }
    return (await chrome.storage.session.get('console')).console ?? []
  })
  expect(log).toEqual([])
  expect(pageErrors).toEqual([])
})
