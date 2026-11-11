import { expect, test, type MergelaneApp } from './fixtures'

// Settings › General › "On this Mac" (M3.3, docs/DECISIONS.md ADR-0037): the merged speed in the
// menu bar, the notification when a download finishes, and Open at login. A test run never reaches
// macOS with any of them: the app keeps what it would have shown or registered on the main
// process's global (testKnobs.ts testRecord), and these tests read it there.

interface Recorded {
  menuBar?: { shown: boolean; title: string }
  notifications?: Array<{ title: string; body: string }>
  loginItem?: boolean[]
}

const recorded = (mergelane: MergelaneApp): Promise<Recorded> =>
  mergelane.evaluateMain(
    () => ((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as Recorded,
    null
  )

const BLOCK = 8 * 1024 * 1024

async function onThisMac(mergelane: MergelaneApp): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'General' })
    .click()
}

test.describe('On this Mac @smoke', () => {
  test.skip(process.platform !== 'darwin', 'the menu bar is macOS’s')

  test('the menu bar shows the merged speed while bytes move, in the window’s units, and can be turned off', async ({
    mergelane,
    serve
  }) => {
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar)
      .toEqual({
        shown: true,
        title: ''
      })
    const origin = await serve({ size: 8 * BLOCK, bytesPerSecond: 1_000_000 })
    const id = await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('downloading')
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar?.title, { timeout: 15_000 })
      .toMatch(/^[\d.]+ (B|KB|MB)\/s$/)

    // The window's units: bits.
    await mergelane.api.updateSettings({ speedUnit: 'bits' })
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar?.title, { timeout: 15_000 })
      .toMatch(/^[\d.]+ (bps|Kbps|Mbps)$/)

    await mergelane.api.cancelDownload(id)
    await expect.poll(async () => (await recorded(mergelane)).menuBar?.title).toBe('')

    await onThisMac(mergelane)
    await mergelane.page
      .getByRole('switch', { name: 'Show the merged speed in the menu bar' })
      .click()
    await expect.poll(async () => (await recorded(mergelane)).menuBar?.shown).toBe(false)
    // Kept over a restart.
    await mergelane.relaunch()
    expect((await recorded(mergelane)).menuBar).toBeUndefined()
  })

  test('a finished download posts a notification, unless turned off', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: BLOCK, seed: 1 })
    await mergelane.start(first.url(), first.sha256)
    await mergelane.waitForHttpStatus('completed')
    await expect
      .poll(async () => (await recorded(mergelane)).notifications ?? [])
      .toEqual([expect.objectContaining({ title: 'Download complete' })])

    await onThisMac(mergelane)
    await mergelane.page.getByRole('switch', { name: 'Notify me when a download finishes' }).click()
    await expect.poll(async () => (await mergelane.api.listHistory()).length).toBe(1)
    const second = await serve({ size: BLOCK, seed: 2 })
    await mergelane.start(second.url(), second.sha256)
    await expect.poll(async () => (await mergelane.api.listHistory()).length).toBe(2)
    expect((await recorded(mergelane)).notifications).toHaveLength(1)
  })

  test('Open at login can’t be turned on in a build that never registers itself', async ({
    mergelane
  }) => {
    await onThisMac(mergelane)
    const login = mergelane.page.getByRole('switch', { name: 'Open at login' })
    await expect(login).toBeDisabled()
    await expect(
      mergelane.page.getByText('Only Mergelane installed from its disk image can open at login.')
    ).toBeVisible()
    expect((await recorded(mergelane)).loginItem).toBeUndefined()
  })

  test('Open at login shows what macOS says: needs approval', async ({ mergelane }) => {
    await mergelane.relaunch({ MERGELANE_E2E_LOGIN_ITEM: 'requires-approval' })
    await onThisMac(mergelane)
    const login = mergelane.page.getByRole('switch', { name: 'Open at login' })
    await login.click()
    await expect(
      mergelane.page.getByText(
        'macOS needs your approval: turn Mergelane on in System Settings › General › Login Items.'
      )
    ).toBeVisible()
    await expect(login).toBeChecked()
    await login.click()
    await expect(login).not.toBeChecked()
    expect((await recorded(mergelane)).loginItem).toEqual([true, false])
  })
})
