import type { Page } from '@playwright/test'
import { formatSpeed, formatSpeedPair } from '../src/shared/speedText'
import { startFakeDaemon, type FakeLinkStats } from './fakeDaemon'
import { expect, test, type MergelaneApp } from './fixtures'

// Settings › General › "On this Mac" (M3.3, docs/DECISIONS.md ADR-0037): the merged download and
// upload in the menu bar (the whole Mac's while System merge is on, ADR-0066) and the menu under it
// (ADR-0067), the notification when a download finishes, and Open at login. A test run never reaches
// macOS with any of them: the app keeps what it would have shown or registered on the main
// process's global (testKnobs.ts testRecord), and these tests read it there. The menu is the real
// window and page, opened through a stand-in for the icon (globalThis.__mergelaneMenuBar).

interface Recorded {
  menuBar?: { shown: boolean; title: string }
  menuBarPanel?: { open: boolean }
  notifications?: Array<{ title: string; body: string }>
  loginItem?: boolean[]
}

const recorded = (mergelane: MergelaneApp): Promise<Recorded> =>
  mergelane.evaluateMain(
    () => ((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as Recorded,
    null
  )

const BLOCK = 8 * 1024 * 1024

/** A click on the menu bar icon. */
const click = (mergelane: MergelaneApp): Promise<void> =>
  mergelane.evaluateMain(() => {
    ;(globalThis as unknown as { __mergelaneMenuBar: { click(): void } }).__mergelaneMenuBar.click()
  }, null)

/** Clicks the icon and returns the menu's page (its window is made on the first click). */
async function openMenu(mergelane: MergelaneApp): Promise<Page> {
  const made = mergelane.electronApp.waitForEvent('window')
  await click(mergelane)
  const menu = await made
  await menu.waitForLoadState('domcontentloaded')
  return menu
}

const menuOpen = async (mergelane: MergelaneApp): Promise<boolean | undefined> =>
  (await recorded(mergelane)).menuBarPanel?.open

/** A speed as the menu draws it: the figure, then its unit in its own span. */
const drawn = (bytesPerSecond: number, unit: 'bytes' | 'bits' = 'bytes'): string =>
  formatSpeed(bytesPerSecond, unit).replace(' ', '')

async function onThisMac(mergelane: MergelaneApp): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'General' })
    .click()
}

