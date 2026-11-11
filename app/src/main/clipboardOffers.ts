import { createHash } from 'node:crypto'
import { app, clipboard, type BrowserWindow } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import { copiedLink } from '../shared/links'
import type { AppSettings } from '../shared/types'

// "Offer links I copy" (docs/DECISIONS.md ADR-0043). Off unless the user turns it on: macOS asks
// the user before an app reads the clipboard by itself, and access that isn't user-originated and
// paste-related, as this is, may show that alert (Apple, NSPasteboard.AccessBehavior). When on,
// the clipboard is read only as the user switches to Mergelane, when one of its windows gains focus
// (Electron's app 'browser-window-focus'), never on a timer or while another app is in front.
//
// A link found there goes to that window, which offers it; nothing starts on its own. Only the last
// offered link's SHA-256 is remembered, in memory, so the same copy isn't offered at every switch:
// what was copied is never kept, and never written to disk.

let enabled = false
let lastOffered: string | null = null
let listening = false

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Reads the clipboard and offers a link on it to `window`, unless it was the last one offered. */
export async function offerCopiedLink(window: BrowserWindow): Promise<void> {
  if (!enabled || window.isDestroyed()) return
  let text: string
  try {
    text = await clipboard.readText()
  } catch {
    // Refused (or nothing readable): there's nothing to offer.
    return
  }
  const link = copiedLink(text)
  if (!link) return
  const hash = digest(link)
  // Turned off while the clipboard was being read, or offered already.
  if (!enabled || hash === lastOffered) return
  lastOffered = hash
  if (!window.isDestroyed()) window.webContents.send(IpcChannels.copiedLink, link)
}

/** Takes up the setting; turned off, nothing is remembered. */
export function applyClipboardSettings(settings: AppSettings): void {
  enabled = settings.offerCopiedLinks === true
  if (!enabled) lastOffered = null
}

export function startClipboardOffers(settings: AppSettings): void {
  applyClipboardSettings(settings)
  if (listening) return
  listening = true
  app.on('browser-window-focus', (_event, window) => void offerCopiedLink(window))
}
