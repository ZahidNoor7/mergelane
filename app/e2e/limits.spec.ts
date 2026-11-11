import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPeriodKey, nextDataReset } from '../src/shared/dataLimits'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// Speed & data limits (main/network/limits.ts): every byte received goes through them, whether
// an HTTP response's or a torrent peer's. The checks fixture verifies each finished download's
// bytes, which is what matters most here: holding a connection back must never garble it.

const KB = 1024

test.describe('speed and data limits', () => {
  test('a total speed limit holds a download to it', async ({ mergelane, serve }) => {
    const origin = await serve({ size: 16 * BLOCK })
    await mergelane.api.updateSettings({ speedLimit: 256 * KB })
    const started = Date.now()
    await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('completed', 30_000)
    // 1 MB at 256 KB/s: four seconds, less the second's worth a bucket may hold.
    expect(Date.now() - started).toBeGreaterThan(2500)
  })

  test('slow mode holds downloads to its speed, the default one included', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 96 * BLOCK })
    // Switched on as the status bar does, its speed never changed: 2 MB/s.
    await mergelane.api.updateSettings({ slowMode: true })
    const started = Date.now()
    await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForHttpStatus('completed', 30_000)
    // 6 MB at 2 MB/s: three seconds, less the second's worth a bucket may hold.
    expect(Date.now() - started).toBeGreaterThan(1800)
  })

  for (const period of ['day', 'week', 'month'] as const) {
    test(`a network stops at its ${period} limit and resumes when it is raised`, async ({
      mergelane,
      serve
    }) => {
      const origin = await serve({ size: 16 * BLOCK })
      await mergelane.api.updateSettings({
        networkPreferences: { a: { dataLimit: 4 * BLOCK, dataLimitPeriod: period } }
      })
      const id = await mergelane.start(origin.url(), origin.sha256)

      const stopped = await mergelane.waitUntil((state) =>
        state.networks.some((network) => network.id === 'a' && network.status === 'limit')
      )
      expect(stopped.status).toBe('downloading')
      expect(stopped.bytesDownloaded).toBeLessThan(16 * BLOCK)
      expect((await mergelane.api.networkUsage()).a).toBeGreaterThanOrEqual(4 * BLOCK)

      await mergelane.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 * BLOCK, dataLimitPeriod: period } }
      })
      await mergelane.waitForHttpStatus('completed')
      expect((await mergelane.byId(id))?.status).toBe('completed')
    })
  }

  test('a torrent under a speed limit still arrives whole', async ({ mergelane }) => {
    const swarm = await new Swarm().start()
    try {
      const data = seededBytes(1024 * KB, 31)
      const torrent = await swarm.seed([named(data, 'limited.bin')], { pieceLength: 64 * KB })
      await mergelane.api.updateSettings({ speedLimit: 384 * KB })
      const started = Date.now()
      await mergelane.start(await torrentFileOnDisk(torrent), sha256(data))
      await mergelane.waitForTorrentStatus('completed', 30_000)
      expect(Date.now() - started).toBeGreaterThan(1500)
    } finally {
      await swarm.stop()
    }
  })

  // Upload limits (ADR-0041): every block a peer is sent waits its turn under them. Another client
  // joins once Mergelane has half the torrent from a slow seeder, so it wants all Mergelane can
  // send it. Without a limit, Mergelane sends more than the limit would allow: the check has teeth.
  const UPLOAD_LIMIT = 32 * KB
  const UPLOAD_CASES = [
    {
      scope: 'none',
      title: 'with no upload limit, torrent uploads run past 32 KB/s',
      settings: {}
    },
    {
      scope: 'total',
      title: 'a total upload limit holds torrent uploads to it',
      settings: { uploadLimit: UPLOAD_LIMIT }
    },
    {
      scope: 'network',
      title: 'a network’s upload limit holds torrent uploads to it',
      settings: { networkPreferences: { a: { uploadLimit: UPLOAD_LIMIT } } }
    }
  ] as const
  for (const [index, { scope, title, settings }] of UPLOAD_CASES.entries()) {
    test(title, async ({ mergelane }) => {
      const swarm = await new Swarm().start()
      try {
        const data = seededBytes(2 * 1024 * KB, 32 + index)
        const torrent = await swarm.seed([named(data, `uploads-${scope}.bin`)], {
          pieceLength: 64 * KB,
          uploadLimit: 160 * KB
        })
        await mergelane.api.updateSettings(settings)
        await mergelane.start(await torrentFileOnDisk(torrent), sha256(data), { networks: ['a'] })
        await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 2, 30_000)
        // Nothing can be uploaded before there's someone to upload to.
        const started = Date.now()
        await swarm.leech(torrent)
        const done = await mergelane.waitForTorrentStatus('completed', 60_000)
        const seconds = (Date.now() - started) / 1000
        // The limit for the time it ran, plus the second's worth a bucket may hold, plus one 16 KB
        // block: a held block's timer is rounded to whole ms, so it may go out a moment early.
        // (Measured: a limited run lands within a block of this; an unlimited one, five times it.)
        const allowed = UPLOAD_LIMIT * (seconds + 1) + 16 * KB
        if (scope === 'none') {
          expect(done.bytesUploaded).toBeGreaterThan(allowed)
        } else {
          expect(done.bytesUploaded, 'it did upload').toBeGreaterThan(0)
          expect(done.bytesUploaded).toBeLessThanOrEqual(allowed)
        }
      } finally {
        await swarm.stop()
      }
    })
  }
})

