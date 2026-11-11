import type { Torrent, Wire } from 'webtorrent'
import { expect, LAN_ADDRESS, test, treeSha } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm } from './torrentSwarm'

// Downloading torrents: every byte right, every peer on a network, and the networks' controls,
// pause and relaunch working as they do for HTTP. The swarm is local (see torrentSwarm.ts); the
// checks fixture verifies each finished download's bytes and that nothing else was left behind.

const KB = 1024
const MB = 1024 * KB
const PIECE = 64 * KB

let swarm: Swarm
test.beforeEach(async () => {
  swarm = await new Swarm().start()
})
test.afterEach(async () => {
  await swarm.stop()
})

test.describe('torrent downloads @smoke', () => {
  test('a single-file torrent', async ({ mergelane }) => {
    const data = seededBytes(2 * MB, 11)
    const torrent = await swarm.seed([named(data, 'movie.mkv')], { pieceLength: PIECE })

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data))
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    expect(done.kind).toBe('torrent')
    expect(done.fileName).toBe('movie.mkv')
    expect(done.totalPieces).toBe((2 * MB) / PIECE)
  })

  test('a torrent of several files, published as its folder', async ({ mergelane }) => {
    const files = [
      named(seededBytes(300 * KB, 21), 'a.bin'),
      named(seededBytes(700 * KB + 3, 22), 'b.bin'),
      named(seededBytes(5, 23), 'tiny.txt')
    ]
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    const expected = treeSha(
      files.map((data) => ({ path: (data as { name?: string }).name!, data }))
    )
    await mergelane.start(await swarm.torrentFileOnDisk(torrent), expected)
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    expect(done.fileName).toBe('Album')
  })

  test('pause, quit, relaunch and resume: the pieces already done aren’t fetched again', async ({
    mergelane
  }) => {
    const data = seededBytes(6 * MB, 31)
    const file = named(data, 'big.iso')
    // Slow enough to stop partway: three seeders at 300 KB/s each.
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    }

    const id = await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data))
    await mergelane.waitUntil((state) => state.bytesDownloaded >= 2 * MB, 30_000)
    await mergelane.relaunch()
    const paused = await mergelane.waitForTorrentStatus('paused')
    expect(paused.bytesDownloaded).toBeGreaterThanOrEqual(2 * MB)

    const sentBefore = swarm.uploaded()
    await mergelane.api.resumeDownload(id)
    await mergelane.waitForTorrentStatus('completed', 60_000)
    // What was missing, plus at most a few pieces each peer had half-sent when it stopped.
    expect(swarm.uploaded() - sentBefore).toBeLessThanOrEqual(
      data.length - paused.bytesDownloaded + 6 * PIECE
    )
  })
})

