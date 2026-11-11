import type { Page } from '@playwright/test'
import { startFakeDaemon } from './fakeDaemon'
import {
  BLOCK,
  expect,
  interfacesEnv,
  LAN_ADDRESS,
  NETWORKS,
  test,
  type MergelaneApp
} from './fixtures'

// The dashboard (M2.3): every download, each network's speed and condition, failover, system
// merge and the honest limits of combined speed, through the real UI.

const ONE_NETWORK = interfacesEnv({ a: NETWORKS.a })
// No helper: not installed, and no socket to answer.
const NO_HELPER = {
  MERGELANE_E2E_DAEMON_SOCKET: '/tmp/mlfd-none',
  MERGELANE_E2E_DAEMON_INSTALLED: '0'
}

const setNetworks = (mergelane: MergelaneApp, networks: Record<string, string>): Promise<void> =>
  mergelane.evaluateMain((_electron, value) => {
    process.env['MERGELANE_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

/** Presses Tab until the focus is on the element matching `name`, as a keyboard user would. */
async function tabTo(page: Page, name: string): Promise<void> {
  for (let presses = 0; presses < 40; presses++) {
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent
    )
    if (focused?.trim() === name) return
  }
  throw new Error(`Tab never reached ${name}`)
}

test.describe('Dashboard @smoke', () => {
  test.use({ appEnv: { MERGELANE_E2E_INTERFACES: ONE_NETWORK, ...NO_HELPER } })

  test('opens from the sidebar and goes back by keyboard, with every empty state saying what to do', async ({
    mergelane
  }) => {
    const page = mergelane.page
    const places = page.getByRole('navigation', { name: 'Mergelane' })
    const dashboardButton = places.getByRole('button', { name: 'Dashboard', exact: true })
    const downloadsButton = places.getByRole('button', { name: 'Downloads', exact: true })
    await expect(dashboardButton).toBeVisible()
    await expect(downloadsButton).toHaveAttribute('aria-current', 'page')

    await tabTo(page, 'Dashboard')
    await expect(dashboardButton).toBeFocused()
    await page.keyboard.press('Enter')
    // The new screen says where it is, and keyboard focus starts there.
    const heading = page.getByRole('heading', { level: 1, name: 'Dashboard' })
    await expect(heading).toBeFocused()

    // Nothing downloading: how to start one.
    const downloads = page.getByRole('region', { name: 'Active downloads' })
    await expect(downloads.getByText('Nothing downloading')).toBeVisible()
    await expect(downloads.getByText(/Paste a link/)).toBeVisible()
    await expect(downloads.getByRole('button', { name: /New download/ })).toBeVisible()
    await expect(
      page.getByText('Each network’s speed is drawn here while something downloads.')
    ).toBeVisible()
    await expect(page.getByText('Nothing downloading', { exact: true }).first()).toBeVisible()

    // One network, up and idle, and nothing to fail over to.
    const network = page
      .getByRole('region', { name: 'Networks' })
      .getByRole('listitem', { name: 'a' })
    await expect(network).toContainText('Up')
    await expect(network).toContainText('Idle')
    const failover = page.getByRole('region', { name: 'Failover' })
    await expect(failover).toContainText('Only a is connected, so there’s nothing to fail over to.')
    await expect(failover.getByRole('log', { name: 'Network changes' })).toHaveText(
      'No network has dropped since Mergelane opened.'
    )

    // No helper: system merge offers the install, and says downloads don't need it.
    const otherApps = page.getByRole('region', { name: 'Other apps' })
    await expect(otherApps).toContainText(
      'Mergelane’s own downloads use every network without this.'
    )
    const merge = otherApps.getByRole('region', { name: 'System merge' })
    await expect(merge.getByText('Needs a one-time install of a small helper.')).toBeVisible()
    await expect(merge.getByRole('button', { name: 'Install' })).toBeVisible()

    // The honest limits, in the UI and not only in the README.
    const about = page.getByRole('region', { name: 'About combined speed' })
    for (const limit of [
      'One connection always uses one network.',
      'A network that drops breaks the connections on it.',
      'Networks add speed only if they’re separate internet connections.',
      'VPNs come first.'
    ]) {
      await expect(about.getByText(limit, { exact: true })).toBeVisible()
    }
    await expect(about).toContainText('a video call or a single-connection download won’t')
    await expect(about).toContainText('has to reconnect')

    // The sidebar says where the window is.
    await expect(dashboardButton).toHaveAttribute('aria-current', 'page')
    await expect(downloadsButton).not.toHaveAttribute('aria-current', 'page')

    // Back, by keyboard, from the sidebar; focus stays on the place chosen.
    await downloadsButton.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('No downloads yet')).toBeVisible()
    await expect(downloadsButton).toBeFocused()
    await expect(downloadsButton).toHaveAttribute('aria-current', 'page')
  })

  test('says how much CPU and memory Mergelane itself uses, read from the real app', async ({
    mergelane
  }) => {
    await mergelane.place('Dashboard')
    const usage = mergelane.page.getByRole('region', { name: 'Mergelane on this Mac' })
    const table = usage.getByRole('table', { name: 'Mergelane’s CPU and memory by part' })
    const app = table.getByRole('row', { name: /^Mergelane / })
    // The app always uses some memory; its CPU is a percent of one core.
    await expect(app).toContainText(/\d+(\.\d)?%\s*\d+(\.\d+)? (MB|GB)/)
    await expect(usage.getByText(/^\d+ MB$|^\d\.\d\d GB$/).first()).toBeVisible()
    // No helper in a test run, and no video tools running.
    await expect(table.getByRole('row', { name: /^Helper/ })).toContainText('Not running')
    await expect(table.getByRole('row', { name: /^Video tools/ })).toContainText('Not running now')
  })

  test('fits the smallest window without scrolling sideways', async ({ mergelane }) => {
    await mergelane.evaluateMain(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const [width, height] = window.getMinimumSize()
      window.setSize(width, height)
    }, null)
    const page = mergelane.page
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Downloads', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByText('Merged speed', { exact: true })).toBeInViewport()
    const about = page.getByRole('region', { name: 'About combined speed' })
    await about.getByText('VPNs come first.').scrollIntoViewIfNeeded()
    await expect(about.getByText('VPNs come first.')).toBeInViewport()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true)
  })

  test('a throttled download shows its progress and each network’s speed', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 32 * BLOCK, bytesPerSecond: 128 * 1024 })
    await mergelane.start(origin.url(), origin.sha256)
    const page = mergelane.page
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()

    const downloads = page.getByRole('region', { name: 'Active downloads' })
    const row = downloads.getByRole('listitem').filter({ hasText: 'test.bin' })
    await expect(row).toBeVisible()
    const progress = row.getByRole('progressbar', { name: 'test.bin progress' })
    await expect
      .poll(async () => Number(await progress.getAttribute('aria-valuenow')))
      .toBeGreaterThan(0)
    await expect(row).toContainText(/\d+% · [\d.]+ [KM]B of 2\.0 MB/)
    await expect(row).toContainText(/[\d.]+ [KM]B\/s/)
    await expect(page.getByText(/^1 downloading/)).toBeVisible()
    await expect(
      page.getByRole('img', {
        name: /^Merged throughput over the last minute, split by network\. Now /
      })
    ).toBeVisible()

    // The network carrying it says how fast; the hero's chart now has something to draw.
    const network = page
      .getByRole('region', { name: 'Networks' })
      .getByRole('listitem', { name: 'a' })
    await expect(network).toContainText(/[\d.]+ [KM]B\/s/)
    await expect(
      page.getByText('Each network’s speed is drawn here while something downloads.')
    ).toBeHidden()

    // The row opens the download's details.
    await row.getByRole('button', { name: 'test.bin' }).click()
    await expect(page.getByRole('list', { name: 'Networks', exact: true })).toBeVisible()

    await mergelane.waitForHttpStatus('completed', 40_000)
    // The sidebar's places, not the download screen's own way back to the list.
    const places = page.getByRole('navigation', { name: 'Mergelane' })
    await places.getByRole('button', { name: 'Downloads', exact: true }).click()
    await places.getByRole('button', { name: 'Dashboard', exact: true }).click()
    await expect(downloads.getByText('Nothing downloading')).toBeVisible()
  })

  test('a network that drops and comes back is logged, and what was left is said', async ({
    mergelane
  }) => {
    const page = mergelane.page
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    const failover = page.getByRole('region', { name: 'Failover' })
    const log = failover.getByRole('log', { name: 'Network changes' })

    await setNetworks(mergelane, {})
    await expect(log.getByRole('listitem').first()).toContainText('a dropped, no network left')
    await expect(failover).toContainText(
      'a is gone. Downloads wait until a network is back, then pick up where they were.'
    )
    const networks = page.getByRole('region', { name: 'Networks' })
    await expect(networks.getByText('No networks connected')).toBeVisible()
    await expect(networks.getByRole('button', { name: 'Scan again' })).toBeVisible()

    await setNetworks(mergelane, { a: NETWORKS.a })
    await expect(log.getByRole('listitem').first()).toContainText(/^a came back after \d+s/)
    await expect(log.getByRole('listitem')).toHaveCount(2)
    await expect(failover).toContainText('Only a is connected')
  })

  test('a speed limit on a network shows as Limited, with the limit', async ({ mergelane }) => {
    await mergelane.api.updateSettings({ networkPreferences: { a: { speedLimit: 1024 ** 2 } } })
    await mergelane.relaunch()
    const page = mergelane.page
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Networks' }).getByRole('listitem', { name: 'a' })
    ).toContainText('Limited to 1 MB/s')
  })
})

