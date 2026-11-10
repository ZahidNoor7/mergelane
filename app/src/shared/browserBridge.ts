import type { BrowserContext } from './types'

// The extension imports this file too, so Mergelane and the extension can't drift apart.
// Protocol: docs/BROWSER-BRIDGE.md (native messaging through mergelane-nmhost, ADR-0021).

/** The native messaging host's name, as the browsers know it. */
export const NATIVE_HOST = 'io.github.zahidnoor7.mergelane'
/** Raised when an older extension or Mergelane couldn't follow a change to the messages. */
export const BRIDGE_API = 2
/** The extension waits a little longer than this, and Mergelane adds nothing once it has given up,
 * so a download never ends up in both. */
export const BRIDGE_DEADLINE_MS = 8000

/** The Chrome extension's ID, fixed by the `key` in extension/manifest.json. */
export const CHROME_EXTENSION_ID = 'glakkhnincbjofggbhjejpcikboadhdm'
/** The Firefox add-on's ID (extension/build.mjs). */
export const FIREFOX_EXTENSION_ID = 'mergelane@zahidnoor7.github.io'

/** Whether a caller, as the native host reports it, is one of Mergelane's own extensions. */
export function isOurExtension(origin: string): boolean {
  return origin === `chrome-extension://${CHROME_EXTENSION_ID}/` || origin === FIREFOX_EXTENSION_ID
}

/** 200 with a BridgeHandoff: Mergelane will take it. 422: the browser keeps it. Never held past the
 * deadline: Chrome stops an extension's service worker when a fetch takes over 30 s. */
export interface BridgeAddRequest {
  url: string
  browser?: BrowserContext
  pageUrl?: string
  minBytes?: number
  /** The name the browser picked: only it saw a link's download attribute. */
  fileName?: string
}

/** What the extension sends, through the host. */
export type BridgeMessage =
  | { type: 'ping' }
  | { type: 'wake' }
  | { type: 'health' }
  | { type: 'add'; request: BridgeAddRequest }
  | { type: 'confirm'; token: string }

export type BridgeError = 'unavailable' | 'bad-message' | 'forbidden' | 'unsupported'

/** What comes back. `token`: Mergelane will take the download once POSTed back as confirm, after
 * the browser's own copy is really gone; unconfirmed, it expires and nothing is shown. */
export type BridgeReply =
  | { ok: true; app: 'mergelane'; version: string; api: number }
  | { ok: true; app: 'mergelane'; version: string; ready: boolean }
  | { ok: true; token: string }
  | { ok: true }
  | { ok: false; kept: string }
  | { ok: false; error?: BridgeError }