test.describe('choosing files @smoke', () => {
  /** Files of sizes that don't line up with pieces, so pieces straddle chosen and skipped ones. */
  function album(size: number, seed: number): Buffer[] {
    return ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((name, index) =>
      named(seededBytes(size + 7 * index + 5, seed + index), name)
    )
  }
  const shaOf = (files: Buffer[]): string =>
    treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))

  test('only the chosen files are downloaded and published', async ({ mergelane }) => {
    const files = album(300 * KB, 61)
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    // a and c chosen: b and d never appear, though the pieces at their edges are fetched.
    await mergelane.start(await swarm.torrentFileOnDisk(torrent), shaOf([files[0], files[2]]), {
      selectedFiles: [0, 2]
    })
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    expect(done.skippedBytes).toBeGreaterThan(0)
    expect(done.bytesDownloaded).toBe(done.totalBytes - done.skippedBytes!)
    expect(done.pieces.filter((piece) => piece.status === 'skipped').length).toBeGreaterThan(0)
  })

  test('the choice is kept through a quit, a relaunch and a resume', async ({ mergelane }) => {
    const files = album(1500 * KB, 71)
    let torrent = await swarm.seed(files, {
      folder: 'Set',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Set',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    const id = await mergelane.start(
      await swarm.torrentFileOnDisk(torrent),
      shaOf([files[1], files[3]]),
      {
        selectedFiles: [1, 3]
      }
    )
    await mergelane.waitUntil((state) => state.bytesDownloaded >= 1 * MB, 30_000)
    const before = await mergelane.currentTorrent()
    await mergelane.relaunch()
    const paused = await mergelane.waitForTorrentStatus('paused')
    expect(paused.skippedBytes).toBe(before!.skippedBytes)
    await mergelane.api.resumeDownload(id)
    await mergelane.waitForTorrentStatus('completed', 60_000)
  })

  test('the choice changes as it runs: a file dropped never appears, one added comes in', async ({
    mergelane
  }) => {
    const files = album(1500 * KB, 81)
    let torrent = await swarm.seed(files, {
      folder: 'Mix',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Mix',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    // a and b chosen, then b swapped for c before either is near done.
    const id = await mergelane.start(
      await swarm.torrentFileOnDisk(torrent),
      shaOf([files[0], files[2]]),
      {
        selectedFiles: [0, 1]
      }
    )
    await mergelane.waitUntil((state) => state.bytesDownloaded > 0, 30_000)
    await mergelane.api.chooseTorrentFiles(id, [0, 2])
    const changed = await mergelane.currentTorrent()
    expect(changed!.status).toBe('downloading')
    expect(changed!.files).toEqual({ chosen: 2, total: 4, selected: [0, 2] })
    await mergelane.waitForTorrentStatus('completed', 60_000)
  })
})

test.describe('torrents over two networks @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for a second network')

  /** Three seeders of `data`, at `uploadLimit` each. */
  async function seedThree(data: Buffer, name: string, uploadLimit?: number): Promise<Torrent> {
    const file = named(data, name)
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    }
    return torrent
  }

  test('both networks carry peers and deliver pieces', async ({ mergelane }) => {
    const data = seededBytes(4 * MB, 41)
    const torrent = await seedThree(data, 'both.bin', 1 * MB)

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    for (const id of ['a', 'b']) {
      const network = done.networks.find((entry) => entry.id === id)!
      expect(network.bytesDownloaded, `network ${id} delivered pieces`).toBeGreaterThan(0)
    }
    const seen = new Set(
      mergelane.sessions.flat().flatMap((state) => (state.kind === 'torrent' ? state.peers : []))
    )
    expect(new Set([...seen].map((peer) => peer.interfaceId))).toEqual(new Set(['a', 'b']))
  })

  test('switching a network off moves its peers to the other', async ({ mergelane }) => {
    const data = seededBytes(6 * MB, 42)
    const torrent = await seedThree(data, 'switch.bin', 300 * KB)

    const id = await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    await mergelane.waitUntil(
      (state) => state.networks.every((network) => network.bytesDownloaded > 0),
      30_000
    )
    await mergelane.api.setDownloadNetwork(id, 'b', false)
    await mergelane.waitUntil(
      (state) => state.kind === 'torrent' && !state.peers.some((peer) => peer.interfaceId === 'b')
    )
    const done = await mergelane.waitForTorrentStatus('completed', 60_000)
    expect(done.networks.find((network) => network.id === 'b')?.enabled).toBe(false)
  })

  test('one seeder is reached over both networks, and fills both', async ({ mergelane }) => {
    const data = seededBytes(8 * MB, 44)
    const torrent = await swarm.seed([named(data, 'twin.bin')], {
      pieceLength: PIECE,
      uploadLimit: 1 * MB
    })

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    for (const id of ['a', 'b']) {
      const network = done.networks.find((entry) => entry.id === id)!
      expect(network.bytesDownloaded, `network ${id} delivered pieces`).toBeGreaterThan(0)
    }
    const seen = new Set(
      mergelane.sessions.flat().flatMap((state) => (state.kind === 'torrent' ? state.peers : []))
    )
    expect(new Set([...seen].map((peer) => peer.interfaceId))).toEqual(new Set(['a', 'b']))
  })
})

test.describe('uploading @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for the network')
  // A USB-tethered network, the one kind once left out: every network uploads, whatever its kind.
  test.use({ appEnv: { MERGELANE_E2E_INTERFACES: `b=${LAN_ADDRESS}==usb` } })

  test('peers get pieces back over every network, USB-tethered ones too', async ({ mergelane }) => {
    const data = seededBytes(4 * MB, 51)
    const torrent = await swarm.seed([named(data, 'shared.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const other = await swarm.leech(torrent)
    let fromMergelane = 0
    let connected = false
    other.on('wire', (wire: Wire, address: string) => {
      // Mergelane dials over network b, from the LAN address. A dual-stack listener reports it
      // IPv4-mapped: ::ffff:<address>:<port>.
      if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
      connected = true
      wire.on('download', (bytes: number) => (fromMergelane += bytes))
    })

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), { networks: ['b'] })
    const done = await mergelane.waitForTorrentStatus('completed', 60_000)
    expect(connected, 'Mergelane connected to the other client').toBe(true)
    expect(fromMergelane, 'what the other client received from Mergelane').toBeGreaterThan(0)
    // What Mergelane shows it sent: at least what arrived (a little may still be in flight at the end).
    const sentOverB = done.networks.find((network) => network.id === 'b')?.bytesUploaded ?? 0
    expect(sentOverB).toBeGreaterThanOrEqual(fromMergelane)
    expect(done.bytesUploaded).toBe(sentOverB)
    // Nothing is moving once it's done.
    expect(done.uploadSpeedBytesPerSec ?? 0).toBe(0)
  })
})

