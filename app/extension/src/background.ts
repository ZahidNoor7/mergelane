import { api } from './api'
import type { BridgeAddRequest } from '../../src/shared/browserBridge'
import { youtubeLink } from '../../src/shared/youtube'
import type { HandOver, MediaRequest } from './media'
import { mediaOf, styleBadge, watchMedia } from './mediaWatch'
import { browserContext, confirm, reach, send, storeOf, wake, type Reach } from './mergelane'
import { excluded, loadSettings } from './settings'

const MENU_ID = 'download-with-mergelane'
// Mergelane can't tell the extension it has quit, so the toolbar icon checks on a timer.
const CHECK_ALARM = 'check-mergelane'

const openedAt = new Map<number, number>()

const ICON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
// A greyed-out icon rather than a badge: the browser draws badges too small to notice.
const ICON_OFF = { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' }

async function showState(reached?: Reach): Promise<void> {
  const { capture } = await loadSettings()
  reached ??= await reach()
  const title = !capture
    ? 'Mergelane: capture is off'
    : reached === 'closed'
      ? 'Mergelane isn’t open: downloads stay in the browser'
      : reached === 'update'
        ? 'Update Mergelane to use this extension'
        : 'Mergelane'
  await api.action.setIcon({ path: capture && reached === 'ok' ? ICON : ICON_OFF })
  await api.action.setTitle({ title })
}

/** True when Mergelane took the download; otherwise the browser keeps it. */
async function capture(item: chrome.downloads.DownloadItem): Promise<boolean> {
  const settings = await loadSettings()
  const url = item.finalUrl || item.url
  // blob: and data: downloads exist only inside the browser.
  if (!settings.capture || !/^https?:/i.test(url)) return false
  if (excluded(settings.sites, [item.url, item.finalUrl, item.referrer])) return false

  const request: BridgeAddRequest = {
    url,
    browser: await browserContext([item.url, item.finalUrl], storeOf(item), item.referrer),
    pageUrl: item.referrer || undefined,
    minBytes: settings.skipSmall ? settings.minMegabytes * 1024 * 1024 : undefined,
    // Chrome and Firefox both give a path here.
    fileName: item.filename.split(/[\\/]/).pop() || undefined
  }
  const handoff = await send(request)
  if (typeof handoff === 'string') {
    if (handoff === 'closed') await showState('closed')
    return false
  }
  // Mergelane shows the download only once the browser's copy is gone. Firefox can't hold a download
  // while Mergelane checks it, so a small one may have finished meanwhile: cancelling then does
  // nothing, and the browser keeps it rather than both ending up with it.
  await api.downloads.cancel(item.id).catch(() => {})
  const [after] = await api.downloads.search({ id: item.id }).catch(() => [])
  if (after?.state === 'complete') return false
  await api.downloads.erase({ id: item.id }).catch(() => {})
  const shown = await confirm(handoff)
  await closeEmptyTab([item.url, item.finalUrl])
  await showState(shown ? 'ok' : undefined)
  return true
}

/** A link that opens a tab only to download leaves that tab empty once Mergelane takes it. */
async function closeEmptyTab(urls: readonly (string | undefined)[]): Promise<void> {
  const recently = Date.now() - 30_000
  for (const tab of await api.tabs.query({})) {
    const shows = tab.pendingUrl ?? tab.url
    if (tab.id === undefined || shows === undefined || !urls.includes(shows)) continue
    if ((openedAt.get(tab.id) ?? 0) < recently) continue
    await api.tabs.remove(tab.id).catch(() => {})
  }
}

// In Chromium, answering later holds back the browser's own Save As dialog until Mergelane has
// decided, so the user is never asked twice. Firefox has no such event.
const determining = api.downloads.onDeterminingFilename
if (determining) {
  determining.addListener((item, suggest) => {
    void capture(item).then((taken) => taken || suggest())
    return true
  })
} else {
  api.downloads.onCreated.addListener((item) => void capture(item))
}

/** Sent whatever the settings say, and Mergelane is started if needed: the user asked for it. */
async function handOver(request: BridgeAddRequest): Promise<HandOver> {
  let sent = await send(request)
  if (sent === 'closed' && (await wake())) sent = await send(request)
  // No browser copy to cancel first.
  const shown = typeof sent !== 'string' && (await confirm(sent))
  await showState(shown ? 'ok' : undefined)
  return shown ? 'sent' : sent === 'closed' ? 'closed' : 'kept'
}

async function sendLink(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const url = info.linkUrl
  if (!url) return
  await handOver(
    /^magnet:/i.test(url)
      ? { url }
      : {
          url,
          browser: await browserContext([url], tab && storeOf(tab), info.pageUrl),
          pageUrl: info.pageUrl
        }
  )
}

/** A stream the tab's page loaded, clicked in the popup. Only one on the tab's list is sent. */
async function sendMedia(tabId: number, url: string): Promise<HandOver> {
  const tab = await api.tabs.get(tabId).catch(() => undefined)
  const listed = (await mediaOf(tabId))?.items.some((item) => item.url === url)
  if (!tab?.url || !listed) return 'kept'
  // The page asked for the manifest with its own cookies and as its referrer, as for a download.
  return handOver({
    url,
    browser: await browserContext([url], storeOf(tab), tab.url),
    pageUrl: tab.url
  })
}

/** The YouTube video tab `tabId` shows, clicked in the popup. Only its address goes: no cookies, no
 * page, nothing of the browser's (ADR-0026). Mergelane's yt-dlp looks it up. */
async function sendVideo(tabId: number): Promise<HandOver> {
  const tab = await api.tabs.get(tabId).catch(() => undefined)
  const video = tab?.url ? youtubeLink(tab.url) : null
  if (video?.kind !== 'video') return 'kept'
  return handOver({ url: video.url })
}

// Run on install and on every browser start: menus and alarms don't always survive a restart.
function setUp(): void {
  createMenu()
  styleBadge()
  void api.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 })
  void showState()
}

function createMenu(): void {
  void api.contextMenus
    .removeAll()
    .then(() =>
      api.contextMenus.create({ id: MENU_ID, title: 'Download with Mergelane', contexts: ['link'] })
    )
}

api.runtime.onInstalled.addListener(setUp)
api.runtime.onStartup.addListener(setUp)
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void showState()
})
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void sendLink(info, tab)
})
api.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) openedAt.set(tab.id, Date.now())
})
// Settings only: the session area holds the pages' stream lists (mediaWatch.ts).
api.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'session') void showState()
})
watchMedia()

api.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== api.runtime.id) return
  const { wakeMergelane, checkMergelane, ...media } = message as {
    wakeMergelane?: boolean
    checkMergelane?: boolean
  } & { [field in keyof MediaRequest]?: unknown }
  if (checkMergelane) void showState()
  if (wakeMergelane) void wake().then((woke) => showState(woke ? 'ok' : 'closed'))
  // Answered later: Chrome keeps `reply` only when the listener returns true, and that works in
  // Firefox too (Chrome's messaging docs; MDN runtime.onMessage).
  if (typeof media.mediaOf === 'number') {
    void mediaOf(media.mediaOf).then(reply)
    return true
  }
  const { tabId, url } = (media.sendMedia ?? {}) as { tabId?: unknown; url?: unknown }
  if (typeof tabId === 'number' && typeof url === 'string') {
    void sendMedia(tabId, url).then(reply)
    return true
  }
  const { tabId: videoTab } = (media.sendVideo ?? {}) as { tabId?: unknown }
  if (typeof videoTab === 'number') {
    void sendVideo(videoTab).then(reply)
    return true
  }
  return undefined
})
