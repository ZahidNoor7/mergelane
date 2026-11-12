import type { Page } from '@playwright/test'
import { join } from 'node:path'
import { startFakeDaemon, type FakeDaemon } from './fakeDaemon'
import { expect, test, type MergelaneApp } from './fixtures'

// Mergelane in Windows' notification area (the design's Windows 11 study; docs/DECISIONS.md ADR-0061), run on
// the Mac: MERGELANE_E2E_RENDERER_PLATFORM=win32 (testKnobs.ts) gives the app its Windows shell, with a
// stand-in for the icon itself (main/notificationArea.ts) that notes its tooltip and lets a test click it,
// right-click it and choose from its menu, through globalThis.__mergelaneTray in the main process. The flyout
// is the real window and page. What Windows draws (the icon, the menu, the flyout's place and corners) is on
// the laptop checklist (docs/WINDOWS-TESTING.md).

type MenuEntry = { id: string; label: string; checked?: boolean } | { separator: true }

interface Tray {
  click(): void
  menu(): Promise<MenuEntry[]>
  choose(id: string): Promise<void>
}
/** A click on the icon. */
const click = (mergelane: MergelaneApp): Promise<void> =>
  mergelane.evaluateMain(() => {
    ;(globalThis as unknown as { __mergelaneTray: Tray }).__mergelaneTray.click()
  }, null)

/** A right-click, and the menu's choice of `id`. */
async function choose(mergelane: MergelaneApp, id: string): Promise<void> {
  await mergelane.evaluateMain(
    (_electron, item) =>
      (globalThis as unknown as { __mergelaneTray: Tray }).__mergelaneTray.choose(item),
    id
  )
}

