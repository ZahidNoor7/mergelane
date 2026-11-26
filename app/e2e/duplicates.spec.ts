import { BLOCK, expect, test, type MergelaneApp } from './fixtures'
import { seededBytes, sha256, type Origin } from './origin'
import { named, Swarm } from './torrentSwarm'

// Warning before a download already had (docs/plans/2026-11-new-features-plan.md, feature 4;
// ADR-0081): the same link as one in History, or the same file from another site whose published
// SHA-256 matches the one worked out when it finished.

const SIZE = 8 * BLOCK

const notice = (mergelane: MergelaneApp): ReturnType<MergelaneApp['page']['getByRole']> =>
  mergelane.page
    .getByRole('dialog', { name: 'New download' })
    .getByRole('status')
    .filter({
      hasText: /already/
    })

/** Opens New download with a link typed in, and waits for it to be checked. */
async function offer(mergelane: MergelaneApp, link: string): Promise<void> {
  const field = await mergelane.newDownload()
  await field.fill(link)
  await expect(mergelane.page.getByRole('textbox', { name: 'File name' })).toBeVisible({
    timeout: 10_000
  })
}

/** Finished, and its SHA-256 worked out (it is, just after it finishes). */
async function had(mergelane: MergelaneApp, origin: Origin, path: string): Promise<void> {
  await mergelane.start(origin.url(path), origin.sha256)
  await mergelane.waitForHttpStatus('completed')
}

test.describe('duplicate warnings @smoke', () => {
  test('the same link, finished: it says so, and offers to download it again', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    await had(mergelane, origin, '/files/same.bin?token=old')
    await offer(mergelane, origin.url('/files/same.bin?token=new'))
    await expect(notice(mergelane)).toContainText('You already have this file')
    await expect(notice(mergelane)).toContainText('Same link.')
    await expect(mergelane.page.getByRole('button', { name: 'Download again' })).toBeVisible()
  })

  test('the same link still downloading: how far, and the way to it', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 64 * BLOCK, bytesPerSecond: 64 * 1024 })
    await mergelane.start(origin.url('/files/running.bin'), origin.sha256)
    await offer(mergelane, origin.url('/files/running.bin'))
    await expect(notice(mergelane)).toContainText('This is already downloading')
    await expect(notice(mergelane)).toContainText(/It’s in your list, \d+% done\./)
    await notice(mergelane).getByRole('button', { name: 'Show in list' }).click()
    await expect(mergelane.page.getByRole('dialog', { name: 'New download' })).toHaveCount(0)
  })

  test('the same file from another site: name, size and its published SHA-256', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: SIZE, seed: 5 })
    await had(mergelane, first, '/files/pkg.dmg')
    const published = Buffer.from(first.sha256, 'hex').toString('base64')
    const mirror = await serve({
      size: SIZE,
      seed: 5,
      headers: { 'Repr-Digest': `sha-256=:${published}:` }
    })
    // The finished file's SHA-256 is worked out in the background: asked until it's there.
    const query = {
      kind: 'http' as const,
      url: mirror.url('/files/pkg.dmg'),
      name: 'pkg.dmg',
      size: SIZE
    }
    await expect
      .poll(
        async () =>
          (await mergelane.api.findDuplicate({ ...query, publishedSha256: first.sha256 }))?.how
      )
      .toBe('file')

    await offer(mergelane, mirror.url('/files/pkg.dmg'))
    await expect(notice(mergelane)).toContainText('You already have this file')
    await expect(notice(mergelane)).toContainText(
      `Same file from ${new URL(first.url()).host}: the name and size match, and so does the SHA-256 this site publishes.`
    )
  })

  test('the same file from another site that keeps a .sha256 file beside it', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: SIZE, seed: 9 })
    await had(mergelane, first, '/files/tool.zip')
    const mirror = await serve({
      size: SIZE,
      seed: 9,
      texts: { '/files/tool.zip.sha256': `${first.sha256}  tool.zip\n` }
    })
    const query = { kind: 'http' as const, name: 'tool.zip', size: SIZE }
    await expect
      .poll(
        async () =>
          (await mergelane.api.findDuplicate({ ...query, url: mirror.url('/files/tool.zip') }))?.how
      )
      .toBe('file')
    expect(mirror.log.some((entry) => entry.path === '/files/tool.zip.sha256')).toBe(true)
    // A .sha256 file that names another file says nothing about this one.
    const elsewhere = await serve({
      size: SIZE,
      seed: 9,
      texts: { '/files/tool.zip.sha256': `${first.sha256}  something-else.zip\n` }
    })
    expect(
      await mergelane.api.findDuplicate({ ...query, url: elsewhere.url('/files/tool.zip') })
    ).toBeNull()
    expect(elsewhere.log.some((entry) => entry.path === '/files/tool.zip.sha256')).toBe(true)
  })

  test('another site’s file of the same name and size, with no SHA-256 published, is no duplicate', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: SIZE, seed: 6 })
    await had(mergelane, first, '/files/lookalike.zip')
    const other = await serve({ size: SIZE, seed: 7 })
    expect(
      await mergelane.api.findDuplicate({
        kind: 'http',
        url: other.url('/files/lookalike.zip'),
        name: 'lookalike.zip',
        size: SIZE
      })
    ).toBeNull()
  })

  test('turned off, nothing is said; Same link ignores another site’s copy', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: SIZE, seed: 8 })
    await had(mergelane, first, '/files/quiet.bin')
    await mergelane.api.updateSettings({ duplicateCheck: 'off' })
    expect(
      await mergelane.api.findDuplicate({
        kind: 'http',
        url: first.url('/files/quiet.bin'),
        name: 'quiet.bin',
        size: SIZE
      })
    ).toBeNull()

    await mergelane.api.updateSettings({ duplicateCheck: 'link' })
    const mirror = await serve({ size: SIZE, seed: 8 })
    const elsewhere = {
      kind: 'http' as const,
      url: mirror.url('/files/quiet.bin'),
      name: 'quiet.bin',
      size: SIZE,
      publishedSha256: first.sha256
    }
    // The mirror is another origin (its own port), so only the first's own link counts.
    expect(await mergelane.api.findDuplicate(elsewhere)).toBeNull()
    expect(
      (await mergelane.api.findDuplicate({ ...elsewhere, url: first.url('/files/quiet.bin') }))?.how
    ).toBe('link')
  })

  test('the same torrent, whatever link it comes by: its info hash', async ({ mergelane }) => {
    const swarm = await new Swarm().start()
    try {
      const data = seededBytes(256 * 1024, 41)
      const torrent = await swarm.seed([named(data, 'album.flac')], { pieceLength: 64 * 1024 })
      await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data))
      await mergelane.waitForTorrentStatus('completed', 30_000)
      const query = {
        kind: 'torrent' as const,
        url: `magnet:?xt=urn:btih:${torrent.infoHash}`,
        name: 'renamed.flac',
        size: data.length
      }
      expect(
        (await mergelane.api.findDuplicate({ ...query, infoHash: torrent.infoHash }))?.how
      ).toBe('link')
      expect(await mergelane.api.findDuplicate({ ...query, infoHash: 'f'.repeat(40) })).toBeNull()
    } finally {
      await swarm.stop()
    }
  })
})
