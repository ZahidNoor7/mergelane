import { expect, test } from '@playwright/test'
import { NetworkTraffic } from '../src/main/network/trafficCounters'

// Each network's speed from every app, for the Dashboard's total (ADR-0070): the main process's sampler, run in
// Node with a stand-in for the counters, and once against this Mac's own.

test.describe('network traffic from the counters @smoke', () => {
  test('a speed needs two readings; readings close together share one; a long gap starts again', async () => {
    let counters = new Map([['en0', { rx: 1_000, tx: 100 }]])
    const traffic = new NetworkTraffic(async () => () => counters)
    expect(await traffic.sample(['en0'], 10_000)).toEqual({})
    counters = new Map([['en0', { rx: 3_000, tx: 600 }]])
    expect(await traffic.sample(['en0', 'en7'], 11_000)).toEqual({ en0: { rx: 2_000, tx: 500 } })
    // Asked again at once: the same speeds, not a reading over a few milliseconds.
    counters = new Map([['en0', { rx: 9_999_999, tx: 9_999_999 }]])
    expect(await traffic.sample(['en0'], 11_200)).toEqual({ en0: { rx: 2_000, tx: 500 } })
    // Nothing asked for a minute: no average over it.
    expect(await traffic.sample(['en0'], 71_200)).toEqual({})
  })

  test('null where the counters can’t be read', async () => {
    expect(await new NetworkTraffic(async () => null).sample(['en0'])).toBeNull()
    expect(
      await new NetworkTraffic(async () => {
        throw new Error('no libc')
      }).sample(['en0'])
    ).toBeNull()
    expect(await new NetworkTraffic(async () => () => null).sample(['en0'])).toBeNull()
    expect(
      await new NetworkTraffic(async () => () => {
        throw new Error('sysctl')
      }).sample(['en0'])
    ).toBeNull()
  })

  test('this Mac’s own counters: loopback moves as bytes cross it', async () => {
    test.skip(process.platform !== 'darwin', 'the Mac’s counters')
    const traffic = new NetworkTraffic()
    expect(await traffic.sample(['lo0', 'nonexistent0'])).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const rates = await traffic.sample(['lo0', 'nonexistent0'])
    expect(Object.keys(rates!)).toEqual(['lo0'])
    expect(rates!.lo0.rx).toBeGreaterThanOrEqual(0)
    expect(rates!.lo0.tx).toBeGreaterThanOrEqual(0)
  })
})
