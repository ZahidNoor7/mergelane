import { randomUUID } from 'node:crypto'
import { chmod, lstat, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import {
  BRIDGE_API,
  BRIDGE_DEADLINE_MS,
  isOurExtension,
  type BridgeAddRequest,
  type BridgeReply
} from '../shared/browserBridge'
import type { BrowserContext, ProbeResult } from '../shared/types'
import { browserContextFrom, requestHeaders } from './download/browserContext'
import type { DownloadManager } from './download/downloadManager'
import { probeUrl } from './download/probe'
import type { Offer } from './openLinks'
import { loadSettings, saveSettings } from './settings'
import { testKnobs } from './testKnobs'

// The browser extension reaches Mergelane through native messaging (docs/BROWSER-BRIDGE.md,
// ADR-0021): the browser starts mergelane-nmhost, which relays each message here over a Unix
// socket only this user can open. No network port is open, and web pages can't reach it.

/** A request line: an extension message (at most 1 MiB, the host's limit) plus the host's small
 * envelope around it; anything longer is refused. */
const MAX_LINE_BYTES = 1024 * 1024 + 4096
// The extension confirms within milliseconds of an answer; an unconfirmed offer is dropped.
const HANDOFF_MS = 15_000

export interface BridgeHost {
  manager: DownloadManager
  offer: (offer: Offer) => void
}

let host: BridgeHost | null = null
let server: Server | null = null
const handoffs = new Map<string, Offer>()
let extensionUsed = false
let appReady = false

/** The main window is ready to show; the health message reports it from now on. */
export function markAppReady(): void {
  appReady = true
}

/** Where mergelane-nmhost finds the app: the user's own Application Support folder. */
export function bridgeSocketPath(): string {
  return testKnobs.browserSocket ?? join(app.getPath('userData'), 'browser.sock')
}

/** Once an extension has connected, closing the window keeps Mergelane in the tray, where the
 * browser can still reach it. */
export function keepsRunningForBrowser(): boolean {
  return server !== null && extensionUsed
}

export async function startBridge(bridgeHost: BridgeHost): Promise<void> {
  host = bridgeHost
  extensionUsed = (await loadSettings()).browserExtensionUsed === true
  const path = bridgeSocketPath()
  // A socket left by a previous run that didn't exit cleanly; anything else at the path is kept.
  const existing = await lstat(path).catch(() => null)
  if (existing?.isSocket()) await rm(path, { force: true })
  const next = createServer((socket) => serve(socket))
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(path, () => resolve())
  })
  await chmod(path, 0o600)
  server = next
}

export async function stopBridge(): Promise<void> {
  const current = server
  server = null
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
}

function serve(socket: Socket): void {
  let buffer = ''
  let answered = false
  const gone = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  const answer = (reply: BridgeReply): void => {
    if (answered || socket.destroyed) return
    answered = true
    socket.end(`${JSON.stringify(reply)}\n`)
  }
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk: string) => {
    if (answered) return
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES)
      return answer({ ok: false, error: 'bad-message' })
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    void handle(buffer.slice(0, newline), gone)
      .catch((): BridgeReply => ({ ok: false, error: 'bad-message' }))
      .then(answer)
  })
}

async function handle(line: string, gone: Promise<void>): Promise<BridgeReply> {
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    return { ok: false, error: 'bad-message' }
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, error: 'bad-message' }
  }
  const { v, origin, message } = request as Record<string, unknown>
  if (v !== BRIDGE_API) return { ok: false, error: 'unsupported' }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false, error: 'bad-message' }
  }
  const body = message as Record<string, unknown>

  // Read-only and harmless: anyone of this user may ask (the packaging test does).
  if (body.type === 'health') {
    return { ok: true, app: 'mergelane', version: app.getVersion(), ready: appReady }
  }
  if (typeof origin !== 'string' || !isOurExtension(origin))
    return { ok: false, error: 'forbidden' }

  switch (body.type) {
    case 'ping':
    case 'wake':
      noteExtension()
      return { ok: true, app: 'mergelane', version: app.getVersion(), api: BRIDGE_API }
    case 'add': {
      const parsed = addRequestFrom(body.request)
      if (!parsed) return { ok: false, error: 'bad-message' }
      noteExtension()
      return add(parsed, gone)
    }
    case 'confirm': {
      const offer = typeof body.token === 'string' ? handoffs.get(body.token) : undefined
      if (!host || !offer || typeof body.token !== 'string') return { ok: false }
      handoffs.delete(body.token)
      host.offer(offer)
      return { ok: true }
    }
    default:
      return { ok: false, error: 'unsupported' }
  }
}

