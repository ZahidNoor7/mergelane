import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID, NATIVE_HOST } from '../src/shared/browserBridge'
import { hostManifest } from '../src/main/nativeHost'
import { expect, PROJECT_ROOT, test } from './fixtures'

// The whole browser path (docs/BROWSER-BRIDGE.md): Chromium with the real extension, the real
// mergelane-nmhost (built here from daemon/), and the real app. Needs Go; tagged @extension.
// Named, not created, at load time: Playwright also loads this file just to list tests, and a folder
// made here would be left behind by that load. Short, for macOS's 104-byte socket paths.
const dir = `/tmp/mlext-${process.pid}`
const SOCKET = join(dir, 's')
const HOST_BINARY = join(dir, 'mergelane-nmhost')
const EXTENSION = join(PROJECT_ROOT, 'extension', 'dist', 'chrome')

test.use({ appEnv: { MERGELANE_E2E_BROWSER_SOCKET: SOCKET } })

let profile: string
let browser: BrowserContext
let worker: Worker

test.beforeAll(async () => {
  mkdirSync(dir, { recursive: true })
  execFileSync('go', ['build', '-o', HOST_BINARY, './cmd/mergelane-nmhost'], {
    cwd: join(PROJECT_ROOT, '..', 'daemon'),
    stdio: 'inherit'
  })
  execFileSync('node', ['extension/build.mjs'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
  profile = mkdtempSync(join(tmpdir(), 'mergelane-chromium-'))
  // A custom profile's own NativeMessagingHosts folder: Chrome looks up user-level hosts in the
  // profile directory (Chrome's native messaging docs), so nothing goes into ~/Library.
  mkdirSync(join(profile, 'NativeMessagingHosts'))
  // Anything the browser keeps lands here, never in ~/Downloads.
  mkdirSync(join(profile, 'Default'))
  mkdirSync(join(profile, 'downloads'))
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: join(profile, 'downloads'), prompt_for_download: false }
    })
  )
  // With only the preference, its folder not created, the handed-over download's temporary file
  // came and went in the owner's ~/Downloads on every run (2026-11-11). Now the folder exists, and
  // Chromium also gets a home of its own (HOME, and CFFIXED_USER_HOME for CoreFoundation, as
  // package-test.sh --local does: ADR-0033), which leaves the real ~/Downloads out of reach.
  const home = join(profile, 'home')
  mkdirSync(join(home, 'Downloads'), { recursive: true })
  writeFileSync(
    join(profile, 'NativeMessagingHosts', `${NATIVE_HOST}.json`),
    hostManifest(HOST_BINARY, false)
  )
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      CFFIXED_USER_HOME: home,
      MERGELANE_BROWSER_SOCKET: SOCKET,
      MERGELANE_NMHOST_NO_LAUNCH: '1'
    }
  })
  worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
})

test.afterAll(async () => {
  await browser?.close()
  rmSync(profile, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

const nativeMessage = (message: unknown): Promise<unknown> =>
  worker.evaluate(
    // Runs in the extension's service worker, where `chrome` is the extension API.
    ([host, body]) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendNativeMessage: (h: string, m: object) => Promise<unknown> } }
        }
      ).chrome.runtime.sendNativeMessage(host as string, body as object),
    [NATIVE_HOST, message] as const
  )

test.describe('Chrome extension through the native host @extension', () => {
  test.describe.configure({ mode: 'serial' })

  test('the manifest key gives the extension its fixed ID', async () => {
    expect(worker.url().split('/')[2]).toBe(CHROME_EXTENSION_ID)
  })

  test('the extension reaches the app through mergelane-nmhost', async ({ mergelane }) => {
    void mergelane
    await expect
      .poll(() => nativeMessage({ type: 'ping' }), { timeout: 15_000 })
      .toMatchObject({ ok: true, app: 'mergelane', api: 2 })
  })

  test('a download clicked in the browser is handed to Mergelane', async ({ mergelane, serve }) => {
    // Slow enough that the browser is still downloading when Mergelane answers: a download the
    // browser already finished stays with the browser, by design.
    const origin = await serve({
      size: 3 * 1024 * 1024,
      bytesPerSecond: 64 * 1024,
      contentDisposition: 'attachment; filename="handed.bin"'
    })
    await expect
      .poll(() => nativeMessage({ type: 'ping' }), { timeout: 15_000 })
      .toMatchObject({ ok: true })
    const page = await browser.newPage()
    // Playwright takes over the browser's downloads, which skips the filename step the extension
    // listens to (onDeterminingFilename); hand them back to Chromium for this test.
    const cdp = await browser.newCDPSession(page)
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' })
    await page.goto(`data:text/html,<a href="${origin.url()}" download>file</a>`)
    await page.getByRole('link', { name: 'file' }).click()
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(origin.url(), {
      timeout: 20_000
    })
    // The browser's own copy was cancelled and erased once Mergelane took it.
    await expect
      .poll(() =>
        worker.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: { downloads: { search: (q: object) => Promise<unknown[]> } }
            }
          ).chrome.downloads.search({})
        )
      )
      .toEqual([])
    await page.close()
  })
})
