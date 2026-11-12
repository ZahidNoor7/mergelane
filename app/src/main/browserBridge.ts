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
import { browserOfExecutable, type BrowserContact, type BrowserId } from '../shared/browsers'
import { browserPipePath } from '../shared/browserPipe'
import { keptBy, sanitizeCaptureRules, type CaptureRules } from '../shared/captureRules'
import type { BrowserContext, ProbeResult } from '../shared/types'
import { browserContextFrom, requestHeaders } from './download/browserContext'
import type { DownloadManager } from './download/downloadManager'
import { probeUrl } from './download/probe'
import { youtubeLink } from '../shared/youtube'
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

/** Where mergelane-nmhost finds the app: a socket in the user's own Application Support folder, or on
 * Windows a named pipe named after that folder (shared/browserPipe.ts). */
export function bridgeSocketPath(): string {
  if (testKnobs.browserSocket) return testKnobs.browserSocket
  const userData = app.getPath('userData')
  return process.platform === 'win32' ? browserPipePath(userData) : join(userData, 'browser.sock')
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
  const pipe = path.startsWith('\\\\.\\pipe\\')
  // A socket left by a previous run that didn't exit cleanly; anything else at the path is kept. A
  // Windows pipe goes with the process that made it.
  const existing = pipe ? null : await lstat(path).catch(() => null)
  if (existing?.isSocket()) await rm(path, { force: true })
  const next = createServer((socket) => serve(socket))
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(path, () => resolve())
  })
  // Only this user may talk to it: the socket is 0600. A pipe's default security already gives other
  // users read access only, so they can't send a request (Microsoft Learn, "Named Pipe Security and
  // Access Rights").
  if (!pipe) await chmod(path, 0o600)
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
  const { v, origin, message, browser } = request as Record<string, unknown>
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
    case 'wake': {
      noteExtension()
      noteContact(browser, body.extension)
      const rules = await captureRules()
      return {
        ok: true,
        app: 'mergelane',
        version: app.getVersion(),
        api: BRIDGE_API,
        rules: { capture: rules.capture, videoButton: rules.videoButton }
      }
    }
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

/** The capture rules as saved (Settings › Browser extensions). */
async function captureRules(): Promise<CaptureRules> {
  return sanitizeCaptureRules((await loadSettings()).captureRules)
}

/** When each browser was last heard from, kept in memory and saved at most once an hour per browser
 * (or at once for a browser or extension version not seen before): a ping comes often. */
const CONTACT_SAVE_MS = 60 * 60_000
const contacts = new Map<BrowserId, BrowserContact>()
function noteContact(executable: unknown, extension: unknown): void {
  if (typeof executable !== 'string') return
  const id = browserOfExecutable(executable)
  if (!id) return
  const before = contacts.get(id)
  const contact: BrowserContact = {
    at: Date.now(),
    ...(typeof extension === 'string' ? { extension: extension.slice(0, 32) } : {})
  }
  contacts.set(id, contact)
  if (
    before &&
    before.extension === contact.extension &&
    contact.at - before.at < CONTACT_SAVE_MS
  ) {
    return
  }
  void loadSettings()
    .then((settings) =>
      saveSettings({ browserContacts: { ...settings.browserContacts, [id]: contact } })
    )
    .catch(() => {})
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

  // Settings › Browser extensions (ADR-0039): off keeps everything in the browser.
  const rules = await captureRules()
  if (!rules.capture) return keep('sending downloads to Mergelane is off')

  // A magnet link has nothing to check here: New download looks it up. So has a YouTube link: yt-dlp
  // can take longer than the extension waits, and it goes without the browser's cookies.
  if (/^magnet:/i.test(request.url) || youtubeLink(request.url)) return hold({ url: request.url })

  const checkedProbe = await checked(request, gone)
  // A stream's name from the browser (its page's title, say) beats one made up from its link.
  const probe =
    typeof checkedProbe !== 'string' &&
    (checkedProbe.kind === 'http' || checkedProbe.kind === 'stream') &&
    request.fileName
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
  // The app's own rules: the minimum size, and the types Mergelane takes.
  const kept = keptBy(rules, {
    kind: probe.kind,
    fileName: probe.kind === 'http' || probe.kind === 'stream' ? probe.suggestedFileName : '',
    size: probe.kind === 'http' ? probe.totalBytes : null
  })
  if (kept) return keep(kept)
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
