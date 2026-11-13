import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'
import { SpeedServer } from './speedServer'

// Networks › Speed test (docs/DECISIONS.md ADR-0064), end to end in the app: the view started from
// the Networks place, a real test of each network over the suite's two test networks, a (loopback)
// and b (this Mac's LAN address), against a local stand-in for Cloudflare's speed test, so the run
// never leaves the Mac. Each phase runs 1.5 s instead of 10.

const MB = 1024 * 1024
const NO_HELPER = {
  MERGELANE_E2E_DAEMON_SOCKET: '/tmp/mlfd-none',
  MERGELANE_E2E_DAEMON_INSTALLED: '0'
}

test.describe('speed test @smoke', () => {
  test.use({ appEnv: { MERGELANE_E2E_SPEEDTEST_MS: '1500', ...NO_HELPER } })

  let server: SpeedServer
  test.afterEach(async () => {
    await server?.stop()
  })

  test('tests each network on its own, shows the results, keeps them, and counts their data', async ({
    mergelane
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    server = await new SpeedServer({
      rates: { '127.0.0.1': 2 * MB, [LAN_ADDRESS!]: MB },
      delayMs: { '127.0.0.1': 5, [LAN_ADDRESS!]: 25 }
    }).start()
    await mergelane.api.updateSettings({ speedTestServer: server.url })
    const { page } = mergelane

    await page
      .getByRole('navigation', { name: 'Mergelane' })
      .getByRole('button', { name: 'Networks', exact: true })
      .click()
    await page.getByRole('button', { name: 'Test speed' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Speed test' })).toBeFocused()
    await page.getByRole('button', { name: 'Start test' }).click()

    // Live: the dial reads the network being measured, step by step.
    const meter = page.getByRole('meter', { name: 'Speed' })
    await expect(meter).toHaveAttribute('aria-valuetext', /^Download: /)
    await expect(page.getByRole('status')).toHaveText(/^Testing a \(1 of 2\)/)
    await expect(page.getByRole('button', { name: 'Stop test' })).toBeVisible()

    // Done: both networks measured, a faster than b, and the test kept.
    await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible({
      timeout: 30_000
    })
    const table = page.getByRole('table')
    await expect(table.getByRole('row', { name: /^a/ })).toContainText('Fastest')
    await expect(table.getByRole('row', { name: /^b/ })).toContainText('Slowest')
    await expect(page.getByRole('list', { name: 'Past tests' }).getByRole('button')).toHaveCount(1)
    await expect(meter).toHaveAttribute('aria-valuetext', /^Last download: /)

    // Every request went to the server set, from the network it measured.
    expect(new Set(server.requests.map((request) => request.from))).toEqual(
      new Set(['127.0.0.1', LAN_ADDRESS])
    )
    const history = await mergelane.api.speedTestHistory()
    expect(history).toHaveLength(1)
    const [a, b] = history[0].links
    expect(a.downloadBytesPerSec!).toBeGreaterThan(b.downloadBytesPerSec!)
    expect(a.latencyMs!).toBeLessThan(b.latencyMs!)
    // What it moved counts against each network's data limit.
    await expect
      .poll(async () => (await mergelane.api.networkUsage())['a'] ?? 0)
      .toBeGreaterThanOrEqual(a.bytesDown + a.bytesUp)
  })

  test('stopping a test keeps nothing, and a server that refuses fails it with its reason', async ({
    mergelane
  }) => {
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    await mergelane.api.updateSettings({ speedTestServer: server.url })
    const { page } = mergelane
    await page
      .getByRole('navigation', { name: 'Mergelane' })
      .getByRole('button', { name: 'Networks', exact: true })
      .click()
    // From the network's own line: only it is tested.
    await page.getByRole('button', { name: 'Test a’s speed' }).click()
    await page.getByRole('button', { name: 'Start test' }).click()
    await expect(page.getByRole('meter', { name: 'Speed' })).toHaveAttribute(
      'aria-valuetext',
      /^Download: /
    )
    await page.getByRole('button', { name: 'Stop test' }).click()
    await expect(page.getByText('The test was stopped before it finished.')).toBeVisible()
    expect(await mergelane.api.speedTestHistory()).toEqual([])

    server.options.failFrom = { '127.0.0.1': 503 }
    await page.getByRole('button', { name: 'Start test' }).click()
    await expect(page.getByText('The test failed. No network finished it.')).toBeVisible()
    await expect(page.getByRole('row', { name: /^a/ })).toContainText(
      'Failed: The test server answered 503'
    )
    expect(await mergelane.api.speedTestHistory()).toHaveLength(1)
  })

  test('a running download waits at the front of the queue during a test; waiting ones keep their turn and time', async ({
    mergelane,
    serve
  }) => {
    // Slow enough to be running when the test starts, and still running after it.
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 64 * 1024 })
    const running = await mergelane.start(origin.url('/running.bin'), origin.sha256, {
      connections: 1
    })
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('downloading')
    const held = await mergelane.start(origin.url('/held.bin'), origin.sha256, {
      when: { kind: 'queue' }
    })
    const at = Date.now() + 60 * 60_000
    const later = await mergelane.start(origin.url('/later.bin'), origin.sha256, {
      when: { kind: 'at', at }
    })

    server = await new SpeedServer({ rates: { '127.0.0.1': 2 * MB } }).start()
    await mergelane.api.updateSettings({ speedTestServer: server.url })
    await mergelane.api.speedTestStart({ scope: 'link', networkIds: ['a'] })
    // During the test: nothing downloads, and the running one waits first in line.
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('queued')
    const during = await mergelane.all()
    expect(during.filter((state) => state.status === 'downloading')).toEqual([])
    const waiting = (id: string): number => during.find((state) => state.id === id)?.queuedAt ?? 0
    expect(waiting(running)).toBeLessThan(waiting(held))
    expect(await mergelane.api.speedTestLive()).toMatchObject({ pausedDownloads: 1 })

    // After it: the running one carries on; the others still wait for their turn and time.
    await expect.poll(() => mergelane.api.speedTestLive(), { timeout: 30_000 }).toBeNull()
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('downloading')
    expect(await mergelane.byId(held)).toMatchObject({ status: 'queued', held: true })
    expect(await mergelane.byId(later)).toMatchObject({ status: 'queued', startAt: at })
    expect((await mergelane.api.speedTestHistory())[0].notes).toContain('downloads-paused')
  })

  test('quit during a test, downloads come back as after any quit, and none stays held', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 64 * 1024 })
    const running = await mergelane.start(origin.url('/running.bin'), origin.sha256, {
      connections: 1
    })
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('downloading')
    const held = await mergelane.start(origin.url('/held.bin'), origin.sha256, {
      when: { kind: 'queue' }
    })
    server = await new SpeedServer({ rates: { '127.0.0.1': MB } }).start()
    await mergelane.api.updateSettings({ speedTestServer: server.url })
    await mergelane.api.speedTestStart({ scope: 'link', networkIds: ['a'] })
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('queued')

    // A quit pauses what was running (lifecycle.spec.ts); one added to the queue still waits.
    await mergelane.relaunch()
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('paused')
    expect(await mergelane.byId(held)).toMatchObject({ status: 'queued', held: true })
    expect(await mergelane.api.speedTestLive()).toBeNull()
    // Nothing is held any more: resumed, it downloads.
    await mergelane.api.resumeDownload(running)
    await expect.poll(async () => (await mergelane.byId(running))?.status).toBe('downloading')
  })

  test('through system merge, without the helper: says so and can’t start', async ({
    mergelane
  }) => {
    const { page } = mergelane
    await page
      .getByRole('navigation', { name: 'Mergelane' })
      .getByRole('button', { name: 'Networks', exact: true })
      .click()
    await page.getByRole('button', { name: 'Test speed' }).click()
    await page.getByRole('button', { name: 'Other apps' }).click()
    await expect(page.getByText(/Needs the system-wide helper/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start test' })).toBeDisabled()
  })
})
