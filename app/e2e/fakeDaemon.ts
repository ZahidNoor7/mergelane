import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { PROTOCOL_VERSION, type ErrorCode } from '../../shared/daemon-api'

/** A stand-in for mergelane-daemon's control socket: protocol v1, with switchable answers. */
export interface FakeDaemon {
  path: string
  requests: { method: string; params?: unknown }[]
  state: 'off' | 'on'
  /** When set, enable is refused with this error. */
  refuseEnable?: { code: ErrorCode; message: string }
  /** When set, every response line is replaced by this (protocol violations). */
  rawReply?: string
  /** When true, connections are accepted and never answered. */
  silent?: boolean
  close: () => Promise<void>
}

export async function startFakeDaemon(): Promise<FakeDaemon> {
  // macOS limits socket paths to 104 bytes, so not the long per-user temp directory.
  const dir = mkdtempSync('/tmp/mlfd-')
  const path = join(dir, 's')
  const fake: FakeDaemon = { path, requests: [], state: 'off', close: async () => {} }
  const server: Server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        fake.requests.push({ method: request.method, params: request.params })
        if (fake.silent) continue
        if (fake.rawReply !== undefined) {
          socket.write(`${fake.rawReply}\n`)
          continue
        }
        const ok = (result: unknown): string =>
          JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: true, result })
        const status = (): unknown => ({
          state: fake.state,
          version: 'fake',
          protocol: PROTOCOL_VERSION
        })
        let line: string
        switch (request.method) {
          case 'status':
            line = ok(status())
            break
          case 'enable':
            if (fake.refuseEnable) {
              line = JSON.stringify({
                v: PROTOCOL_VERSION,
                id: request.id,
                ok: false,
                error: fake.refuseEnable
              })
            } else {
              fake.state = 'on'
              line = ok(status())
            }
            break
          case 'disable':
            fake.state = 'off'
            line = ok(status())
            break
          case 'links':
            line = ok({
              links: [
                { name: 'feth10', index: 12, ipv4: '10.77.1.2', up: true, state: 'up' },
                { name: 'feth20', index: 14, ipv4: '10.77.2.2', up: true, state: 'down' }
              ]
            })
            break
          case 'stats':
            line = ok({
              at: new Date().toISOString(),
              links: [
                {
                  name: 'feth10',
                  rxBps: 2_500_000,
                  txBps: 100_000,
                  linkRxBps: 2_600_000,
                  linkTxBps: 110_000,
                  activeFlows: 3,
                  totalFlows: 9,
                  weight: 1,
                  failed: 0
                }
              ]
            })
            break
          default:
            line = JSON.stringify({
              v: PROTOCOL_VERSION,
              id: request.id,
              ok: false,
              error: { code: 'UNKNOWN_METHOD', message: 'unknown' }
            })
        }
        socket.write(`${line}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  fake.close = () =>
    new Promise((resolve) =>
      server.close(() => {
        rmSync(dir, { recursive: true, force: true })
        resolve()
      })
    )
  return fake
}
