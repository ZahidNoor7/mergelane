import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/**
 * A stand-in for Cloudflare's speed test (docs/DECISIONS.md ADR-0064), for the speed test's tests:
 * `GET /__down?bytes=N` sends N bytes and `POST /__up` takes a body, as speed.cloudflare.com does.
 *
 * It tells the test "networks" apart by the request's source address, as the download server does
 * (origin.ts), and paces each one to its own speed: one bucket per source, shared by all its
 * connections, as a real link is. `shared` paces every source together, as two networks behind
 * one slow line would be, so a test can tell a real combined measurement from the networks' speeds
 * added up.
 */
export interface SpeedServerOptions {
  /** Bytes a second for each source address, each way. Unset: as fast as it goes. */
  rates?: Record<string, number>
  /** Bytes a second for every source together, each way. */
  shared?: number
  /** A Server-Timing duration to report, in ms. */
  serverTimingMs?: number
  /** Extra wait before each reply's headers, by source address, in ms: the test's latency. */
  delayMs?: Record<string, number | (() => number)>
  /** Answer requests from these sources with this status instead. */
  failFrom?: Record<string, number>
}

const PIECE = 16 * 1024
const ZEROS = Buffer.alloc(PIECE)

export class SpeedServer {
  /** Bytes sent (download) and received (upload), by source address. */
  readonly sent: Record<string, number> = {}
  readonly received: Record<string, number> = {}
  readonly requests: Array<{ from: string; method: string; path: string }> = []
  private readonly busyUntil = new Map<string, number>()
  private readonly sockets = new Set<Socket>()
  private server = createServer((req, res) => void this.handle(req, res))
  private port = 0

  constructor(public options: SpeedServerOptions = {}) {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '0.0.0.0', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Drops every open connection, as a network that goes away does. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  /** Waits as long as `bytes` take at the source's speed and at the shared speed. */
  private async pace(from: string, bytes: number): Promise<void> {
    const now = Date.now()
    let until = now
    const own = this.options.rates?.[from]
    for (const [key, rate] of [
      [from, own],
      ['*', this.options.shared]
    ] as const) {
      if (!rate) continue
      const busy = Math.max(now, this.busyUntil.get(key) ?? 0) + (bytes / rate) * 1000
      this.busyUntil.set(key, busy)
      until = Math.max(until, busy)
    }
    if (until > now) await new Promise((resolve) => setTimeout(resolve, until - now))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A client that gives up mid-body makes reading it throw; that's the test's doing, not a fault.
    await this.answer(req, res).catch(() => void res.destroy())
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const url = new URL(req.url ?? '/', 'http://x')
    this.requests.push({ from, method: req.method ?? '', path: url.pathname })
    const delay = this.options.delayMs?.[from]
    const wait = typeof delay === 'function' ? delay() : delay
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    const headers: Record<string, string | number> = {}
    if (this.options.serverTimingMs !== undefined) {
      headers['Server-Timing'] = `cfRequestDuration;dur=${this.options.serverTimingMs}`
    }
    const failure = this.options.failFrom?.[from]
    if (failure) {
      req.resume()
      res.writeHead(failure, headers).end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/__down') {
      const size = Math.max(0, Number(url.searchParams.get('bytes') ?? 0))
      res.writeHead(200, { ...headers, 'Content-Length': size })
      let left = size
      while (left > 0) {
        if (res.destroyed) return
        const piece = left >= PIECE ? ZEROS : ZEROS.subarray(0, left)
        left -= piece.length
        await this.pace(from, piece.length)
        if (res.destroyed) return
        this.sent[from] = (this.sent[from] ?? 0) + piece.length
        if (!res.write(piece)) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off('drain', done)
              res.off('close', done)
              resolve()
            }
            res.on('drain', done)
            res.on('close', done)
          })
        }
      }
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/__up') {
      for await (const chunk of req) {
        const piece = chunk as Buffer
        this.received[from] = (this.received[from] ?? 0) + piece.length
        // Read at the network's speed: the next piece isn't read until this wait is over, so TCP
        // holds the sender back meanwhile.
        await this.pace(from, piece.length)
      }
      res.writeHead(200, headers).end()
      return
    }

    req.resume()
    res.writeHead(404).end()
  }
}