test('usage survives period switches and restart, and expired calendar periods reset', async ({
  mergelane,
  dirs
}) => {
  await mergelane.quit()
  const now = Date.now()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      version: 2,
      periods: Object.fromEntries(
        ['day', 'week', 'month'].map((period, index) => [
          period,
          {
            key: dataPeriodKey(period as 'day' | 'week' | 'month', now),
            bytes: { a: (index + 1) * 1024 }
          }
        ])
      )
    })
  )
  await mergelane.launch()
  for (const [period, count] of [
    ['day', 1024],
    ['week', 2048],
    ['month', 3072]
  ] as const) {
    await mergelane.api.updateSettings({
      networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
    })
    expect((await mergelane.api.networkUsage()).a).toBe(count)
  }
  await mergelane.quit()
  await mergelane.launch()
  expect((await mergelane.api.networkUsage()).a).toBe(3072)
  const future = nextDataReset('month', now).getTime() + 8 * 86400_000
  await mergelane.evaluateMain((_electron, at) => {
    const original = Date.now
    ;(globalThis as Record<string, unknown>).__originalDateNow = original
    Date.now = () => at
  }, future)
  try {
    for (const period of ['day', 'week', 'month'] as const) {
      await mergelane.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
      })
      expect((await mergelane.api.networkUsage()).a ?? 0).toBe(0)
    }
  } finally {
    await mergelane.evaluateMain(() => {
      Date.now = (globalThis as Record<string, unknown>).__originalDateNow as () => number
      delete (globalThis as Record<string, unknown>).__originalDateNow
    }, null)
  }
})

test('existing monthly usage remains available after migration', async ({ mergelane, dirs }) => {
  await mergelane.quit()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      month: dataPeriodKey('month', Date.now()),
      bytes: { a: 12345 }
    })
  )
  await mergelane.launch()
  expect((await mergelane.api.networkUsage()).a).toBe(12345)
  await mergelane.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'day' } } })
  expect((await mergelane.api.networkUsage()).a).toBe(0)
  await mergelane.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'month' } } })
  expect((await mergelane.api.networkUsage()).a).toBe(12345)
})

test('calendar periods use local midnight, Monday weeks, and correct year boundaries', () => {
  const sunday = new Date(2026, 9, 4, 23, 59, 59, 999).getTime()
  const monday = new Date(2026, 9, 5).getTime()
  expect(dataPeriodKey('week', sunday)).toBe('2026-09-28')
  expect(dataPeriodKey('week', monday)).toBe('2026-10-05')
  expect(nextDataReset('day', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', monday).getTime()).toBe(new Date(2026, 9, 12).getTime())
  expect(nextDataReset('month', new Date(2026, 11, 31, 23).getTime()).getTime()).toBe(
    new Date(2027, 0, 1).getTime()
  )
  expect(dataPeriodKey('month', new Date(2027, 0, 1).getTime())).toBe('2027-01')
})

for (const period of ['day', 'week', 'month'] as const) {
  test(`resetting ${period} usage preserves other periods and networks and survives restart`, async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: BLOCK })
    await mergelane.start(origin.url(), origin.sha256)
    await mergelane.waitForStatus('completed')
    const before = await mergelane.api.networkUsage()
    const id = Object.keys(before).find((key) => before[key] > 0)!
    expect(id).toBeTruthy()
    await mergelane.api.updateSettings({
      networkPreferences: { [id]: { dataLimitPeriod: period } }
    })
    await mergelane.api.resetNetworkUsage(id)
    expect((await mergelane.api.networkUsage())[id]).toBe(0)
    for (const [other, bytes] of Object.entries(before)) {
      if (other !== id) expect((await mergelane.api.networkUsage())[other]).toBe(bytes)
    }
    for (const otherPeriod of ['day', 'week', 'month'] as const) {
      if (otherPeriod === period) continue
      await mergelane.api.updateSettings({
        networkPreferences: { [id]: { dataLimitPeriod: otherPeriod } }
      })
      expect((await mergelane.api.networkUsage())[id]).toBe(before[id])
    }
    await mergelane.api.updateSettings({
      networkPreferences: { [id]: { dataLimitPeriod: period } }
    })
    await mergelane.relaunch()
    expect((await mergelane.api.networkUsage())[id]).toBe(0)
  })
}
