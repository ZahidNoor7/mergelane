import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { isSetAutoResumeParams, PROTOCOL_VERSION, type ErrorCode } from '../../shared/daemon-api'

/** One entry of the fake's `events` answer (shared/daemon-api.ts). */
export interface FakeLinkEvent {
  at: string
  link: string
  from: 'up' | 'unknown' | 'down' | 'gone'
  to: 'up' | 'unknown' | 'down' | 'gone'
  reason: 'found' | 'lost' | 'returned' | 'address' | 'probe-ok' | 'probe-failed'
}

/** A stand-in for mergelane-daemon's control socket: protocol v1, with switchable answers. */
export interface FakeDaemon {
  path: string
  requests: { method: string; params?: unknown }[]
  state: 'off' | 'on'
  /** What `status` says the helper's version is ('fake' unless set). */
  version: string
  /** Turned on and off with setAutoResume, and reported by status. */
  autoResume: boolean
  /** What `events` answers. */
  events: FakeLinkEvent[]
  /** A helper from before M2.4: status has no autoResume, and setAutoResume and events are
   * UNKNOWN_METHOD. */
  legacy?: boolean
  /** Methods answered with UNKNOWN_METHOD, as by an older helper. */
  unknownMethods?: string[]
  /** The protocol version every answer claims, in the envelope and in status (1 unless set). */
  protocol?: number
  /** When set, enable is refused with this error. */
  refuseEnable?: { code: ErrorCode; message: string }
  /** Methods refused with these errors. */
  refuse?: Record<string, { code: ErrorCode; message: string }>
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
  const fake: FakeDaemon = {
    path,
    requests: [],
    state: 'off',
    version: 'fake',
    autoResume: false,
    events: [],
    close: async () => {}
  }
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
        const v = fake.protocol ?? PROTOCOL_VERSION
        const ok = (result: unknown): string =>
          JSON.stringify({ v, id: request.id, ok: true, result })
        const status = (): unknown => ({
          state: fake.state,
          version: fake.version,
          protocol: v,
          ...(fake.legacy ? {} : { autoResume: fake.autoResume })
        })
        const unknown =
          fake.unknownMethods?.includes(request.method) ||
          (fake.legacy && ['setAutoResume', 'events'].includes(request.method))
        const refusal = fake.refuse?.[request.method]
        let line: string
        switch (unknown ? '' : refusal ? 'refused' : request.method) {
          case 'refused':
            line = JSON.stringify({ v, id: request.id, ok: false, error: refusal })
            break
          case 'status':
            line = ok(status())
            break
          case 'enable':
            if (fake.refuseEnable) {
              line = JSON.stringify({
                v,
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
          case 'setAutoResume':
            // Strict, as the daemon is: anything but {enabled: boolean} is a bad request.
            if (!isSetAutoResumeParams(request.params)) {
              line = JSON.stringify({
                v,
                id: request.id,
                ok: false,
                error: { code: 'BAD_REQUEST', message: 'setAutoResume needs enabled, a boolean' }
              })
              break
            }
            fake.autoResume = request.params.enabled
            line = ok(status())
            break
          case 'events':
            line = ok({ events: fake.events })
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
              v,
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
