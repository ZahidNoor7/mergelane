import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localDay } from '../src/shared/networkActivity'
import { savedByMerging } from '../src/shared/usage'
import { BLOCK, expect, LAN_ADDRESS, test, type MergelaneApp } from './fixtures'

// Daily usage, recorded for Reports (docs/plans/2026-11-new-features-plan.md, feature 8; ADR-0082):
// each network's bytes a day, the time with traffic and the time merging saved, in mergelane.db.

const SIZE = 32 * BLOCK

type Row = Record<string, string | number | null>

/** Reads the database the app wrote, once it has quit. */
function read<T extends Row>(userData: string, sql: string, ...values: (string | number)[]): T[] {
  const db = new DatabaseSync(join(userData, 'mergelane.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...values) as T[]
  } finally {
    db.close()
  }
}

async function today(mergelane: MergelaneApp): Promise<{
  networks: { networkId: string; name: string; kind: string; bytes: number }[]
  busyMs: number
  savedMs: number
}> {
  const day = localDay(Date.now())
  const report = await mergelane.api.usageReport(day)
  const saved = report.days.find((row) => row.day === day)
  return {
    networks: report.networks.filter((row) => row.day === day),
    busyMs: saved?.busyMs ?? 0,
    savedMs: saved?.savedMs ?? 0
  }
}

test.describe('daily usage @smoke', () => {
  test('a download’s bytes are counted for today on each network it used, and kept at quit', async ({
    mergelane,
    serve,
    dirs
  }) => {
    // Slow enough per connection that every network gets some of it.
    const origin = await serve({ size: SIZE, bytesPerSecond: 512 * 1024 })
    const id = await mergelane.start(origin.url('/files/counted.bin'), origin.sha256, {
      networks: LAN_ADDRESS ? ['a', 'b'] : ['a'],
      connections: 2
    })
    const done = await mergelane.waitForHttpStatus('completed', 30_000)
    const carried = done.networks.filter((network) => network.bytesDownloaded > 0)
    // With a LAN address as the second network, both carry some, so merging saved time.
    expect(carried).toHaveLength(LAN_ADDRESS ? 2 : 1)

    const counted = await today(mergelane)
    // Everything received counts, a retried piece too: at least what each network delivered.
    for (const network of carried) {
      const row = counted.networks.find((entry) => entry.networkId === network.id)
      expect(row?.bytes).toBeGreaterThanOrEqual(network.bytesDownloaded)
      expect(row?.name).toBe(network.id)
      expect(row?.kind).toBe('ethernet')
    }
    const total = counted.networks.reduce((sum, row) => sum + row.bytes, 0)
    expect(total).toBeGreaterThanOrEqual(SIZE)
    expect(counted.busyMs).toBeGreaterThanOrEqual(1000)
    if (LAN_ADDRESS) expect(counted.savedMs).toBeGreaterThan(0)
    else expect(counted.savedMs).toBe(0)

    // Written at quit: the same, read from the file.
    await mergelane.quit()
    const day = localDay(Date.now())
    const written = read<{ network_id: string; bytes: number }>(
      dirs.userData,
      'SELECT network_id, bytes FROM usage_days WHERE day = ? ORDER BY network_id',
      day
    )
    expect(written).toEqual(
      counted.networks.map((row) => ({ network_id: row.networkId, bytes: row.bytes }))
    )
    const [saved] = read<{ busy_ms: number; saved_ms: number }>(
      dirs.userData,
      'SELECT busy_ms, saved_ms FROM usage_saved WHERE day = ?',
      day
    )
    expect(saved).toEqual({ busy_ms: counted.busyMs, saved_ms: counted.savedMs })

    // The download's own time saved: its active time against the network that carried the most.
    const [own] = read<{ active_ms: number; saved_ms: number }>(
      dirs.userData,
      'SELECT active_ms, saved_ms FROM downloads WHERE id = ?',
      id
    )
    expect(own.active_ms).toBeGreaterThan(0)
    if (LAN_ADDRESS) expect(own.saved_ms).toBeGreaterThan(0)
    expect(own.saved_ms).toBe(
      savedByMerging(
        own.active_ms,
        carried.map((network) => network.bytesDownloaded)
      )
    )
  })

  test('a later launch adds to the same day, and Clear history leaves usage alone', async ({
    mergelane,
    serve
  }) => {
    const first = await serve({ size: SIZE, seed: 2 })
    const firstId = await mergelane.start(first.url('/files/one.bin'), first.sha256)
    await mergelane.waitForHttpStatus('completed')
    const before = await today(mergelane)
    await mergelane.quit()
    await mergelane.launch()

    const second = await serve({ size: SIZE, seed: 3 })
    await mergelane.start(second.url('/files/two.bin'), second.sha256)
    await mergelane.waitUntil(
      (state) => state.fileName === 'two.bin' && state.status === 'completed'
    )
    const after = await today(mergelane)
    // One row a network a day, its bytes added up.
    expect(new Set(after.networks.map((row) => row.networkId)).size).toBe(after.networks.length)
    const sum = (rows: { bytes: number }[]): number =>
      rows.reduce((total, row) => total + row.bytes, 0)
    expect(sum(after.networks)).toBeGreaterThanOrEqual(sum(before.networks) + SIZE)
    expect(after.busyMs).toBeGreaterThan(before.busyMs)

    await mergelane.api.removeDownload(firstId)
    expect(await mergelane.api.forgetHistory()).toBe(1)
    expect(await today(mergelane)).toEqual(after)
  })

  test('a report from tomorrow has nothing in it', async ({ mergelane, serve }) => {
    const origin = await serve({ size: SIZE, seed: 4 })
    await mergelane.start(origin.url('/files/later.bin'), origin.sha256)
    await mergelane.waitForHttpStatus('completed')
    const tomorrow = localDay(Date.now() + 86_400_000)
    expect(await mergelane.api.usageReport(tomorrow)).toEqual({ networks: [], days: [] })
  })
})
