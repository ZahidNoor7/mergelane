import {
  BLOCK,
  expect,
  interfacesEnv,
  LAN_ADDRESS,
  NETWORKS,
  test,
  type MergelaneApp
} from './fixtures'
import type { LoggedRequest } from './origin'
import type { DownloadState } from '../src/shared/types'

// Networks › each network's role for downloads: Use, Standby or Don't use (M3.10,
// docs/DECISIONS.md ADR-0045), on running HTTP downloads over two test networks: a (loopback) and
// b (this Mac's LAN address).

const setNetworks = (mergelane: MergelaneApp, networks: Record<string, string>): Promise<void> =>
  mergelane.evaluateMain((_electron, value) => {
    process.env['MERGELANE_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

const overB = (request: Pick<LoggedRequest, 'from'>): boolean => request.from !== '127.0.0.1'
const network = (state: DownloadState, id: string): DownloadState['networks'][number] | undefined =>
  state.networks.find((entry) => entry.id === id)
const status = (state: DownloadState, id: string): string | undefined => network(state, id)?.status
const streamsOn = (state: DownloadState, id: string): number =>
  state.kind === 'http' ? state.streams.filter((stream) => stream.interfaceId === id).length : 0
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Picks `role` for network `id` the way the Networks screen does: its line's pop-up. */
async function pickRole(
  mergelane: MergelaneApp,
  id: string,
  from: string,
  role: 'Use' | 'Standby' | 'Don’t use'
): Promise<void> {
  const { page } = mergelane
  await page.getByRole('button', { name: `${id} for downloads: ${from}` }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${role}`) }).click()
  await expect(page.getByRole('button', { name: `${id} for downloads: ${role}` })).toBeVisible()
}

test.describe('network roles @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('a Standby network waits while a Use network is connected, stands in while it is gone, and stops once it is back', async ({
    mergelane,
    serve
  }) => {
    await mergelane.api.updateSettings({ networkPreferences: { b: { role: 'standby' } } })
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    await mergelane.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })

    // a is connected: b, though on in the download, carries nothing.
    const waiting = await mergelane.waitUntil(
      (state) => status(state, 'b') === 'standby' && streamsOn(state, 'a') > 0
    )
    expect(network(waiting, 'b')?.enabled, 'the download’s own choice is kept').toBe(true)
    await settle(1000)
    expect(streamsOn((await mergelane.currentHttp())!, 'b')).toBe(0)
    expect(origin.log.some(overB), 'nothing over b while a is connected').toBe(false)

    // a drops: b stands in.
    await setNetworks(mergelane, { b: NETWORKS['b'] })
    await mergelane.waitUntil(
      (state) =>
        status(state, 'a') === 'offline' && status(state, 'b') === 'on' && streamsOn(state, 'b') > 0
    )
    await mergelane.waitUntil(() => origin.log.some(overB))

    // a is back: b steps aside again, and a carries the rest.
    await setNetworks(mergelane, NETWORKS)
    await mergelane.waitUntil(
      (state) =>
        status(state, 'b') === 'standby' && streamsOn(state, 'b') === 0 && streamsOn(state, 'a') > 0
    )
    const backAt = origin.log.length
    await settle(1000)
    expect(origin.log.slice(backAt).some(overB), 'nothing more over b once a is back').toBe(false)
    const done = await mergelane.waitForHttpStatus('completed')
    expect(network(done, 'b')!.bytesDownloaded).toBeGreaterThan(0)
  })

  test('Don’t use never carries; Standby carries when no network is set to Use; both kept across a relaunch', async ({
    mergelane,
    serve
  }) => {
    await mergelane.place('Networks')
    await pickRole(mergelane, 'b', 'Use', 'Don’t use')
    await pickRole(mergelane, 'a', 'Use', 'Standby')
    await expect(
      mergelane.page.getByText('Standby: used only when no network set to Use is connected')
    ).toBeVisible()

    const origin = await serve({ size: 64 * BLOCK, bytesPerSecond: 512 * 1024 })
    await mergelane.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    // No network is set to Use, so the Standby one, a, carries it; b never does.
    await mergelane.waitUntil(
      (state) => status(state, 'b') === 'unused' && streamsOn(state, 'a') > 0
    )
    const done = await mergelane.waitForHttpStatus('completed')
    expect(network(done, 'b')!.bytesDownloaded).toBe(0)
    expect(origin.log.some(overB), 'nothing ever over b').toBe(false)

    await mergelane.relaunch()
    await mergelane.place('Networks')
    await expect(
      mergelane.page.getByRole('button', { name: 'b for downloads: Don’t use' })
    ).toBeVisible()
    await expect(
      mergelane.page.getByRole('button', { name: 'a for downloads: Standby' })
    ).toBeVisible()
    // Back to Use: it's saved as the default again.
    await pickRole(mergelane, 'a', 'Standby', 'Use')
  })
})