interface Recorded {
  notificationArea?: { shown: boolean; toolTip: string }
  trayFlyout?: { open: boolean }
  menuBar?: unknown
}
const recorded = (mergelane: MergelaneApp): Promise<Recorded> =>
  mergelane.evaluateMain(
    () => ((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as Recorded,
    null
  )

/** The menu's items as they read, "—" for a separator, "✓" before a checked one. */
async function menu(mergelane: MergelaneApp): Promise<string[]> {
  const entries = await mergelane.evaluateMain(
    () => (globalThis as unknown as { __mergelaneTray: Tray }).__mergelaneTray.menu(),
    null
  )
  return entries.map((entry) =>
    'separator' in entry ? '—' : `${entry.checked ? '✓ ' : ''}${entry.label}`
  )
}

/** Launches with the Windows shell. Without `daemon`, the helper isn't installed (and no real one is
 * reached: the socket is a path nothing listens on). */
async function asWindows(mergelane: MergelaneApp, daemon?: FakeDaemon): Promise<void> {
  await mergelane.relaunch({
    MERGELANE_E2E_RENDERER_PLATFORM: 'win32',
    MERGELANE_E2E_DAEMON_SOCKET: daemon?.path ?? join(mergelane.dirs.userData, 'no-helper.sock'),
    MERGELANE_E2E_DAEMON_INSTALLED: daemon ? '1' : '0'
  })
}

/** Clicks the icon and returns the flyout's page (its window is made on the first click). */
async function openFlyout(mergelane: MergelaneApp): Promise<Page> {
  const made = mergelane.electronApp.waitForEvent('window')
  await click(mergelane)
  const flyout = await made
  await flyout.waitForLoadState('domcontentloaded')
  return flyout
}

test.describe('The notification area on Windows @smoke', () => {
  test('the icon is named, with the merged speed while a download runs', async ({
    mergelane,
    serve
  }) => {
    await asWindows(mergelane)
    await expect
      .poll(async () => (await recorded(mergelane)).notificationArea)
      .toEqual({ shown: true, toolTip: 'Mergelane' })
    // Not the Mac's menu bar item.
    expect((await recorded(mergelane)).menuBar).toBeUndefined()

    const origin = await serve({ size: 16 * 1024 * 1024, bytesPerSecond: 400_000 })
    const id = await mergelane.start(origin.url(), origin.sha256)
    await expect
      .poll(async () => (await recorded(mergelane)).notificationArea?.toolTip)
      .toMatch(/^Mergelane: \d.* merged$/)
    await mergelane.api.pauseDownload(id)
    await expect
      .poll(async () => (await recorded(mergelane)).notificationArea?.toolTip)
      .toBe('Mergelane')
  })

  test('a click opens the flyout: the merged speed and each network as the sidebar shows them; Pause all pauses everything', async ({
    mergelane,
    serve
  }) => {
    await asWindows(mergelane)
    const origin = await serve({ size: 16 * 1024 * 1024, bytesPerSecond: 400_000 })
    const slow = await serve({ size: 16 * 1024 * 1024, bytesPerSecond: 400_000 })
    await mergelane.start(origin.url(), origin.sha256)
    await mergelane.start(slow.url(), slow.sha256)
    await mergelane.waitForStatus('downloading')

    const flyout = await openFlyout(mergelane)
    expect((await recorded(mergelane)).trayFlyout).toEqual({ open: true })
    const panel = flyout.getByRole('dialog', { name: 'Mergelane' })
    await expect(panel).toBeVisible()
    await expect(flyout.locator('html')).toHaveAttribute('data-platform', 'win32')
    const networks = panel.getByRole('list', { name: 'Networks' }).getByRole('listitem')
    await expect(networks).toHaveText([/^a/, /^b/])
    // A network carrying bytes shows its speed, the header the merged speed.
    await expect(networks.first()).toHaveText(/^a\d/)
    await expect(panel.locator(':scope > div').first()).toHaveText(/^Mergelane\d/)

    await panel.getByRole('button', { name: 'Pause all' }).click()
    await expect
      .poll(async () => (await mergelane.all()).map((download) => download.status))
      .toEqual(['paused', 'paused'])
    await expect(panel.getByRole('button', { name: 'Pause all' })).toBeDisabled()
    await expect(panel.locator(':scope > div').first()).toHaveText('Mergelane—')

    // Another click closes it; the next opens the same window again.
    await click(mergelane)
    expect((await recorded(mergelane)).trayFlyout).toEqual({ open: false })
    await click(mergelane)
    expect((await recorded(mergelane)).trayFlyout).toEqual({ open: true })
    expect(mergelane.electronApp.windows()).toHaveLength(2)

    // Open Mergelane: the flyout goes, for the window. Esc closes it too.
    await panel.getByRole('button', { name: 'Open Mergelane' }).click()
    await expect.poll(async () => (await recorded(mergelane)).trayFlyout).toEqual({ open: false })
    await click(mergelane)
    await flyout.keyboard.press('Escape')
    await expect.poll(async () => (await recorded(mergelane)).trayFlyout).toEqual({ open: false })
  })

  test('the right-click menu: Open first, Pause all only while something downloads, then Settings and Exit', async ({
    mergelane,
    serve
  }) => {
    await asWindows(mergelane)
    // No helper installed: Merge for every app is left out, not greyed.
    expect(await menu(mergelane)).toEqual(['Open Mergelane', '—', 'Settings', 'Exit'])

    const origin = await serve({ size: 16 * 1024 * 1024, bytesPerSecond: 400_000 })
    await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForStatus('downloading')
    expect(await menu(mergelane)).toEqual([
      'Open Mergelane',
      '—',
      'Pause all downloads',
      '—',
      'Settings',
      'Exit'
    ])
    await choose(mergelane, 'pauseAll')
    await mergelane.waitForStatus('paused')
    expect(await menu(mergelane)).toEqual(['Open Mergelane', '—', 'Settings', 'Exit'])

    // Settings opens the window's Settings.
    await choose(mergelane, 'settings')
    await expect(mergelane.page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })

  test('Merge for every app, with the helper: a check mark that follows it, and Networks says why it was refused', async ({
    mergelane
  }) => {
    const fake = await startFakeDaemon()
    try {
      await asWindows(mergelane, fake)
      expect(await menu(mergelane)).toEqual([
        'Open Mergelane',
        '—',
        'Merge for every app',
        '—',
        'Settings',
        'Exit'
      ])
      await choose(mergelane, 'merge')
      expect(fake.state).toBe('on')
      expect(await menu(mergelane)).toContain('✓ Merge for every app')
      await choose(mergelane, 'merge')
      expect(fake.state).toBe('off')

      fake.refuseEnable = {
        code: 'VPN_ACTIVE',
        message:
          'Another VPN (utun4) is routing all IPv4 traffic. Turn it off to use system-wide merging.'
      }
      await choose(mergelane, 'merge')
      expect(fake.state).toBe('off')
      await expect(
        mergelane.page.getByRole('heading', { name: 'Networks', level: 1 })
      ).toBeVisible()
    } finally {
      await fake.close()
    }
  })

  test('closing the window keeps Mergelane in the notification area; Exit quits', async ({
    mergelane
  }) => {
    await asWindows(mergelane)
    const closeWindow = (): Promise<{ windows: number; visible: boolean }> =>
      mergelane.evaluateMain(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window.close()
        const left = BrowserWindow.getAllWindows()
        return { windows: left.length, visible: left.some((each) => each.isVisible()) }
      }, null)
    expect(await closeWindow()).toEqual({ windows: 1, visible: false })
    // Still running: the icon is there, and its menu answers.
    expect((await recorded(mergelane)).notificationArea?.shown).toBe(true)
    expect(await menu(mergelane)).toContain('Exit')

    const closed = new Promise<void>((resolve) => mergelane.electronApp.once('close', resolve))
    await choose(mergelane, 'exit').catch(() => {})
    await closed
    mergelane.alive = false
  })

  test('with the switch off, closing the window with nothing running quits, as before', async ({
    mergelane
  }) => {
    await asWindows(mergelane)
    // The flyout opened once: its window must go with the icon, or it alone would keep Mergelane running.
    await openFlyout(mergelane)
    await mergelane.openSettings()
    await mergelane.page
      .getByRole('switch', {
        name: 'Keep running in the notification area when I close the window'
      })
      .click()
    await expect
      .poll(async () => (await recorded(mergelane)).notificationArea)
      .toEqual({ shown: false, toolTip: '' })
    await expect.poll(() => mergelane.electronApp.windows().length).toBe(1)
    const closed = new Promise<void>((resolve) => mergelane.electronApp.once('close', resolve))
    await mergelane
      .evaluateMain(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close(), null)
      .catch(() => {})
    await closed
    mergelane.alive = false
  })
})