// Networks › Uploads use (M3.5b, docs/DECISIONS.md ADR-0041), over test networks a (loopback) and
// b (this Mac's LAN address).
test.describe('routing uploads @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for the second network')

  /**
   * A seeder, and another client of the same torrent, counting what it receives from Mergelane
   * over network b: from the LAN address, where nothing else in the swarm is. The other client
   * announces first, so Mergelane hears of it from the tracker and dials it (over a or b, and its
   * twin over the other): a peer that dials in instead is on whichever network it reached, and
   * webtorrent doesn't say where it listens, so it can't be twinned. It wants nothing until
   * `wantAll`: by then Mergelane is ahead of it, with pieces to give.
   */
  async function swarmWithLeecher(
    data: Buffer,
    name: string
  ): Promise<{ torrent: Torrent; overB: () => number; wantAll: () => void }> {
    const torrent = await swarm.seed([named(data, name)], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const other = await swarm.leech(torrent, { deselect: true })
    await new Promise((resolve) => other.once('trackerAnnounce', resolve))
    let overB = 0
    other.on('wire', (wire: Wire, address: string) => {
      if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
      wire.on('download', (bytes: number) => (overB += bytes))
    })
    return {
      torrent,
      overB: () => overB,
      wantAll: () => other.files.forEach((file) => file.select())
    }
  }

  test('downloads over a, uploads over b: b only uploads, and a never does', async ({
    mergelane
  }) => {
    const data = seededBytes(4 * MB, 61)
    const { torrent, overB, wantAll } = await swarmWithLeecher(data, 'split.bin')
    await mergelane.api.updateSettings({ routing: { down: 'a', up: 'b', fallback: true } })

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 2, 30_000)
    wantAll()
    const done = await mergelane.waitForTorrentStatus('completed', 60_000)
    const a = done.networks.find((network) => network.id === 'a')!
    const b = done.networks.find((network) => network.id === 'b')!
    // b is set aside for downloads, yet carries every upload.
    expect(b.status).toBe('routed')
    expect(b.bytesDownloaded).toBe(0)
    expect(overB(), 'what the other client received over b').toBeGreaterThan(0)
    expect(b.bytesUploaded).toBeGreaterThanOrEqual(overB())
    expect(a.bytesUploaded).toBe(0)
    expect(a.bytesDownloaded).toBe(data.length)
    expect(done.bytesUploaded).toBe(b.bytesUploaded)
  })

  test('a Standby network downloads nothing while a is connected, yet carries the uploads routed to it (ADR-0045) @smoke', async ({
    mergelane
  }) => {
    const data = seededBytes(4 * MB, 63)
    const { torrent, overB, wantAll } = await swarmWithLeecher(data, 'standby.bin')
    await mergelane.api.updateSettings({
      networkPreferences: { b: { role: 'standby' } },
      routing: { down: 'all', up: 'b', fallback: true }
    })

    await mergelane.start(await torrentFileOnDisk(torrent), sha256(data), { networks: ['a', 'b'] })
    await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 2, 30_000)
    wantAll()
    const done = await mergelane.waitForTorrentStatus('completed', 60_000)
    const a = done.networks.find((network) => network.id === 'a')!
    const b = done.networks.find((network) => network.id === 'b')!
    // Held back for downloads by its role, while routing still sends uploads over it.
    expect(b.status).toBe('standby')
    expect(b.bytesDownloaded).toBe(0)
    expect(a.bytesDownloaded).toBe(data.length)
    expect(overB(), 'what the other client received over b').toBeGreaterThan(0)
    expect(a.bytesUploaded).toBe(0)
  })

  test('pinning uploads to a while running stops them on b; downloading over b goes on', async ({
    mergelane
  }) => {
    const data = seededBytes(8 * MB, 62)
    const { torrent, overB, wantAll } = await swarmWithLeecher(data, 'moved.bin')

    await mergelane.start(await swarm.torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    await mergelane.waitUntil((state) => state.bytesDownloaded >= data.length / 4, 30_000)
    wantAll()
    // On All networks, b uploads as every network does.
    await mergelane.waitUntil(() => overB() > 0, 30_000)

    await mergelane.api.updateSettings({ routing: { down: 'all', up: 'a', fallback: true } })
    // Blocks already on their way still land; nothing more goes out over b after that.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const pinnedAt = await mergelane.currentTorrent()
    const sentOverB = overB()
    const atPin = pinnedAt!.networks.find((network) => network.id === 'b')!

    const done = await mergelane.waitForTorrentStatus('completed', 60_000)
    expect(overB(), 'nothing more received over b').toBe(sentOverB)
    const b = done.networks.find((network) => network.id === 'b')!
    expect(b.bytesUploaded).toBe(atPin.bytesUploaded)
    // b is still a download network: only uploads were moved.
    expect(b.status).toBe('on')
    expect(b.bytesDownloaded).toBeGreaterThan(atPin.bytesDownloaded)
  })
})

