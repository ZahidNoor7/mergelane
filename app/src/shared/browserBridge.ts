import type { BrowserContext } from './types'

// The extension imports this file too, so Mergelane and the extension can't drift apart.

/** Mergelane listens on the first that's free and the extension tries them all, so a port another app
 * holds needs no setting. */
export const BRIDGE_PORTS = [19288, 19289, 19290] as const
/** Raised when an older extension or Mergelane couldn't follow a change to /ping or /add. */
export const BRIDGE_API = 1
/** The extension waits a little longer than this, and Mergelane adds nothing once it has given up,
 * so a download never ends up in both. */
export const BRIDGE_DEADLINE_MS = 8000

export interface BridgePing {
  app: 'mergelane'
  version: string
  api: number
}

/** GET /health: for packaging tests and scripts. Unlike /ping, calling it doesn't mark the browser
 * extension as used. `ready` turns true once the main window is ready to show. */
export interface BridgeHealth {
  app: 'mergelane'
  version: string
  ready: boolean
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

/** Mergelane shows the download only once POST /confirm brings this back: the extension confirms
 * after the browser's copy is really gone, since it can finish before it's cancelled. Unconfirmed,
 * it expires and Mergelane shows nothing, so a download never ends up in both. */
export interface BridgeHandoff {
  token: string
}