test.describe('Dashboard with system merge @smoke', () => {
  test('while merging is on, each link’s merged traffic is charted; off, it says where it will be', async ({
    mergelane
  }) => {
    const fake = await startFakeDaemon()
    try {
      fake.state = 'on'
      await mergelane.relaunch({
        MERGELANE_E2E_DAEMON_SOCKET: fake.path,
        MERGELANE_E2E_DAEMON_INSTALLED: '1'
      })
      const page = mergelane.page
      await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
      const otherApps = page.getByRole('region', { name: 'Other apps' })
      const toggle = otherApps.getByRole('switch', { name: 'System merge' })
      await expect(toggle).toBeChecked()

      const traffic = otherApps.getByRole('region', { name: 'Merged traffic by network' })
      const up = traffic.getByRole('listitem').filter({ hasText: 'feth10' })
      const down = traffic.getByRole('listitem').filter({ hasText: 'feth20' })
      await expect(up).toContainText('peak 2.4 MB/s')
      await expect(up.getByRole('img', { name: /^feth10: 2\.4 MB\/s merged now/ })).toBeVisible()
      await expect(down).toContainText('No internet')
      // Failover says what a link without internet means for other apps.
      await expect(page.getByRole('region', { name: 'Failover' })).toContainText(
        'System merge: feth20 has no internet, so other apps’ new connections use the other networks.'
      )

      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await expect(traffic).toBeHidden()
      await expect(otherApps).toContainText(
        'While it’s on, each network’s merged traffic shows here.'
      )
    } finally {
      await fake.close()
    }
  })
})

test.describe('Dashboard with two networks @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('both networks carry a download, each with its own speed', async ({ mergelane, serve }) => {
    const origin = await serve({ size: 48 * BLOCK, bytesPerSecond: 128 * 1024 })
    await mergelane.start(origin.url(), origin.sha256, { networks: ['a', 'b'] })
    const page = mergelane.page
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    const networks = page.getByRole('region', { name: 'Networks' })
    for (const id of ['a', 'b']) {
      await expect(networks.getByRole('listitem', { name: id })).toContainText(/[\d.]+ [KM]B\/s/)
    }
    await expect(page.getByRole('region', { name: 'Failover' })).toContainText(
      'All 2 networks are connected.'
    )
    await mergelane.waitForHttpStatus('completed', 40_000)
  })
})
