import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, test, type MergelaneApp } from './fixtures'

// Download history (docs/plans/2026-11-new-features-plan.md, feature 3; ADR-0080): every download
// started, in userData/mergelane.db, whether or not it is still in the list.

const SIZE = 8 * BLOCK

async function openHistory(mergelane: MergelaneApp): Promise<void> {
  await mergelane.page
    .getByRole('navigation', { name: 'Mergelane' })
    .getByRole('button', { name: 'History', exact: true })
    .click()
  await expect(mergelane.page.getByRole('heading', { name: 'History' })).toBeVisible()
}
const row = (mergelane: MergelaneApp, name: string): ReturnType<MergelaneApp['page']['locator']> =>
  mergelane.page.getByRole('main').getByRole('listitem').filter({ hasText: name })

test.describe('download history @smoke', () => {
  test('a download removed from the list stays in History, and downloads again from its whole link', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const link = origin.url('/files/kept.bin?Expires=1&Signature=whole')
    const id = await mergelane.start(link, origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    await mergelane.api.removeDownload(id)

    await openHistory(mergelane)
    await expect(row(mergelane, 'kept.bin')).toContainText('Not in the list')
    // The link it shows has no query; Download again gets the whole one.
    await row(mergelane, 'kept.bin')
      .getByRole('button', { name: 'Download kept.bin again' })
      .click()
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(link)
  })

  test('says which stopped, whose file is gone, and which are still in the list', async ({
    mergelane,
    serve
  }) => {
    const done = await serve({ size: SIZE, seed: 2 })
    const doneId = await mergelane.start(done.url('/files/gone.bin'), done.sha256)
    const finished = await mergelane.waitForHttpStatus('completed')
    await rm(finished.destinationPath)

    const slow = await serve({ size: 64 * BLOCK, seed: 3, bytesPerSecond: 64 * 1024 })
    const slowId = await mergelane.start(slow.url('/files/stopped.bin'), slow.sha256)
    await mergelane.waitUntil((state) => state.id === slowId && state.bytesDownloaded > 0)
    await mergelane.api.removeDownload(slowId)

    const live = await serve({ size: 64 * BLOCK, seed: 4, bytesPerSecond: 64 * 1024 })
    await mergelane.start(live.url('/files/running.bin'), live.sha256)

    await openHistory(mergelane)
    await expect(row(mergelane, 'gone.bin')).toContainText('File moved or deleted')
    await expect(row(mergelane, 'stopped.bin')).toContainText('Stopped, partial file removed')
    await expect(row(mergelane, 'running.bin')).toContainText(/In the list, \d+%/)
    void doneId

    // Filters and search.
    const page = mergelane.page
    const filter = page.getByRole('group', { name: 'Show in history' })
    await filter.getByRole('button', { name: /^File missing/ }).click()
    await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(1)
    await filter.getByRole('button', { name: /^All/ }).click()
    await page.getByRole('searchbox', { name: 'Search history' }).fill('stopped')
    await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(1)
    await expect(page.getByRole('main').getByRole('listitem')).toContainText('stopped.bin')
  })

  test('Clear history forgets what is no longer in the list, and nothing else', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const removed = await mergelane.start(origin.url('/files/one.bin'), origin.sha256)
    const first = await mergelane.waitForHttpStatus('completed')
    await mergelane.api.removeDownload(removed)
    await mergelane.start(origin.url('/files/two.bin'), origin.sha256)
    await mergelane.waitUntil(
      (state) => state.fileName === 'two.bin' && state.status === 'completed'
    )

    const forgotten = await mergelane.api.forgetHistory()
    expect(forgotten).toBe(1)
    const left = await mergelane.api.historyEntries()
    expect(left.map((entry) => entry.name)).toEqual(['two.bin'])
    // The file itself stays.
    expect(existsSync(first.destinationPath)).toBe(true)
  })

  test('kept 30 days, older ones no longer in the list are forgotten', async ({
    mergelane,
    dirs
  }) => {
    // From an older version: history.json, brought in once, then set aside.
    const old = Date.now() - 90 * 86_400_000
    const entry = (id: string, startedAt: number): Record<string, unknown> => ({
      id,
      kind: 'http',
      url: `https://example.com/${id}.iso?token=t`,
      fileName: `${id}.iso`,
      destinationPath: join(dirs.dest, `${id}.iso`),
      totalBytes: 10,
      bytesDownloaded: 10,
      speedBytesPerSec: 0,
      status: 'completed',
      startedAt,
      completedAt: startedAt + 1000,
      unitsWritten: 1,
      networks: []
    })
    await mergelane.quit()
    await writeFile(
      join(dirs.userData, 'history.json'),
      JSON.stringify([entry('recent', Date.now() - 86_400_000), entry('ancient', old)])
    )
    await mergelane.launch()
    expect((await mergelane.api.listHistory()).map((finished) => finished.fileName).sort()).toEqual(
      ['ancient.iso', 'recent.iso']
    )
    expect(existsSync(join(dirs.userData, 'history.json'))).toBe(false)
    expect(existsSync(join(dirs.userData, 'history.json.imported'))).toBe(true)

    // In the list, nothing is forgotten; out of it, past 30 days is.
    await mergelane.api.removeDownload('ancient')
    await mergelane.api.removeDownload('recent')
    await mergelane.api.updateSettings({ historyKeep: '30d' })
    await expect
      .poll(async () => (await mergelane.api.historyEntries()).map((found) => found.name))
      .toEqual(['recent.iso'])
  })

  test('only this user can read it, and a signed link’s query is never in it in the clear', async ({
    mergelane,
    serve,
    dirs
  }) => {
    const sealable = await mergelane.evaluateMain(
      ({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable(),
      null
    )
    const origin = await serve({ size: SIZE })
    await mergelane.start(origin.url('/files/signed.bin?X-Amz-Signature=topsecret'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    await mergelane.quit()

    const db = join(dirs.userData, 'mergelane.db')
    expect(statSync(db).mode & 0o777).toBe(0o600)
    const bytes = await readFile(db)
    expect(bytes.includes('signed.bin')).toBe(true)
    if (sealable) expect(bytes.includes('topsecret')).toBe(false)
  })

  test('a damaged database is set aside, and the app starts with a new one', async ({
    mergelane,
    dirs
  }) => {
    await mergelane.quit()
    await writeFile(join(dirs.userData, 'mergelane.db'), 'not a database at all, not even close')
    await mergelane.launch()
    await openHistory(mergelane)
    expect(await mergelane.api.historyEntries()).toEqual([])
    expect(
      readdirSync(dirs.userData).some((name) => name.startsWith('mergelane.db.damaged-'))
    ).toBe(true)
  })
})