test.describe('managing trackers @smoke', () => {
  test('a torrent with an unreachable tracker finds the seeder after addTorrentTrackers', async ({
    mergelane
  }) => {
    const data = seededBytes(1 * MB, 61)
    const torrent = await swarm.seed([named(data, 'isolated.bin')], { pieceLength: PIECE })
    const { default: parseTorrent, toTorrentFile } = await import('parse-torrent' as string)
    const parsed = await parseTorrent(torrent.torrentFile)
    const realAnnounce = [...(parsed.announce as string[])]
    parsed.announce = ['http://127.0.0.1:9/announce']
    const rewritten = toTorrentFile(parsed)
    const torrentPath = await swarm.torrentFileOnDisk({ ...torrent, torrentFile: rewritten })

    const id = await mergelane.start(torrentPath, sha256(data))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const initial = await mergelane.current()
    expect(initial?.bytesDownloaded ?? 0).toBe(0)

    await mergelane.api.addTorrentTrackers(id, realAnnounce)
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    expect(done.bytesDownloaded).toBe(1 * MB)
  })

  test('trackers added while paused survive relaunch', async ({ mergelane }) => {
    const data = seededBytes(1 * MB, 62)
    const torrent = await swarm.seed([named(data, 'paused-trackers.bin')], { pieceLength: PIECE })
    const { default: parseTorrent, toTorrentFile } = await import('parse-torrent' as string)
    const parsed = await parseTorrent(torrent.torrentFile)
    const realAnnounce = [...(parsed.announce as string[])]
    parsed.announce = ['http://127.0.0.1:9/announce']
    const rewritten = toTorrentFile(parsed)
    const torrentPath = await swarm.torrentFileOnDisk({ ...torrent, torrentFile: rewritten })

    const id = await mergelane.start(torrentPath, sha256(data))
    await mergelane.api.pauseDownload(id)
    await mergelane.waitForTorrentStatus('paused')

    await mergelane.api.addTorrentTrackers(id, realAnnounce)
    const beforeRelaunch = await mergelane.api.torrentTrackers(id)
    expect(beforeRelaunch.customTrackers).toEqual(realAnnounce)

    await mergelane.relaunch()
    const afterRelaunch = await mergelane.api.torrentTrackers(id)
    expect(afterRelaunch.customTrackers).toEqual(realAnnounce)

    await mergelane.api.resumeDownload(id)
    const done = await mergelane.waitForTorrentStatus('completed', 30_000)
    expect(done.bytesDownloaded).toBe(1 * MB)
  })

  test('a private torrent refuses added trackers', async ({ mergelane }) => {
    const data = seededBytes(1 * MB, 63)
    const torrent = await swarm.seed([named(data, 'private.bin')], { pieceLength: PIECE })
    const { default: parseTorrent, toTorrentFile } = await import('parse-torrent' as string)
    const parsed = await parseTorrent(torrent.torrentFile)
    parsed.info = { ...parsed.info, private: 1 }
    ;(parsed as { private?: number | boolean }).private = 1
    const rewritten = toTorrentFile(parsed)
    const torrentPath = await swarm.torrentFileOnDisk({ ...torrent, torrentFile: rewritten })

    const id = await mergelane.start(torrentPath, sha256(data))
    const trackers = await mergelane.api.torrentTrackers(id)
    expect(trackers.isPrivate).toBe(true)

    await expect(
      mergelane.api.addTorrentTrackers(id, ['http://127.0.0.1:1234/announce'])
    ).rejects.toThrow(/private/i)
  })
})