test.describe('On this Mac @smoke', () => {
  test.skip(process.platform !== 'darwin', 'the menu bar is macOS’s')

  test('the menu bar shows the merged download and upload while bytes move, in the window’s units, and can be turned off', async ({
    mergelane,
    serve
  }) => {
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar)
      .toEqual({
        shown: true,
        title: ''
      })
    // Always, whatever the test's networks (automatic has its own test).
    await mergelane.api.updateSettings({ menuBarSpeedText: 'on' })
    const origin = await serve({ size: 8 * BLOCK, bytesPerSecond: 1_000_000 })
    const id = await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('downloading')
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar?.title, { timeout: 15_000 })
      .toMatch(/^↓[\d.]+ ↑0(\.0)? (B|KB|MB)\/s$/)

    // The window's units: bits.
    await mergelane.api.updateSettings({ speedUnit: 'bits' })
    await expect
      .poll(async () => (await recorded(mergelane)).menuBar?.title, { timeout: 15_000 })
      .toMatch(/^↓[\d.]+ ↑0(\.0)? (bps|Kbps|Mbps)$/)

    await mergelane.api.cancelDownload(id)
    await expect.poll(async () => (await recorded(mergelane)).menuBar?.title).toBe('')

    await onThisMac(mergelane)
    await mergelane.page.getByRole('switch', { name: 'Show Mergelane in the menu bar' }).click()
    await expect.poll(async () => (await recorded(mergelane)).menuBar?.shown).toBe(false)
    // Kept over a restart.
    await mergelane.relaunch()
    expect((await recorded(mergelane)).menuBar).toBeUndefined()
  })

  test('while System merge is on, the menu bar and its menu show everything the Mac receives and sends', async ({
    mergelane,
    serve
  }) => {
    const fake = await startFakeDaemon()
    const link = (name: string, linkRxBps: number, linkTxBps: number): FakeLinkStats => ({
      name,
      rxBps: linkRxBps / 2,
      txBps: linkTxBps / 2,
      linkRxBps,
      linkTxBps,
      activeFlows: 1,
      totalFlows: 1,
      weight: 1,
      failed: 0
    })
    // The test's network `a`, and one the window doesn't list.
    fake.traffic = [link('a', 3_000_000, 300_000), link('feth20', 1_500_000, 200_000)]
    const title = async (): Promise<string | undefined> =>
      (await recorded(mergelane)).menuBar?.title
    try {
      await mergelane.relaunch({
        MERGELANE_E2E_DAEMON_SOCKET: fake.path,
        MERGELANE_E2E_DAEMON_INSTALLED: '1'
      })
      await mergelane.api.updateSettings({ menuBarSpeedText: 'on' })
      // Merging is off and nothing downloads: the helper is asked, and the icon stands alone.
      await expect.poll(() => fake.requests.some((r) => r.method === 'status')).toBe(true)
      expect(await title()).toBe('')

      // On: both networks' counters together, in the window's units.
      fake.state = 'on'
      await expect
        .poll(title, { timeout: 15_000 })
        .toBe(formatSpeedPair(4_500_000, 500_000, 'bytes'))
      await mergelane.api.updateSettings({ speedUnit: 'bits' })
      await expect
        .poll(title, { timeout: 15_000 })
        .toBe(formatSpeedPair(4_500_000, 500_000, 'bits'))

      // The menu: network `a`'s whole traffic, as the helper counts it, in the units just chosen.
      const menu = await openMenu(mergelane)
      const panel = menu.getByRole('dialog', { name: 'Mergelane' })
      const rows = panel.getByRole('list', { name: 'Networks' }).getByRole('listitem')
      await expect(rows.first()).toHaveText(
        new RegExp(`^a100% · .+ today${drawn(3_000_000, 'bits')}${drawn(300_000, 'bits')}$`)
      )
      await menu.keyboard.press('Escape')
      await expect.poll(() => menuOpen(mergelane)).toBe(false)
      await mergelane.api.updateSettings({ speedUnit: 'bytes' })

      // A helper that can't give its counters: Mergelane's own downloads, as before.
      fake.refuse = { stats: { code: 'INTERNAL', message: 'no counters' } }
      await expect.poll(title, { timeout: 15_000 }).toBe('')
      const origin = await serve({ size: 8 * BLOCK, bytesPerSecond: 1_000_000 })
      const id = await mergelane.start(origin.url(), origin.sha256)
      await mergelane.waitForHttpStatus('downloading')
      await expect.poll(title, { timeout: 15_000 }).toMatch(/^↓[\d.]+ ↑0(\.0)? (B|KB|MB)\/s$/)
      expect(await title()).not.toBe(formatSpeedPair(4_500_000, 500_000, 'bytes'))
      await mergelane.api.cancelDownload(id)

      // Off again: nothing beside the icon.
      fake.refuse = undefined
      fake.state = 'off'
      await expect.poll(title, { timeout: 15_000 }).toBe('')
    } finally {
      await fake.close()
    }
  })

  test('the speed beside the icon: automatic shows it with two networks; the menu’s switch and Settings choose', async ({
    mergelane,
    serve
  }) => {
    const title = async (): Promise<string | undefined> =>
      (await recorded(mergelane)).menuBar?.title
    // One network: nothing to combine, so automatic leaves just the icon, even while a download runs.
    await mergelane.relaunch({ MERGELANE_E2E_INTERFACES: 'a=127.0.0.1' })
    const origin = await serve({ size: 8 * BLOCK, bytesPerSecond: 1_000_000 })
    const id = await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('downloading')
    // Bytes are moving, and the menu bar has looked twice since (it looks once a second).
    await expect
      .poll(
        async () =>
          (await mergelane.api.listDownloads()).find((update) => update.state.id === id)?.state
            .speedBytesPerSec ?? 0,
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await title()).toBe('')
    const menu = await openMenu(mergelane)
    const toggle = menu.getByRole('menuitemcheckbox', { name: 'Speed beside the icon' })
    // Once the menu has its numbers (it asks at once, then every second).
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await menu.keyboard.press('Escape')

    // A second network turns up: now it shows.
    await mergelane.evaluateMain(() => {
      process.env.MERGELANE_E2E_INTERFACES = 'a=127.0.0.1,b=127.0.0.1'
    }, null)
    await expect.poll(title, { timeout: 15_000 }).toMatch(/^↓[\d.]+ ↑[\d.]+ /)

    // The menu's switch hides it, as a choice that Settings shows.
    await click(mergelane)
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 })
    await toggle.click()
    await expect.poll(() => menuOpen(mergelane)).toBe(false)
    await expect.poll(title).toBe('')
    await onThisMac(mergelane)
    const choices = mergelane.page.getByRole('group', { name: 'Speed beside the icon' })
    await expect(choices.getByRole('button', { name: 'Never' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // Automatic again, in Settings: two networks, so it shows.
    await choices.getByRole('button', { name: 'Automatic' }).click()
    await expect.poll(title, { timeout: 15_000 }).toMatch(/^↓/)
    await mergelane.api.cancelDownload(id)
  })

  test('a click on the icon opens the menu: the merged speeds, each network, and the commands', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 8 * BLOCK, bytesPerSecond: 1_000_000 })
    const id = await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('downloading')

    const menu = await openMenu(mergelane)
    expect(await menuOpen(mergelane)).toBe(true)
    // It opens over a full-screen app too (ADR-0068): on every Space, the full-screen ones included, and on top.
    expect(
      await mergelane.evaluateMain(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((each) =>
          each.webContents.getURL().endsWith('#menubar')
        )
        return window
          ? { allSpaces: window.isVisibleOnAllWorkspaces(), onTop: window.isAlwaysOnTop() }
          : null
      }, null)
    ).toEqual({ allSpaces: true, onTop: true })
    const panel = menu.getByRole('dialog', { name: 'Mergelane' })
    await expect(panel.getByRole('heading')).toHaveText(/^Merged across 1 of \d networks?$/)
    // Network `a` carries the download, and sends nothing.
    const rows = panel.getByRole('list', { name: 'Networks' }).getByRole('listitem')
    await expect(rows.first()).toHaveText(/^a100% · .+ today[\d.]+(B|KB|MB)\/s—$/, {
      timeout: 15_000
    })
    await expect(panel.getByText(/ downloaded today$/)).toBeVisible()
    await expect(panel.getByRole('menu', { name: 'Commands' }).getByRole('menuitem')).toHaveText([
      'Open Mergelane⌘O',
      'Pause all downloads',
      'New download…⌘N',
      'Settings…⌘,',
      'Quit Mergelane⌘Q'
    ])

    // Pause all: the menu closes, and the download pauses.
    await panel.getByRole('menuitem', { name: /^Pause all/ }).click()
    await expect.poll(() => menuOpen(mergelane)).toBe(false)
    await mergelane.waitForHttpStatus('paused')

    // Opened again (the same window): nothing to pause now.
    await click(mergelane)
    await expect.poll(() => menuOpen(mergelane)).toBe(true)
    await expect(panel.getByRole('menuitem', { name: /^Pause all/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    // ⌘N: New download, in the window.
    await menu.keyboard.press('Meta+N')
    await expect.poll(() => menuOpen(mergelane)).toBe(false)
    await expect(mergelane.page.getByRole('dialog', { name: 'New download' })).toBeVisible()
    await mergelane.page.keyboard.press('Escape')

    // The arrow keys and Return: Settings…, in the window.
    await click(mergelane)
    await expect.poll(() => menuOpen(mergelane)).toBe(true)
    // From nothing, up is Quit, then Settings.
    await menu.keyboard.press('ArrowUp')
    await menu.keyboard.press('ArrowUp')
    await expect(panel.getByRole('menuitem', { name: /^Settings/ })).toHaveAttribute(
      'data-highlighted',
      'true'
    )
    await menu.keyboard.press('Enter')
    await expect.poll(() => menuOpen(mergelane)).toBe(false)
    await expect(mergelane.page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

    // A second click on the icon closes the menu, as a menu does.
    await click(mergelane)
    await expect.poll(() => menuOpen(mergelane)).toBe(true)
    await click(mergelane)
    await expect.poll(() => menuOpen(mergelane)).toBe(false)
    await mergelane.api.cancelDownload(id)
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
