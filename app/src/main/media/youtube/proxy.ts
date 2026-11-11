import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * A proxy on loopback that sends everything through one network: what lets yt-dlp ask YouTube
 * over the network a download will use (`--proxy`, see ytdlp.ts). YouTube's media addresses are
 * meant for the address that asked for them (yt-dlp's FAQ: "requests for the video ... must come
 * from the same IP address"), so each network asks for its own.
 *
 * It only tunnels (HTTP CONNECT, RFC 9110 §9.3.6): yt-dlp talks to YouTube over HTTPS, so the
 * proxy sees nothing but where each connection goes. `dial` opens that connection through the
 * network (see deviceBinding.ts: pinned with IP_BOUND_IF). It listens on 127.0.0.1 only, and only
 * while one yt-dlp run lasts, and only for the random credentials in its URL, so nothing else on
 * the Mac can use it to reach that network.
 */

/** Opens a TCP connection to host:port through the network. */
export type Dial = (host: string, port: number, signal: AbortSignal) => Promise<Socket>

export interface LoopbackProxy {
  /** For yt-dlp's `--proxy`: `http://mergelane:<password>@127.0.0.1:<port>`. */
  url: string
  /** Where each tunnel went, "host:port", in order. */
  readonly tunnels: string[]
  close(): Promise<void>
}

/** Tunnels at once: yt-dlp opens a handful. */
const MAX_TUNNELS = 32
const USER = 'mergelane'

function answer(client: Duplex, status: string, extra = ''): void {
  client.end(`HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** `host:port` of a CONNECT request (its authority form), or null. */
function targetOf(authority: string | undefined): { host: string; port: number } | null {
  if (!authority || !/^[^/?#@\s]+:\d{1,5}$/.test(authority)) return null
  try {
    const url = new URL(`http://${authority}`)
    const port = Number(authority.slice(authority.lastIndexOf(':') + 1))
    if (!url.hostname || port < 1 || port > 65535) return null
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return null
  }
}

function sameSecret(given: string | undefined, expected: Buffer): boolean {
  const bytes = Buffer.from(given ?? '')
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

/** Starts a proxy that tunnels through `dial`. Close it once yt-dlp is done. */
export async function startLoopbackProxy(dial: Dial): Promise<LoopbackProxy> {
  const password = randomBytes(16).toString('hex')
  const expected = Buffer.from(`Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`)
  const sockets = new Set<Duplex>()
  const tunnels: string[] = []
  const closing = new AbortController()
  let open = 0

  const server = createServer((_request, response) => {
    // Only tunnels: a plain request through it would be http://, which YouTube doesn't use.
    response.writeHead(405, { connection: 'close' }).end()
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy())
    if (!sameSecret(request.headers['proxy-authorization'], expected)) {
      return answer(
        client,
        '407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="Mergelane"\r\n'
      )
    }
    const target = targetOf(request.url)
    if (!target) return answer(client, '400 Bad Request')
    if (open >= MAX_TUNNELS) return answer(client, '503 Service Unavailable')
    open++
    tunnels.push(`${target.host}:${target.port}`)
    const gone = new AbortController()
    const finished = (): void => {
      gone.abort()
    }
    client.once('close', finished)
    const signal = AbortSignal.any([gone.signal, closing.signal])
    dial(target.host, target.port, signal).then(
      (upstream) => {
        sockets.add(upstream)
        const end = (): void => {
          upstream.destroy()
          client.destroy()
        }
        upstream.on('error', end)
        upstream.on('close', () => {
          sockets.delete(upstream)
          end()
        })
        client.on('close', end)
        if (client.destroyed || signal.aborted) return end()
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      },
      () => {
        if (!client.destroyed) answer(client, '502 Bad Gateway')
      }
    )
    client.once('close', () => open--)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${USER}:${password}@127.0.0.1:${port}`,
    tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        closing.abort()
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
