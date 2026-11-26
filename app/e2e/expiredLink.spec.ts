import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID } from '../src/shared/browserBridge'
import { BLOCK, expect, test, type MergelaneApp } from './fixtures'
import { formatPercent } from '../src/shared/speedText'
import { isProbe, type Origin } from './origin'

// Expired-link recovery (docs/plans/2026-11-new-features-plan.md, feature 6; ADR-0078). A link that
// stops working mid-download stops the download at its progress, at once, and a fresh link to the
// same file carries it on: pasted in its details, or handed over again by the browser extension.

const SIZE = 64 * BLOCK
const OURS = `chrome-extension://${CHROME_EXTENSION_ID}/`
const dir = mkdtempSync('/tmp/mlex-')
const SOCKET = join(dir, 's')
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
test.use({ appEnv: { MERGELANE_E2E_BROWSER_SOCKET: SOCKET } })

function send(message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: SOCKET })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('end', () => resolve(JSON.parse(data)))
    socket.on('error', reject)
    socket.write(`${JSON.stringify({ v: 3, origin: OURS, message })}\n`)
  })
}

const signed = (origin: Origin, signature: string): string =>
  origin.url(`/files/film.bin?Expires=1&Signature=${signature}`)

/** Starts film.bin from a signed link, lets it get going, then has the server refuse that link. */
async function expireMidway(
  mergelane: MergelaneApp,
  origin: Origin
): Promise<{ id: string; refusedAfter: number }> {
  const id = await mergelane.start(signed(origin, 'old'), origin.sha256, { connections: 2 })
  await mergelane.waitUntil((state) => state.bytesDownloaded > 8 * BLOCK, 30_000)
  const refusedAfter = origin.log.length
  origin.setRule(({ path, range }) =>
    path.includes('Signature=old') && !isProbe(range) ? { status: 403 } : undefined
  )
  return { id, refusedAfter }
}

const recorded = (mergelane: MergelaneApp): Promise<Array<{ title: string; body: string }>> =>
  mergelane.evaluateMain(
    () =>
      (
        ((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as {
          notifications?: Array<{ title: string; body: string }>
        }
      ).notifications ?? [],
    null
  )

test.describe('a link that stops working @smoke', () => {
  test('stops the download at once, at its progress; a fresh link carries it on', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE, sharedBytesPerSecond: 512 * 1024 })
    const { id, refusedAfter } = await expireMidway(mergelane, origin)

    const stopped = await mergelane.waitForHttpStatus('error', 30_000)
    expect(stopped.problem?.kind).toBe('link-expired')
    expect(stopped.resumable).not.toBe(false)
    expect(stopped.bytesDownloaded).toBeGreaterThan(8 * BLOCK)
    // A handful of refusals, not every stream's five strikes on every network.
    const refused = origin.log.slice(refusedAfter).filter((entry) => entry.status === 403)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.length).toBeLessThan(10)

    // Its details ask for a fresh link.
    const page = mergelane.page
    await page.getByRole('button', { name: 'film.bin', exact: true }).click()
    const percent = formatPercent(stopped.bytesDownloaded, SIZE)
    const panel = page.getByRole('form', { name: `The link expired at ${percent}%` })
    await expect(panel).toContainText('are signed and stop working after a while')

    const sentBefore = origin.chunkRequests().reduce((sum, entry) => sum + entry.bytesSent, 0)
    await panel.getByRole('textbox', { name: 'Fresh link' }).fill(signed(origin, 'new'))
    await panel.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Same file' })).toContainText(
      `Continuing from ${percent}%.`
    )
    const done = await mergelane.waitForHttpStatus('completed', 60_000)
    expect(done.id).toBe(id)
    // Nothing it had is fetched again: what's left, and at most the blocks in flight at the stop.
    const sentAfter =
      origin.chunkRequests().reduce((sum, entry) => sum + entry.bytesSent, 0) - sentBefore
    expect(sentAfter).toBeLessThanOrEqual(SIZE - stopped.bytesDownloaded + 4 * BLOCK)
  })

  test('a link to another file is refused, and the download waits on', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE, sharedBytesPerSecond: 512 * 1024 })
    const other = await serve({ size: 8 * BLOCK, seed: 7 })
    await expireMidway(mergelane, origin)
    await mergelane.waitForHttpStatus('error', 30_000)

    const page = mergelane.page
    await page.getByRole('button', { name: 'film.bin', exact: true }).click()
    const panel = page.getByRole('form', { name: /The link expired at/ })
    await panel.getByRole('textbox', { name: 'Fresh link' }).fill(other.url('/files/other.bin'))
    await panel.getByRole('button', { name: 'Continue' }).click()
    await expect(panel.getByRole('alert')).toHaveText(
      'That link is for other.bin, not this download. Add it as a new download instead.'
    )
    expect((await mergelane.currentHttp())?.status).toBe('error')
  })

  test('a server that turns some connections away is no expired link', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    let requests = 0
    // Every third request refused, as a server over its connection limit does; the rest answered.
    origin.setRule(({ range }) =>
      range && !isProbe(range) && ++requests % 3 === 0 ? { status: 403 } : undefined
    )
    await mergelane.start(origin.url('/files/plain.bin'), origin.sha256, { connections: 2 })
    const done = await mergelane.waitForHttpStatus('completed', 60_000)
    expect(done.problem).toBeUndefined()
    expect(origin.log.some((entry) => entry.status === 403)).toBe(true)
  })
})

test.describe('a fresh link from the browser @smoke', () => {
  test.describe.configure({ mode: 'serial' })

  test('the same download clicked again carries on by itself', async ({ mergelane, serve }) => {
    const origin = await serve({ size: SIZE, sharedBytesPerSecond: 512 * 1024 })
    const { id } = await expireMidway(mergelane, origin)
    const stopped = await mergelane.waitForHttpStatus('error', 30_000)

    await expect.poll(() => send({ type: 'ping' }).then((reply) => reply.ok)).toBe(true)
    const added = await send({ type: 'add', request: { url: signed(origin, 'browser') } })
    expect(added).toMatchObject({ ok: true })
    expect(await send({ type: 'confirm', token: added.token })).toEqual({ ok: true })

    // No New download to confirm: it carries on, and says so.
    const done = await mergelane.waitForHttpStatus('completed', 60_000)
    expect(done.id).toBe(id)
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveCount(0)
    const percent = formatPercent(stopped.bytesDownloaded, SIZE)
    await expect
      .poll(() => recorded(mergelane))
      .toContainEqual({
        title: 'Carrying on with the fresh link',
        body: `film.bin: same file, so it continues from ${percent}%.`
      })
  })

  test('turned off, the fresh link is offered in New download instead', async ({
    mergelane,
    serve
  }) => {
    await mergelane.api.updateSettings({ catchFreshLinks: false })
    const origin = await serve({ size: SIZE, sharedBytesPerSecond: 512 * 1024 })
    await expireMidway(mergelane, origin)
    await mergelane.waitForHttpStatus('error', 30_000)

    await expect.poll(() => send({ type: 'ping' }).then((reply) => reply.ok)).toBe(true)
    const fresh = signed(origin, 'browser')
    const added = await send({ type: 'add', request: { url: fresh } })
    expect(await send({ type: 'confirm', token: added.token })).toEqual({ ok: true })
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(fresh)
    expect((await mergelane.currentHttp())?.status).toBe('error')
  })
})
