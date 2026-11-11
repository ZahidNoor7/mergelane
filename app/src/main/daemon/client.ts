import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import {
  isResponse,
  isResultOf,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  type ErrorCode,
  type Method,
  type ParamsOf,
  type ResultOf
} from '../../../../shared/daemon-api'

/** The daemon answered with an error, or couldn't be reached at all (code 'UNAVAILABLE'). */
export class DaemonError extends Error {
  constructor(
    readonly code: ErrorCode | 'UNAVAILABLE' | 'PROTOCOL',
    message: string
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

/** The protocol version a message from the helper claims, when it is a number other than ours:
 * in the envelope (`v`), or in a status result (`protocol`). */
function otherProtocol(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const { v, result } = message as { v?: unknown; result?: unknown }
  const protocol =
    typeof result === 'object' && result !== null
      ? (result as { protocol?: unknown }).protocol
      : undefined
  for (const claimed of [v, protocol]) {
    if (typeof claimed === 'number' && claimed !== PROTOCOL_VERSION) return claimed
  }
  return undefined
}

/** One request to mergelane-daemon over its control socket (shared/daemon-api.ts, protocol v1).
 * Each call uses its own short connection, so a daemon restart between calls costs nothing.
 * A helper that speaks another protocol version fails with code 'UNSUPPORTED_VERSION', as the
 * daemon itself answers a request in a version it doesn't speak. */
export function callDaemon<M extends Method>(
  method: M,
  params: ParamsOf<M> | undefined,
  { socketPath = SOCKET_PATH, timeoutMs = 10_000 }: { socketPath?: string; timeoutMs?: number } = {}
): Promise<ResultOf<M>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = connect({ path: socketPath })
    let buffer = ''
    let settled = false
    const finish = (error: DaemonError | null, result?: ResultOf<M>): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(result as ResultOf<M>)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () =>
      finish(new DaemonError('UNAVAILABLE', 'The helper did not answer in time.'))
    )
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
      finish(
        new DaemonError(
          'UNAVAILABLE',
          missing
            ? "Mergelane's helper isn't running."
            : `Couldn't reach Mergelane's helper (${error.code ?? error.message}).`
        )
      )
    })
    socket.on('connect', () => {
      const request = { v: PROTOCOL_VERSION, id, method, ...(params ? { params } : {}) }
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES * 4) {
        finish(new DaemonError('PROTOCOL', 'The helper sent an oversized answer.'))
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          finish(new DaemonError('PROTOCOL', 'The helper sent something that is not JSON.'))
          return
        }
        const protocol = otherProtocol(message)
        if (protocol !== undefined) {
          finish(
            new DaemonError(
              'UNSUPPORTED_VERSION',
              `Mergelane's helper speaks protocol version ${protocol}; this app speaks ${PROTOCOL_VERSION}.`
            )
          )
          return
        }
        if (!isResponse(message)) {
          finish(
            new DaemonError(
              'PROTOCOL',
              'The helper sent an answer this version of Mergelane does not understand.'
            )
          )
          return
        }
        // id "" is a connection-level error (e.g. NOT_AUTHORIZED), sent before any request is read.
        if (message.id !== id && message.id !== '') continue
        if (!message.ok) {
          finish(new DaemonError(message.error.code, message.error.message))
        } else if (!isResultOf(method, message.result)) {
          finish(new DaemonError('PROTOCOL', `The helper's answer to ${method} is malformed.`))
        } else {
          finish(null, message.result as ResultOf<M>)
        }
        return
      }
    })
    socket.on('close', () =>
      finish(new DaemonError('UNAVAILABLE', "Mergelane's helper closed the connection."))
    )
  })
}