function noteExtension(): void {
  if (extensionUsed) return
  extensionUsed = true
  void saveSettings({ browserExtensionUsed: true }).catch(() => {})
}

function addRequestFrom(body: unknown): BridgeAddRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { url, browser, pageUrl, minBytes, fileName } = body as Record<string, unknown>
  if (typeof url !== 'string' || url.length > 8192 || !/^(https?:\/\/|magnet:\?)/i.test(url)) {
    return null
  }
  const context = browser === undefined ? undefined : browserContextFrom(browser)
  if (context === null) return null
  if (pageUrl !== undefined && !(typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl))) {
    return null
  }
  if (minBytes !== undefined && !Number.isSafeInteger(minBytes)) return null
  if (
    fileName !== undefined &&
    // eslint-disable-next-line no-control-regex -- a name, never a path or a control character
    !(typeof fileName === 'string' && /^[^\x00-\x1f\x7f/\\]{1,255}$/.test(fileName))
  ) {
    return null
  }
  return {
    url,
    browser: context,
    pageUrl: pageUrl as string | undefined,
    minBytes: minBytes as number | undefined,
    fileName: fileName as string | undefined
  }
}

/** The probe, or why the browser should keep the download. */
async function checked(
  request: BridgeAddRequest,
  gone: Promise<void>
): Promise<ProbeResult | string> {
  let timer: NodeJS.Timeout | undefined
  try {
    // ponytail: the probe isn't cancelled, only no longer waited for; it ends at its own timeout.
    return await Promise.race([
      probeUrl(request.url, request.browser),
      new Promise<string>((resolve) => {
        timer = setTimeout(resolve, BRIDGE_DEADLINE_MS, 'The server took too long to answer.')
      }),
      gone.then(() => 'gone')
    ])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
}

async function add(request: BridgeAddRequest, gone: Promise<void>): Promise<BridgeReply> {
  if (!host) return { ok: false, error: 'unavailable' }
  const keep = (reason: string): BridgeReply => ({ ok: false, kept: reason })
  const hold = (offer: Offer): BridgeReply => {
    const token = randomUUID()
    handoffs.set(token, offer)
    setTimeout(() => handoffs.delete(token), HANDOFF_MS).unref()
    return { ok: true, token }
  }

  // A magnet link has nothing to check here: New download looks it up.
  if (/^magnet:/i.test(request.url)) return hold({ url: request.url })

  const checkedProbe = await checked(request, gone)
  const probe =
    typeof checkedProbe !== 'string' && checkedProbe.kind === 'http' && request.fileName
      ? { ...checkedProbe, suggestedFileName: request.fileName }
      : checkedProbe
  if (typeof probe === 'string') return keep(probe)
  if (
    probe.kind === 'http' &&
    request.minBytes !== undefined &&
    probe.totalBytes !== null &&
    probe.totalBytes < request.minBytes
  ) {
    return keep('smaller than the minimum size')
  }
  return hold({
    url: request.url,
    probe,
    browser: request.browser,
    from: request.browser?.name,
    signedInTo: signedInTo(request, probe),
    resumes: probe.kind === 'http' ? host.manager.failedMatch(probe) : undefined
  })
}

/** The page's site rather than the file's, which is often a CDN's: drive.google.com, not
 * drive.usercontent.google.com. */
function signedInTo(request: BridgeAddRequest, probe: ProbeResult): string | undefined {
  const browser: BrowserContext | undefined = request.browser
  const fileUrl = new URL(probe.finalUrl)
  if (!browser || !requestHeaders(fileUrl, browser)['Cookie']) return undefined
  return new URL(request.pageUrl ?? browser.referer ?? fileUrl).hostname
}
