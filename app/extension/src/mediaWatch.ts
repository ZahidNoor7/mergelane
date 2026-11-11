import { api } from './api'
import {
  manifestKind,
  PENDING_SITES,
  samePage,
  withItem,
  type MediaChanged,
  type MediaKind,
  type PageMedia
} from './media'
import { excluded, loadAppRules, loadSettings } from './settings'

// Lists the HLS and DASH manifests each tab's page loads (media.ts), for the popup. Only
// observes: chrome.webRequest without "blocking" needs just the webRequest permission and host
// access (developer.chrome.com/docs/extensions/reference/api/webRequest), and that permission
// shows the user no new warning (developer.chrome.com/docs/extensions/reference/permissions-list).

// storage.session keeps the lists while Chrome stops and restarts the service worker, and drops
// them when the browser or extension restarts (developer.chrome.com/docs/extensions/reference/api/
// storage; Chrome 102+). Firefox has it from 115 (MDN browser-compat-data), below our minimum of
// 121, so memory is only a fallback for a browser without it.
const session = api.storage.session as chrome.storage.SessionStorageArea | undefined
const memory = new Map<number, PageMedia>()
const PREFIX = 'media:'

async function load(tabId: number): Promise<PageMedia | undefined> {
  if (!session) return memory.get(tabId)
  const key = `${PREFIX}${tabId}`
  return (await session.get(key))[key] as PageMedia | undefined
}

async function save(tabId: number, media: PageMedia | undefined): Promise<void> {
  if (!session) {
    if (media) memory.set(tabId, media)
    else memory.delete(tabId)
  } else if (media) {
    await session.set({ [`${PREFIX}${tabId}`]: media })
  } else {
    await session.remove(`${PREFIX}${tabId}`)
  }
  // Per tab: the browser shows it only while that tab is active, and drops it when the tab closes
  // (chrome.action.setBadgeText's tabId). Firefox also drops it on navigation (MDN), Chrome
  // doesn't, so it's always set here.
  await api.action
    .setBadgeText({ tabId, text: media?.items.length ? String(media.items.length) : '' })
    .catch(() => {})
  // An open popup re-reads its tab's list; with none open there's nobody to receive this.
  await api.runtime.sendMessage({ mediaChanged: tabId } satisfies MediaChanged).catch(() => {})
}

/** Kept off the list: a site the user excluded (Options), or one pending review. */
function skipped(sites: readonly string[], urls: readonly string[]): boolean {
  return excluded(sites, urls) || excluded(PENDING_SITES, urls)
}

async function storedTabs(): Promise<number[]> {
  if (!session) return [...memory.keys()]
  return Object.keys(await session.get(null))
    .filter((key) => key.startsWith(PREFIX))
    .map((key) => Number(key.slice(PREFIX.length)))
}

// Every change to a tab's list reads it and writes it back; two manifests answered at once would
// otherwise each add to the list as it was before the other.
const queues = new Map<number, Promise<void>>()

function queued(tabId: number, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(job).catch(() => {})
  queues.set(tabId, next)
  void next.then(() => {
    if (queues.get(tabId) === next) queues.delete(tabId)
  })
  return next
}

/** The tab's list, for the popup. */
export async function mediaOf(tabId: number): Promise<PageMedia | null> {
  await queues.get(tabId)
  return (await load(tabId)) ?? null
}

async function remember(tabId: number, url: string, kind: MediaKind): Promise<void> {
  // The page the stream belongs to is the one the tab shows (Tab.url is its last committed URL).
  const page = (await api.tabs.get(tabId).catch(() => undefined))?.url
  if (!page || !/^https?:/i.test(page)) return
  if (skipped((await loadSettings()).sites, [url, page])) return
  // Mergelane's Settings › Browser extensions can turn the video list off.
  if (!(await loadAppRules()).videoButton) return
  const current = await load(tabId)
  // A list left from the tab's previous page, if its navigation hasn't been seen yet.
  const items = withItem(current && samePage(current.page, page) ? current.items : [], {
    url,
    kind
  })
  if (items) await save(tabId, { page, items })
}

/** The tab now shows `url`: a list kept for another page goes. */
async function moved(tabId: number, url: string): Promise<void> {
  const current = await load(tabId)
  if (!current) return
  await save(tabId, samePage(current.page, url) ? current : undefined)
}

/** Settings changed: drop what's now on an excluded site. */
async function prune(): Promise<void> {
  const { sites } = await loadSettings()
  for (const tabId of await storedTabs()) {
    void queued(tabId, async () => {
      const current = await load(tabId)
      if (!current) return
      const items = current.items.filter(({ url }) => !skipped(sites, [url, current.page]))
      if (items.length === current.items.length) return
      await save(tabId, items.length ? { ...current, items } : undefined)
    })
  }
}

function headerOf(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value ?? ''
}

/** One response's headers: a manifest a tab's page asked for is remembered. Never blocks or
 * changes the response. */
function observe(details: chrome.webRequest.OnHeadersReceivedDetails): undefined {
  // -1: "the request isn't related to a tab" (webRequest's tabId), as a site's service worker's
  // own fetches aren't. A document's own load is a navigation, never one of its streams.
  if (details.tabId < 0 || details.type === 'main_frame') return
  // Chrome 106+ says which document asked (Firefox doesn't: MDN browser-compat-data): skip a
  // prerendered page or one being unloaded, whose tab shows another page.
  const lifecycle: string | undefined = details.documentLifecycle
  if (lifecycle && lifecycle !== 'active') return
  // 304: revalidated from the browser's cache, still the page's stream.
  const status = details.statusCode
  if (!((status >= 200 && status < 300) || status === 304)) return
  const kind = manifestKind(details.url, headerOf(details.responseHeaders, 'content-type'))
  if (kind) void queued(details.tabId, () => remember(details.tabId, details.url, kind))
}

/** Registers the listeners; call once, synchronously, when the background script starts, so the
 * events that wake a stopped service worker reach them. */
export function watchMedia(): void {
  api.webRequest.onHeadersReceived.addListener(observe, { urls: ['http://*/*', 'https://*/*'] }, [
    'responseHeaders'
  ])
  // url: present only when it changed (tabs.onUpdated); a reload keeps the list, whose streams
  // the page loads again anyway.
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) void queued(tabId, () => moved(tabId, change.url as string))
  })
  api.tabs.onRemoved.addListener((tabId) => void queued(tabId, () => save(tabId, undefined)))
  api.tabs.onReplaced.addListener((_added, removed) => {
    void queued(removed, () => save(removed, undefined))
  })
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') void prune()
  })
}

/** The badge's colours: the extension's accent (ui.css), whose white text reads at WCAG AA. */
export function styleBadge(): void {
  void api.action.setBadgeBackgroundColor({ color: '#b45309' }).catch(() => {})
  // Chrome 110+, Firefox 109+ (MDN browser-compat-data).
  void api.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {})
}
