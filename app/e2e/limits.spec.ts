import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPeriodKey, nextDataReset } from '../src/shared/dataLimits'
import type { Wire } from 'webtorrent'
import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm } from './torrentSwarm'

// Speed & data limits (main/network/limits.ts): every byte received goes through them, whether
// an HTTP response's or a torrent peer's, and every torrent block sent goes through the upload
// limits and counts toward its network's data limit. The checks fixture verifies each finished
// download's bytes, which is what matters most here: holding a connection back must never garble it.

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
      await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data))
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
        await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
          networks: ['a']
        })
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

  // Slow mode holds uploads too (owner, 2026-11-11): its speed for all downloads, and the same
  // again, a bucket of its own, for all uploads. Once Mergelane has half the torrent the seeder
  // leaves and another client joins: Mergelane then receives nothing but that client's requests,
  // so the download limits, which hold back what's read, can't slow uploads in passing, and the
  // other client wants all Mergelane has. The control sets the total speed limit to the same
  // speed instead: it holds downloads only, so uploads run past the bound. The download can't
  // finish without a seeder, so it's cancelled (and the checks fixture sees nothing left behind).
  const SLOW_CASES = [
    {
      scope: 'speed-limit',
      title: 'a total speed limit alone leaves torrent uploads to run past it',
      settings: { speedLimit: UPLOAD_LIMIT }
    },
    {
      scope: 'slow-mode',
      title: 'slow mode holds torrent uploads to its speed too',
      settings: { slowMode: true, slowModeSpeed: UPLOAD_LIMIT }
    }
  ] as const
  for (const [index, { scope, title, settings }] of SLOW_CASES.entries()) {
    test(title, async ({ mergelane }) => {
      const swarm = await new Swarm().start()
      try {
        const data = seededBytes(2 * 1024 * KB, 40 + index)
        const seeder = await swarm.seed([named(data, `slow-${scope}.bin`)], {
          pieceLength: 64 * KB,
          uploadLimit: 160 * KB
        })
        const id = await mergelane.start(await swarm.torrentFileOnDisk(seeder), sha256(data), {
          networks: ['a']
        })
        await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 2, 30_000)
        await mergelane.api.updateSettings(settings)
        await new Promise<void>((resolve) => seeder.destroy({}, () => resolve()))
        const started = Date.now()
        await swarm.leech(seeder)
        await new Promise((resolve) => setTimeout(resolve, 6000))
        const sent = (await mergelane.currentTorrent())!.bytesUploaded
        const seconds = (Date.now() - started) / 1000
        // As the upload limit tests bound it: the speed for the time, a second's worth a bucket may
        // hold, and one 16 KB block.
        const allowed = UPLOAD_LIMIT * (seconds + 1) + 16 * KB
        if (scope === 'speed-limit') {
          expect(sent).toBeGreaterThan(allowed)
        } else {
          expect(sent, 'it did upload').toBeGreaterThan(0)
          expect(sent).toBeLessThanOrEqual(allowed)
        }
        await mergelane.api.cancelDownload(id)
        await mergelane.waitForTorrentStatus('cancelled')
      } finally {
        await swarm.stop()
      }
    })
  }
})

// Uploads count toward data limits (owner, 2026-11-11): carriers count both directions. Downloads
// go over a and uploads over b, so b carries nothing but uploads (and a few protocol messages it
// receives, far under the limit): what takes it to its limit is uploads alone. Then it stops: its
// peers are dropped, and nothing more goes out over it.
test.describe('data limits and uploads', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for the second network')

  test('a network’s data limit is reached by uploads alone, and then it stops uploading', async ({
    mergelane
  }) => {
    const LIMIT = 256 * KB
    const swarm = await new Swarm().start()
    try {
      const data = seededBytes(4 * 1024 * KB, 45)
      const torrent = await swarm.seed([named(data, 'upload-limit.bin')], {
        pieceLength: 64 * KB,
        uploadLimit: 400 * KB
      })
      // Another client, counting what it receives from Mergelane over b (from the LAN address,
      // where nothing else in the swarm is). It announces first, so Mergelane dials it, over a and
      // its twin over b; it wants nothing until Mergelane has half the torrent to give it.
      const other = await swarm.leech(torrent, { deselect: true })
      await new Promise((resolve) => other.once('trackerAnnounce', resolve))
      let overB = 0
      other.on('wire', (wire: Wire, address: string) => {
        if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
        wire.on('download', (bytes: number) => (overB += bytes))
      })
      await mergelane.api.updateSettings({
        routing: { down: 'a', up: 'b', fallback: true },
        networkPreferences: { b: { dataLimit: LIMIT } }
      })

      await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
        networks: ['a', 'b']
      })
      await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 2, 30_000)
      other.files.forEach((file) => file.select())

      await expect
        .poll(async () => (await mergelane.api.networkUsage()).b ?? 0, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(LIMIT)
      // Blocks already on their way still land; nothing more goes out over b after that.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const stoppedAt = overB
      const stopped = (await mergelane.currentTorrent())!.networks.find(
        (network) => network.id === 'b'
      )!

      const done = await mergelane.waitForTorrentStatus('completed', 60_000)
      const b = done.networks.find((network) => network.id === 'b')!
      expect(b.bytesDownloaded, 'b downloads nothing').toBe(0)
      expect(stoppedAt, 'the other client received over b').toBeGreaterThan(0)
      expect(overB, 'nothing more received over b').toBe(stoppedAt)
      expect(b.bytesUploaded).toBe(stopped.bytesUploaded)
      // Stopped at the limit: past it by no more than what was in flight when it was reached.
      expect(b.bytesUploaded).toBeGreaterThanOrEqual(LIMIT - 16 * KB)
      expect(b.bytesUploaded).toBeLessThanOrEqual(LIMIT + 8 * 16 * KB)
      // What b used is its uploads, bar the protocol messages it received.
      const used = (await mergelane.api.networkUsage()).b ?? 0
      expect(used).toBeGreaterThanOrEqual(b.bytesUploaded)
      expect(used - b.bytesUploaded).toBeLessThan(LIMIT / 4)
    } finally {
      await swarm.stop()
    }
  })
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
