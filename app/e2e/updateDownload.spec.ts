import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type MergelaneApp } from './fixtures'

// An update's download (M3.2 pull request b, docs/DECISIONS.md ADR-0036), in the real app, from a
// local server standing in for GitHub: the disk image is downloaded, checked against the release's
// SHA256SUMS, and "opened" — a test run writes the path it would open to a file instead of opening it
// and quitting, so nothing is ever opened on the Mac.

const IMAGE = randomBytes(3 * 1024 * 1024)
const NAME = 'Mergelane-9.0.0-arm64.dmg'
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

let server: Server
let origin: string
/** What SHA256SUMS says the image's hash is. */
let published = sha(IMAGE)
/** Whether the image is sent slowly, so a test can cancel it mid-way. */
let slow = false
let slowResponse: ServerResponse | null = null

function releases(): unknown {
  return [
    {
      tag_name: 'v9.0.0',
      draft: false,
      prerelease: false,
      published_at: '2026-11-19T12:00:00Z',
      html_url: 'https://github.com/ZahidNoor7/mergelane/releases/tag/v9.0.0',
      body: "## What's new\n\n- Downloads updates itself\n",
      assets: [
        { name: NAME, size: IMAGE.length, browser_download_url: `${origin}/${NAME}` },
        { name: 'SHA256SUMS', size: 100, browser_download_url: `${origin}/SHA256SUMS` }
      ]
    }
  ]
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/releases') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(releases()))
    } else if (request.url === '/SHA256SUMS') {
      response.end(`${published}  ${NAME}\n${'0'.repeat(64)}  other.zip\n`)
    } else if (request.url === `/${NAME}`) {
      response.writeHead(200, { 'content-length': IMAGE.length })
      if (!slow) return void response.end(IMAGE)
      // A first part, then nothing until the test is done with it.
      response.write(IMAGE.subarray(0, 64 * 1024))
      slowResponse = response
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  slowResponse?.destroy()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})
test.beforeEach(() => {
  published = sha(IMAGE)
  slow = false
  slowResponse = null
})

async function launch(
  mergelane: MergelaneApp,
  openLog: string,
  extra: Record<string, string> = {}
): Promise<void> {
  await mergelane.relaunch({
    MERGELANE_E2E_RELEASES_URL: `${origin}/releases`,
    MERGELANE_E2E_UPDATE_VERSION: '2.0.0',
    MERGELANE_E2E_UPDATE_FIRST_CHECK_MS: '600000',
    MERGELANE_E2E_UPDATE_OPEN_LOG: openLog,
    ...extra
  })
}

async function openUpdates(mergelane: MergelaneApp): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Updates' })
    .click()
}

const updatesDir = (userData: string): string => join(userData, 'updates')

test.describe('Update download @smoke', () => {
  test('downloads the disk image, checks it, and opens it on Quit and install', async ({
    mergelane,
    dirs
  }) => {
    const openLog = join(dirs.userData, '..', 'opened.txt')
    await launch(mergelane, openLog)
    await openUpdates(mergelane)
    const page = mergelane.page
    const status = page.getByRole('region', { name: 'Mergelane version' }).getByRole('status')
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await page.getByRole('button', { name: 'Download and install' }).click()
    await expect(status).toContainText('9.0.0 is ready to install')

    // Checked, and kept under its own name; nothing half-written is left.
    const image = join(updatesDir(dirs.userData), NAME)
    expect(sha(await readFile(image))).toBe(sha(IMAGE))
    expect(await readdir(updatesDir(dirs.userData))).toEqual([NAME])

    // The sidebar says so too.
    await mergelane.place('Downloads')
    await expect(page.getByText('is ready to install.')).toBeVisible()
    await page.getByRole('button', { name: 'Install…' }).click()
    await page.getByRole('button', { name: 'Quit and install' }).click()
    await expect.poll(() => readFile(openLog, 'utf8').catch(() => '')).toBe(`${image}\n`)
  })

  test('a disk image that doesn’t match its checksum is deleted, and can be tried again', async ({
    mergelane,
    dirs
  }) => {
    published = 'f'.repeat(64)
    await launch(mergelane, join(dirs.userData, '..', 'opened.txt'))
    await mergelane.api.checkForUpdates()
    await mergelane.api.downloadUpdate()
    const state = await mergelane.api.updateState()
    expect(state).toMatchObject({ status: 'error', latest: { version: '9.0.0' } })
    expect(state.error).toMatch(/didn’t match the checksum/)
    expect(await readdir(updatesDir(dirs.userData))).toEqual([])

    published = sha(IMAGE)
    await mergelane.api.downloadUpdate()
    expect((await mergelane.api.updateState()).status).toBe('ready')
  })

  test('Cancel stops the download and leaves nothing behind', async ({ mergelane, dirs }) => {
    slow = true
    await launch(mergelane, join(dirs.userData, '..', 'opened.txt'))
    await openUpdates(mergelane)
    const page = mergelane.page
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await page.getByRole('button', { name: 'Download and install' }).click()
    await expect(page.getByRole('progressbar', { name: 'Downloading 9.0.0' })).toBeVisible()
    await expect.poll(() => slowResponse !== null).toBe(true)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('button', { name: 'Download and install' })).toBeVisible()
    await expect.poll(() => readdir(updatesDir(dirs.userData))).toEqual([])
  })

  test('downloads by itself when asked to, and an old disk image is cleared at launch', async ({
    mergelane,
    dirs
  }) => {
    // Left from an earlier launch.
    await mkdir(updatesDir(dirs.userData), { recursive: true })
    await writeFile(join(updatesDir(dirs.userData), 'Mergelane-1.0.0-arm64.dmg'), 'old')
    await mergelane.quit()
    const settings = join(dirs.userData, 'app-settings.json')
    const saved = existsSync(settings) ? JSON.parse(await readFile(settings, 'utf8')) : {}
    await writeFile(settings, JSON.stringify({ ...saved, updateBackgroundDownload: true }))
    await launch(mergelane, join(dirs.userData, '..', 'opened.txt'), {
      MERGELANE_E2E_UPDATE_FIRST_CHECK_MS: '200'
    })
    await expect.poll(async () => (await mergelane.api.updateState()).status).toBe('ready')
    expect(await readdir(updatesDir(dirs.userData))).toEqual([NAME])
    // Installing still waits for the user.
    expect(existsSync(join(dirs.userData, '..', 'opened.txt'))).toBe(false)
  })
})
