import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { ClientOptions, Torrent } from 'webtorrent'

// A small BitTorrent swarm in the test process: a tracker on 127.0.0.1, and webtorrent clients
// seeding (or fetching) through it. The app finds the peers by announcing to the tracker, as it
// would on the internet; no DHT is involved anywhere.

// ESM-only: specs are compiled to CommonJS, so these come in through import().
export const loadWebTorrent = (): Promise<typeof WebTorrent> =>
  import('webtorrent').then((module) => module.default)

interface TrackerServer {
  listen(port: number, hostname: string, onListening: () => void): void
  close(onClose?: () => void): void
  http: { address(): { port: number } }
}
const loadTracker = (): Promise<new (options: object) => TrackerServer> =>
  import('bittorrent-tracker/server' as string).then((module) => module.default)

/** Nothing beyond the swarm: no DHT, local discovery, port mapping or uTP. */
export const QUIET: ClientOptions = {
  dht: false,
  lsd: false,
  natUpnp: false,
  natPmp: false,
  utp: false
}

// Every folder made here, until it is removed. A test that times out can be abandoned before its
// stop() runs; whatever is still listed when the worker exits goes then, so no run leaves its
// folders behind in the temp directory.
const scratch = new Set<string>()
process.once('exit', () => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true })
})

/** A new folder of its own in the temp directory, removed by removeScratch() or at exit. */
export async function scratchFolder(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.add(path)
  return path
}

/** Removes folders made by scratchFolder(). */
export async function removeScratch(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      await rm(path, { recursive: true, force: true, maxRetries: 5 })
      scratch.delete(path)
    })
  )
}

/** A file to seed: its bytes, named as it appears in the torrent. */
export function named(data: Buffer, name: string): Buffer {
  return Object.assign(data, { name })
}

export class Swarm {
  private clients: WebTorrent[] = []
  private tracker: TrackerServer | null = null
  private announce: string[] = []
  /** Seeders' and leechers' folders, and .torrent files' folders: removed at stop(). */
  private folders: string[] = []

  private async folder(prefix: string): Promise<string> {
    const path = await scratchFolder(prefix)
    this.folders.push(path)
    return path
  }

  async start(): Promise<this> {
    const Server = await loadTracker()
    const tracker = new Server({ udp: false, ws: false, stats: false })
    await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve))
    this.tracker = tracker
    this.announce = [`http://127.0.0.1:${tracker.http.address().port}/announce`]
    return this
  }

  /** A client of the swarm, gone at stop(). */
  async client(options: ClientOptions = {}): Promise<WebTorrent> {
    const client = new (await loadWebTorrent())({ ...QUIET, ...options })
    this.clients.push(client)
    return client
  }

  /** A client seeding `files`: one file, or a folder of them named `folder`. The same files,
   * name and piece length make the same torrent, so seed() again for another seeder of it. */
  async seed(
    files: Buffer[],
    options: { folder?: string; pieceLength?: number; uploadLimit?: number } = {}
  ): Promise<Torrent> {
    const client = await this.client({ uploadLimit: options.uploadLimit })
    // A folder of its own, as leech() has: left to webtorrent, every seeder shares /tmp/webtorrent,
    // and two tests seeding different files under one name in parallel overwrite each other's —
    // the seeder then serves pieces that fail verification, forever.
    const path = await this.folder('mergelane-seed-')
    return new Promise((resolve) =>
      client.seed(
        files.length === 1 ? files[0] : files,
        { name: options.folder, pieceLength: options.pieceLength, announce: this.announce, path },
        resolve
      )
    )
  }

  /** A client fetching `torrent` from the swarm, into a folder of its own. With `deselect`, it
   * joins the swarm wanting nothing, until its files are selected. */
  async leech(torrent: Torrent, options: { deselect?: boolean } = {}): Promise<Torrent> {
    const client = await this.client()
    const path = await this.folder('mergelane-leech-')
    return client.add(torrent.torrentFile, { path, deselect: options.deselect })
  }

  /** What every client has uploaded, all together. */
  uploaded(): number {
    return this.clients
      .flatMap((client) => client.torrents)
      .reduce((sum, torrent) => sum + torrent.uploaded, 0)
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.clients.splice(0).map((client) => new Promise((done) => client.destroy(done)))
    )
    await new Promise<void>((resolve) => (this.tracker ? this.tracker.close(resolve) : resolve()))
    // Last, once no client is writing to them.
    await removeScratch(this.folders.splice(0))
  }

  /** `torrent`'s .torrent, written to a file for the app to open; gone at stop(). */
  async torrentFileOnDisk(torrent: Pick<Torrent, 'name' | 'torrentFile'>): Promise<string> {
    const path = join(await this.folder('mergelane-torrent-'), `${torrent.name}.torrent`)
    await writeFile(path, torrent.torrentFile)
    return path
  }
}
