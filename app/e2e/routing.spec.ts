import {
  BLOCK,
  expect,
  interfacesEnv,
  LAN_ADDRESS,
  NETWORKS,
  test,
  type MergelaneApp
} from './fixtures'
import type { DownloadState } from '../src/shared/types'

// Networks › Which network carries what (M3.5a, docs/DECISIONS.md ADR-0040), on running HTTP
// downloads over two test networks: a (loopback) and b (this Mac's LAN address).

const setNetworks = (mergelane: MergelaneApp, networks: Record<string, string>): Promise<void> =>
  mergelane.evaluateMain((_electron, value) => {
    process.env['MERGELANE_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

const status = (state: DownloadState, id: string): string | undefined =>
  state.networks.find((entry) => entry.id === id)?.status
const streamsOn = (state: DownloadState, id: string): number =>
  state.kind === 'http' ? state.streams.filter((stream) => stream.interfaceId === id).length : 0

test.describe('routing downloads @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('pinned to one network, a running download moves onto it; back on all, it spreads again', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    await mergelane.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    await mergelane.waitUntil((state) => streamsOn(state, 'a') > 0 && streamsOn(state, 'b') > 0)

    await mergelane.api.updateSettings({ routing: { down: 'b', fallback: true } })
    const pinned = await mergelane.waitUntil(
      (state) => status(state, 'a') === 'routed' && streamsOn(state, 'a') === 0
    )
    expect(status(pinned, 'b')).toBe('on')
    // The download's own choice is kept for later.
    expect(pinned.networks.find((entry) => entry.id === 'a')?.enabled).toBe(true)

    await mergelane.api.updateSettings({ routing: { down: 'all', fallback: true } })
    await mergelane.waitUntil((state) => status(state, 'a') === 'on' && streamsOn(state, 'a') > 0)
    await mergelane.waitForHttpStatus('completed')
  })

  test('the chosen network dropping: with fallback the others stand in; without, it waits', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    // Started on a only: routing to b brings b in, the download's own pick notwithstanding.
    await mergelane.api.updateSettings({ routing: { down: 'b', fallback: true } })
    await mergelane.start(origin.url(), origin.sha256, { networks: ['a'], connections: 2 })
    await mergelane.waitUntil(
      (state) => streamsOn(state, 'b') > 0 && status(state, 'a') === 'routed'
    )

    // b drops: fallback puts the download's own network, a, back to work.
    await setNetworks(mergelane, { a: NETWORKS['a'] })
    await mergelane.waitUntil((state) => status(state, 'a') === 'on' && streamsOn(state, 'a') > 0)

    // Without fallback, nothing carries it until b is back.
    await mergelane.api.updateSettings({ routing: { down: 'b', fallback: false } })
    const waiting = await mergelane.waitUntil(
      (state) => status(state, 'a') === 'routed' && streamsOn(state, 'a') === 0
    )
    expect(waiting.status).toBe('downloading')
    await setNetworks(mergelane, NETWORKS)
    await mergelane.waitUntil((state) => status(state, 'b') === 'on' && streamsOn(state, 'b') > 0)
    await mergelane.api.updateSettings({ routing: { down: 'all', fallback: true } })
    await mergelane.waitForHttpStatus('completed')
  })
})
