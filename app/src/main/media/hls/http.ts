// Logic adapted from Awesome Downloader core/hls.mjs and core/http.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane; see docs/UPSTREAM.md.

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { HlsLimitError, HlsUnsupportedError } from './errors'

/** An inclusive byte range, as in an HTTP `Range: bytes=start-end` header. */
export interface HlsRange {
  start: number
  end: number
}

export interface HlsFetchInit {
  /** Request headers, already scoped to the target's origin (see {@link scopeHeaders}). */
  headers: Record<string, string>
  signal?: AbortSignal
  /** Ask for only these bytes. A server may still answer 200 with the whole resource. */
  range?: HlsRange
}

/** A response body: a Node stream, an async generator, or a WHATWG ReadableStream. */
export type HlsBody = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

export interface HlsFetchResponse {
  status: number
  body: HlsBody
  /** The URL that finally answered, after redirects. Relative playlist URIs resolve against it. */
  url?: string
  /** Response headers, lower-case names. Used, when given, to check lengths and ranges. */
  headers?: Record<string, string | undefined>
}

/** How this module makes HTTP requests. Injectable so tests and the app's own network layer
 * (bound to a chosen link) can stand in for the default {@link nodeFetch}. */
export type HlsFetch = (url: string, init: HlsFetchInit) => Promise<HlsFetchResponse>

/** Headers that carry the user's identity on the site the stream came from. */
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'origin'])

function origin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * `headers` for a request to `target`, given that they were meant for `source`: when the origins
 * differ, Cookie, Authorization and Origin are dropped (header names compared case-insensitively),
 * so a playlist cannot send the user's session to another site. Other headers (Referer,
 * User-Agent) are kept: CDNs often require them.
 */
export function scopeHeaders(
  headers: Record<string, string>,
  source: string,
  target: string
): Record<string, string> {
  const from = origin(source)
  if (from !== undefined && from === origin(target)) return { ...headers }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()))
  )
}

function isReadableStream(body: HlsBody): body is ReadableStream<Uint8Array> {
  return typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
}

/** Iterates any {@link HlsBody}. Stopping early (break, throw) cancels the underlying body. */
export async function* readBody(body: HlsBody): AsyncGenerator<Uint8Array, void, undefined> {
  if (!isReadableStream(body)) {
    yield* body
    return
  }
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Releases a body that won't be read, so its connection isn't left hanging. */
export async function discardBody(body: HlsBody): Promise<void> {
  try {
    if (isReadableStream(body)) await body.cancel()
    else await body[Symbol.asyncIterator]().return?.()
  } catch {
    // Already failed or closed: nothing left to release.
  }
}

export interface NodeFetchOptions {
  /** Redirects followed per request before giving up. Default 10. */
  maxRedirects?: number
  /** How long the connection may stay silent, in ms. Default 30 000. */
  timeoutMs?: number
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

function send(
  target: URL,
  headers: Record<string, string>,
  init: HlsFetchInit,
  timeoutMs: number
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string> = { 'accept-encoding': 'identity', ...headers }
    if (init.range) outgoing.range = `bytes=${init.range.start}-${init.range.end}`
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      { method: 'GET', headers: outgoing, signal: init.signal },
      resolve
    )
    request.on('error', reject)
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('The server stopped responding.'))
    })
    request.end()
  })
}

function flatten(headers: IncomingMessage['headers']): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return flat
}

/**
 * An {@link HlsFetch} over node:http / node:https. Follows up to `maxRedirects` redirects
 * (301/302/303/307/308), re-scoping headers at every hop with {@link scopeHeaders} so credentials
 * never follow a redirect to another origin. Only http: and https: URLs are fetched.
 */
export function createNodeFetch(options: NodeFetchOptions = {}): HlsFetch {
  const maxRedirects = options.maxRedirects ?? 10
  const timeoutMs = options.timeoutMs ?? 30_000
  return async (url, init) => {
    let current = url
    let headers = { ...init.headers }
    for (let redirects = 0; ; redirects++) {
      const target = new URL(current)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new HlsUnsupportedError(
          `Mergelane can't download from ${target.protocol} addresses, only http and https.`
        )
      }
      const response = await send(target, headers, init, timeoutMs)
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (!REDIRECTS.has(status) || !location) {
        return { status, body: response, url: current, headers: flatten(response.headers) }
      }
      response.destroy()
      if (redirects >= maxRedirects) {
        throw new HlsLimitError(
          'redirects',
          `The server redirected more than ${maxRedirects} times, so Mergelane stopped following it.`
        )
      }
      const next = new URL(location, target).href
      headers = scopeHeaders(headers, current, next)
      current = next
    }
  }
}

/** The default {@link HlsFetch}: {@link createNodeFetch} with default options. */
export const nodeFetch: HlsFetch = createNodeFetch()
