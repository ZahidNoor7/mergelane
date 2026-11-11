import { readFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from './fixtures'

// Mergelane's update check (M3.2 pull request a, docs/DECISIONS.md ADR-0036), in the real app, against
// a local server answering as GitHub's "List releases" does. A test run never asks GitHub itself.

const release = (tag: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-11-19T12:00:00Z',
  html_url: `https://github.com/ZahidNoor7/mergelane/releases/tag/${tag}`,
  body: `## What's new\n\nFaster everything.\n\n### Added\n\n- A thing in ${tag}\n\n## Install\n\n- Drag it`,
  assets: [
    {
      name: `Mergelane-${tag.slice(1)}-arm64.dmg`,
      size: 200_000_000,
      browser_download_url: `https://github.com/x/${tag}.dmg`
    }
  ],
  ...fields
})

const RELEASES = [
  release('v1.0.0'),
  release('v9.0.0'),
  release('v9.1.0-beta.1', { prerelease: true }),
  release('v10.0.0', { draft: true })
]

let server: Server
let base: string
let answer: { status: number; body: unknown } = { status: 200, body: RELEASES }
let asked: IncomingHttpHeaders[] = []

test.beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push(request.headers)
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`
})
test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})
test.beforeEach(() => {
  answer = { status: 200, body: RELEASES }
  asked = []
})

const ENV = { MERGELANE_E2E_UPDATE_VERSION: '2.0.0', MERGELANE_E2E_UPDATE_FIRST_CHECK_MS: '600000' }

test.describe('Updates @smoke', () => {
  test('checks on request, offers the newest on the channel, skips one, and keeps the choices', async ({
    mergelane,
    dirs
  }) => {
    await mergelane.relaunch({ ...ENV, MERGELANE_E2E_RELEASES_URL: base })
    const page = mergelane.page
    await mergelane.openSettings()
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Updates' })
      .click()
    const status = page.getByRole('region', { name: 'Mergelane version' }).getByRole('status')
    await expect(status).toContainText('Not checked yet')
    await expect(page.getByText('Version 2.0.0, stable channel')).toBeVisible()

    await page.getByRole('button', { name: 'Check for updates' }).click()
    // The draft (10.0.0) and the beta are left out on Stable.
    await expect(status).toContainText('Mergelane 9.0.0 is available')
    await expect(status).toContainText('A thing in v9.0.0')
    expect(asked[0]).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'user-agent': 'Mergelane/2.0.0'
    })

    // The sidebar tells of it elsewhere, and its Settings button leads back here.
    await mergelane.place('Downloads')
    await expect(page.getByText('is available.')).toBeVisible()
    await page.getByRole('button', { name: 'See what’s new' }).click()
    await expect(status).toContainText('Mergelane 9.0.0 is available')

    await page.getByRole('button', { name: 'Skip this version' }).click()
    await expect(status).toContainText('Skipped 9.0.0')
    await page.getByRole('button', { name: 'Beta' }).click()
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await expect(status).toContainText('Mergelane 9.1.0-beta.1 is available')
    await page.getByRole('switch', { name: 'Check for updates automatically' }).click()

    await expect
      .poll(async () =>
        JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
      )
      .toMatchObject({
        updateAutoCheck: false,
        updateChannel: 'beta',
        updateSkipped: '9.0.0',
        updateLastChecked: expect.any(Number)
      })
  })

  test('says why a check failed: GitHub busy, or unreachable', async ({ mergelane }) => {
    answer = { status: 403, body: { message: 'API rate limit exceeded' } }
    await mergelane.relaunch({ ...ENV, MERGELANE_E2E_RELEASES_URL: base })
    expect((await mergelane.api.checkForUpdates()).error).toBe(
      'GitHub asked Mergelane to wait. Try again in an hour.'
    )
    answer = { status: 500, body: {} }
    expect((await mergelane.api.checkForUpdates()).error).toBe(
      'GitHub answered 500. Try again later.'
    )
    answer = { status: 200, body: { not: 'a list' } }
    expect((await mergelane.api.checkForUpdates()).error).toBe(
      'Couldn’t reach GitHub. Check your connection and try again.'
    )
    answer = { status: 200, body: [release('v1.0.0')] }
    expect((await mergelane.api.checkForUpdates()).status).toBe('current')
  })

  test('checks by itself after launch when automatic checks are on', async ({ mergelane }) => {
    await mergelane.relaunch({
      ...ENV,
      MERGELANE_E2E_RELEASES_URL: base,
      MERGELANE_E2E_UPDATE_FIRST_CHECK_MS: '200'
    })
    await expect(mergelane.page.getByText('is available.')).toBeVisible()
    expect(asked).toHaveLength(1)
  })
})
