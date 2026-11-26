import { BLOCK, expect, test, type MergelaneApp } from './fixtures'

// The end of the queue (docs/plans/2026-11-new-features-plan.md, feature 7; ADR-0079). The power
// actions are never run here: a test run records what it would have done (main/power.ts).

const SIZE = 8 * BLOCK

interface Recorded {
  power?: Array<{ action: string; command: [string, string[]] | null }>
  notifications?: Array<{ title: string; body: string }>
}
const recorded = (mergelane: MergelaneApp): Promise<Recorded> =>
  mergelane.evaluateMain(
    () => ((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as Recorded,
    null
  )
const notice = (mergelane: MergelaneApp): ReturnType<MergelaneApp['page']['getByRole']> =>
  mergelane.page.getByRole('alertdialog', { name: 'The queue is done' })

// A 3-second countdown instead of a minute.
test.use({ appEnv: { MERGELANE_E2E_QUEUE_END_MS: '3000' } })

test.describe('when the queue finishes @smoke', () => {
  test('the last download done, it counts down, then puts the Mac to sleep', async ({
    mergelane,
    serve
  }) => {
    await mergelane.api.updateSettings({ afterQueue: 'sleep' })
    const origin = await serve({ size: SIZE })
    await mergelane.start(origin.url('/one.bin'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')

    await expect(notice(mergelane)).toContainText('will sleep in')
    await expect(notice(mergelane)).toContainText('as set in Settings › General.')
    expect((await recorded(mergelane)).notifications).toContainEqual({
      title: 'The queue is done',
      body: expect.stringContaining('will sleep in 60 seconds') as unknown as string
    })
    await expect
      .poll(async () => (await recorded(mergelane)).power ?? [], {
        timeout: 10_000
      })
      .toHaveLength(1)
    const [asked] = (await recorded(mergelane)).power!
    expect(asked.action).toBe('sleep')
    if (process.platform === 'darwin')
      expect(asked.command).toEqual(['/usr/bin/pmset', ['sleepnow']])
    await expect(notice(mergelane)).toHaveCount(0)
  })

  test('Cancel stops the countdown; nothing is asked of the Mac', async ({ mergelane, serve }) => {
    await mergelane.api.updateSettings({ afterQueue: 'shutdown' })
    const origin = await serve({ size: SIZE })
    await mergelane.start(origin.url('/one.bin'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    await expect(notice(mergelane)).toContainText('Apps with unsaved work can stop the shutdown.')
    await notice(mergelane).getByRole('button', { name: 'Cancel' }).click()
    await expect(notice(mergelane)).toHaveCount(0)
    // Past the countdown: still nothing.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect((await recorded(mergelane)).power).toBeUndefined()
  })

  test('no countdown while the queue has work left, nor for a pause', async ({
    mergelane,
    serve
  }) => {
    await mergelane.api.updateSettings({ afterQueue: 'sleep', downloadsAtOnce: 1 })
    const quick = await serve({ size: SIZE })
    const slow = await serve({ size: 64 * BLOCK, seed: 2, bytesPerSecond: 256 * 1024 })
    await mergelane.start(quick.url('/first.bin'), quick.sha256)
    const second = await mergelane.start(slow.url('/second.bin'), slow.sha256)
    // The first done, the second takes its turn: the queue isn't finished.
    await expect.poll(async () => (await mergelane.byId(second))?.status).toBe('downloading')
    await expect(notice(mergelane)).toHaveCount(0)
    // The user pauses the last one: that's no end of the queue either.
    await mergelane.api.pauseDownload(second)
    await expect.poll(async () => (await mergelane.byId(second))?.status).toBe('paused')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await expect(notice(mergelane)).toHaveCount(0)
    expect((await recorded(mergelane)).power).toBeUndefined()
  })

  test('a download that starts during the countdown stops it', async ({ mergelane, serve }) => {
    await mergelane.api.updateSettings({ afterQueue: 'sleep' })
    const origin = await serve({ size: SIZE })
    await mergelane.start(origin.url('/one.bin'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    await expect(notice(mergelane)).toBeVisible()

    const next = await serve({ size: 32 * BLOCK, seed: 3, bytesPerSecond: 256 * 1024 })
    await mergelane.start(next.url('/two.bin'), next.sha256)
    await expect(notice(mergelane)).toHaveCount(0)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect((await recorded(mergelane)).power).toBeUndefined()
  })

  test('set to do nothing, the end of the queue asks nothing', async ({ mergelane, serve }) => {
    const origin = await serve({ size: SIZE })
    await mergelane.start(origin.url('/one.bin'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await expect(notice(mergelane)).toHaveCount(0)
    expect((await recorded(mergelane)).power).toBeUndefined()
  })
})
