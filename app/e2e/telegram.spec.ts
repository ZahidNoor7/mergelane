import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TelegramMediaType } from '../src/shared/types'
import { expect, test, type MergelaneApp } from './fixtures'
import { seededBytes } from './origin'

// Downloading from Telegram: the service is the e2e double (MERGELANE_E2E_TELEGRAM_FAKE=1), so
// the real transfer, manager, queue and persistence run against a source that serves seeded
// bytes and inflicts the DC's faults — a flood-wait, a stale file reference, per-region caps
// on the request size, and a photo whose size only the download itself learns.

const KB = 1024

/** Reads the finished download from the destination and compares it byte for byte with the
 * fake's seeded output — a halving or retry bug that wrote the right size in wrong places
 * would fail here. The bytes match because the double's generator and `seededBytes` are the
 * same xorshift from the same seed. */
async function expectDownloadedBytes(
  mergelane: MergelaneApp,
  namePrefix: string,
  size: number,
  seed: number
): Promise<void> {
  const names = await readdir(mergelane.dirs.dest)
  const name = names.find((entry) => entry.startsWith(namePrefix))
  expect(name, `${namePrefix} should be in the destination`).toBeDefined()
  const actual = await readFile(join(mergelane.dirs.dest, name!))
  expect(
    actual.equals(seededBytes(size, seed)),
    `${namePrefix}'s bytes should match the fake's seeded output`
  ).toBe(true)
}

test.use({
  appEnv: {
    MERGELANE_E2E_TELEGRAM_FAKE: '1',
    // 500ms a chunk: a 3 MiB file takes ~3s, leaving a solid window to pause it mid-flight.
    MERGELANE_E2E_TELEGRAM_DELAY_MS: '500'
  }
})

async function startItem(
  mergelane: MergelaneApp,
  messageId: number,
  mediaType: TelegramMediaType,
  fileName: string,
  totalBytes: number
): Promise<string> {
  return mergelane.api.startDownload({
    kind: 'telegram',
    messageId,
    mediaType,
    url: `telegram://saved-messages/${messageId}`,
    destinationDir: mergelane.dirs.dest,
    suggestedFileName: fileName,
    totalBytes,
    supportsRanges: true,
    interfaceIds: (await mergelane.api.listInterfaces()).map((iface) => iface.id),
    etag: null,
    lastModified: null
  })
}

test.describe('Telegram Saved Messages downloads', () => {
  test('signs in through the dialog, lists media, and downloads a video and a photo @smoke', async ({
    mergelane
  }) => {
    // The dialog saves where the app's destination setting says: point it at the test's folder
    // and relaunch, so the files land where the byte check reads them.
    await mergelane.api.updateSettings({ destinationDir: mergelane.dirs.dest })
    await mergelane.relaunch()

    await mergelane.page.getByRole('button', { name: 'Telegram' }).first().click()
    await mergelane.page.locator('#tg-api-id').fill('12345')
    await mergelane.page.locator('#tg-api-hash').fill('fake-hash')
    await mergelane.page.locator('#tg-phone').fill('+1 555 010 1234')
    await mergelane.page.getByRole('button', { name: 'Send code' }).click()

    // Signed in: the media browser is there, the login form isn't.
    const list = mergelane.page.getByRole('group', { name: 'Saved Messages media' })
    await list.waitFor()
    await expect(mergelane.page.locator('#tg-api-id')).toHaveCount(0)
    await expect(list).toContainText('clip.mp4')
    await expect(list).toContainText('shot.jpg')

    await mergelane.page.getByText('clip.mp4').click()
    await mergelane.page.getByText('shot.jpg').click()
    await mergelane.page.getByRole('button', { name: /Download 2/ }).click()

    await expect
      .poll(
        async () => (await mergelane.all()).filter((state) => state.status === 'completed').length,
        {
          timeout: 30_000
        }
      )
      .toBe(2)
    const finished = (await mergelane.all()).filter((state) => state.status === 'completed')
    // The video's size was known ahead; the photo's size only the download itself learned.
    // (Completion order and name suffixes aren't: whichever finished first sorts first.)
    const video = finished.find((state) => state.fileName.startsWith('clip'))
    const photo = finished.find((state) => state.fileName.startsWith('shot'))
    expect(video?.totalBytes).toBe(3 * KB * KB)
    expect(photo?.totalBytes).toBe(2 * KB * KB)
    // And the bytes are the fake's, in the right places.
    await expectDownloadedBytes(mergelane, 'clip', 3 * KB * KB, 11)
    await expectDownloadedBytes(mergelane, 'shot', 2 * KB * KB, 22)
  })

  test('a flaky file survives a flood-wait, a stale file reference and region caps', async ({
    mergelane
  }) => {
    const id = await startItem(mergelane, 3, 'document', 'flaky.zip', 3 * KB * KB)
    const done = await mergelane.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
    expect(done.totalBytes).toBe(3 * KB * KB)
    await expectDownloadedBytes(mergelane, 'flaky', 3 * KB * KB, 33)
  })

  test('a paused download resumes after a relaunch', async ({ mergelane }) => {
    const id = await startItem(mergelane, 1, 'video', 'clip.mp4', 3 * KB * KB)
    // Pause straight away: the chunks take 500ms each, so this lands mid-download.
    await mergelane.api.pauseDownload(id)
    const paused = await mergelane.waitForStatus('paused', 15_000)
    expect(paused.id).toBe(id)

    await mergelane.relaunch()
    const restored = (await mergelane.all()).find((state) => state.id === id)
    expect(restored?.status).toBe('paused')

    await mergelane.api.resumeDownload(id)
    const done = await mergelane.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
  })
})
