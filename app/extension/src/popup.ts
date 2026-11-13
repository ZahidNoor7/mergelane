import { youtubeLink } from '../../src/shared/youtube'
import { blockingHint, setSiteBlocking, siteBlocking, type Send } from './adblock'
import { api } from './api'
import { ASK } from './ask'
import {
  describe,
  samePage,
  type HandOver,
  type MediaChanged,
  type MediaItem,
  type MediaRequest,
  type PageMedia
} from './media'
import { reach } from './mergelane'
import { excluded, loadSettings, ownChange, saveSettings } from './settings'

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const ALL_SITES = { origins: ['<all_urls>'] }

/** The tab the popup is about: the active one, or `?tab=<id>` when popup.html is open in a tab of
 * its own (the e2e tests open it that way). */
async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const forced = Number(new URLSearchParams(location.search).get('tab'))
  if (Number.isSafeInteger(forced) && forced > 0) {
    return api.tabs.get(forced).catch(() => undefined)
  }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function activeHost(): Promise<string | null> {
  const tab = await targetTab()
  return tab?.url && /^https?:/i.test(tab.url) ? new URL(tab.url).hostname : null
}

async function render(): Promise<void> {
  const [settings, host, reached, access] = await Promise.all([
    loadSettings(),
    activeHost(),
    reach(),
    // Firefox lets the user withhold site access, which reading a site's cookies needs.
    api.permissions.contains(ALL_SITES)
  ])
  const [tone, text] =
    reached === 'closed'
      ? ['', 'Mergelane not open']
      : reached === 'update'
        ? ['warn', 'Update Mergelane']
        : settings.capture
          ? ['ok', 'Connected']
          : ['', 'Capture off']
  element('status-dot').className = `dot ${tone}`
  element('status-text').textContent = text
  element('access').hidden = access
  element('closed').hidden = reached !== 'closed'

  element<HTMLInputElement>('capture').checked = settings.capture
  element('capture-hint').textContent = settings.capture
    ? 'Downloads open in Mergelane instead of the browser.'
    : 'Downloads stay in the browser.'

  element('site-row').hidden = host === null
  if (host) {
    const on = !excluded(settings.sites, [`https://${host}/`])
    const site = element<HTMLInputElement>('site')
    site.checked = on && settings.capture
    site.disabled = !settings.capture
    element('site-host').textContent = host
    element('site-hint').textContent = !settings.capture
      ? 'Capture is off everywhere.'
      : on
        ? 'Downloads from this site go to Mergelane.'
        : 'Downloads from this site stay in the browser.'
  }
}

// --- Block ads on this site (uBO Lite, ADR-0063) -------------------------------------------------

const ubol: Send = (message) => api.runtime.sendMessage(message)

/** The tab's web address, for a page on the web; null for the browser's own pages. */
async function webPage(): Promise<URL | null> {
  const tab = await targetTab()
  if (!tab?.url || !/^https?:/i.test(tab.url)) return null
  return new URL(tab.url)
}

async function renderBlocking(): Promise<void> {
  const page = await webPage()
  const state = page && (await siteBlocking(ubol, page))
  element('blocking').hidden = state === null
  if (!state) return
  element<HTMLInputElement>('block').checked = state.level > 0
  element('block-hint').textContent = blockingHint(state)
}

element<HTMLInputElement>('block').addEventListener('change', async (event) => {
  const toggle = event.target as HTMLInputElement
  const page = await webPage()
  const before = page && (await siteBlocking(ubol, page))
  if (!page || !before) return void renderBlocking()
  toggle.disabled = true
  const level = await setSiteBlocking(ubol, page.hostname, toggle.checked, before.defaultLevel)
  toggle.disabled = false
  const after = { ...before, level: level ?? before.level }
  toggle.checked = after.level > 0
  element('block-hint').textContent = blockingHint(after)
  toggle.focus()
  // The page keeps what it already loaded until it reloads, as uBO Lite's own popup does.
  const tab = await targetTab()
  if (level !== null && level !== before.level && after.autoReload && tab?.id !== undefined) {
    void api.tabs.reload(tab.id)
  }
})

// --- Videos on this page (the background lists them: mediaWatch.ts) -----------------------------

/** The tab whose list is shown, so its changes are the ones that redraw it. */
let shownTab: number | undefined
/** Rows by stream, kept while they stay listed: redrawing one would drop its keyboard focus. */
const rows = new Map<string, HTMLLIElement>()
/** A Download clicked and not yet answered, or answered by Mergelane taking it. */
const handed = new Map<string, 'busy' | 'sent'>()

const MESSAGES: Record<HandOver, string> = {
  sent: 'Sent to Mergelane. Finish in its New download window.',
  kept: 'Mergelane couldn’t open this stream. Reload the page and try again.',
  closed: 'Mergelane isn’t open. Open it, then try again.'
}

async function renderMedia(): Promise<void> {
  const tab = await targetTab()
  shownTab = tab?.id
  const media =
    tab?.id === undefined
      ? null
      : ((await api.runtime
          .sendMessage({ what: ASK, mediaOf: tab.id } satisfies MediaRequest)
          .catch(() => null)) as PageMedia | null)
  const items = media && tab?.url && samePage(media.page, tab.url) ? media.items : []
  const urls = new Set(items.map(({ url }) => url))
  for (const [url, row] of rows) {
    if (urls.has(url)) continue
    row.remove()
    rows.delete(url)
    if (handed.get(url) === 'sent') handed.delete(url)
  }
  // Lists only grow until the tab moves on, so new streams go at the end.
  for (const item of items) {
    if (rows.has(item.url) || tab?.id === undefined) continue
    const row = mediaRow(tab.id, item)
    rows.set(item.url, row)
    element('media-list').append(row)
  }
  element('media').hidden = items.length === 0
}

function textSpan(className: string, text = ''): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

function mediaRow(tabId: number, { url, kind }: MediaItem): HTMLLIElement {
  const { host, path } = describe(url)
  const where = textSpan('grow')
  const pathLine = textSpan('media-path muted', path)
  // The whole address, for the paths shortened to fit.
  pathLine.title = url
  where.append(textSpan('media-host', host), pathLine)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'media-send'
  button.setAttribute('aria-label', `Download with Mergelane: ${kind} stream from ${host}`)
  showHanded(button, handed.get(url))
  button.addEventListener('click', () => void download(tabId, url, button))

  const row = document.createElement('li')
  row.append(textSpan('kind', kind), where, button)
  return row
}

/** aria-disabled rather than disabled: a disabled button would lose the keyboard focus. */
function showHanded(button: HTMLButtonElement, state: 'busy' | 'sent' | undefined): void {
  button.textContent = state === 'busy' ? 'Sending…' : state === 'sent' ? 'Sent' : 'Download'
  button.classList.toggle('sent', state === 'sent')
  if (state) button.setAttribute('aria-disabled', 'true')
  else button.removeAttribute('aria-disabled')
  if (state === 'busy') button.setAttribute('aria-busy', 'true')
  else button.removeAttribute('aria-busy')
}

async function download(tabId: number, url: string, button: HTMLButtonElement): Promise<void> {
  if (handed.has(url)) return
  handed.set(url, 'busy')
  showHanded(button, 'busy')
  element('media-status').textContent = ''
  // The background sends it, so it still arrives if this popup closes meanwhile; it starts
  // Mergelane first if needed, as the link menu does.
  const result = ((await api.runtime
    .sendMessage({ what: ASK, sendMedia: { tabId, url } } satisfies MediaRequest)
    .catch(() => null)) ?? 'kept') as HandOver
  if (result === 'sent') handed.set(url, 'sent')
  else handed.delete(url)
  showHanded(button, handed.get(url))
  element('media-status').textContent = MESSAGES[result]
  // Shows "Mergelane isn't open" and its Open button.
  if (result === 'closed') void render()
}

// --- The YouTube video the tab shows (ADR-0026): only its address goes, for yt-dlp to look up --

/** The Send button clicked and not yet answered, or answered by Mergelane taking it. */
let video: 'busy' | 'sent' | undefined

const VIDEO_MESSAGES: Record<HandOver, string> = {
  sent: 'Sent to Mergelane. Pick the quality in its New download window.',
  kept: 'Mergelane couldn’t take this video. Try again.',
  closed: 'Mergelane isn’t open. Open it, then try again.'
}

function showVideo(): void {
  const button = element<HTMLButtonElement>('video-send')
  button.textContent =
    video === 'busy'
      ? 'Sending…'
      : video === 'sent'
        ? 'Sent to Mergelane'
        : 'Send this video to Mergelane'
  button.classList.toggle('sent', video === 'sent')
  button.classList.toggle('primary', video !== 'sent')
  if (video) button.setAttribute('aria-disabled', 'true')
  else button.removeAttribute('aria-disabled')
  if (video === 'busy') button.setAttribute('aria-busy', 'true')
  else button.removeAttribute('aria-busy')
}

async function renderVideo(): Promise<void> {
  const tab = await targetTab()
  const link = tab?.url ? youtubeLink(tab.url) : null
  element('video').hidden = link?.kind !== 'video'
  if (link?.kind !== 'video') return
  // YouTube's tab titles end in " - YouTube"; without the tabs permission there's none.
  element('video-name').textContent = tab?.title?.replace(/\s+-\s+YouTube$/, '') || link.url
  showVideo()
}

element('video-send').addEventListener('click', async () => {
  const tab = await targetTab()
  if (video || tab?.id === undefined) return
  video = 'busy'
  showVideo()
  element('video-status').textContent = ''
  const result = ((await api.runtime
    .sendMessage({ what: ASK, sendVideo: { tabId: tab.id } } satisfies MediaRequest)
    .catch(() => null)) ?? 'kept') as HandOver
  video = result === 'sent' ? 'sent' : undefined
  showVideo()
  element('video-status').textContent = VIDEO_MESSAGES[result]
  if (result === 'closed') void render()
})

// ------------------------------------------------------------------------------------------------

element<HTMLInputElement>('capture').addEventListener('change', (event) => {
  void saveSettings({ capture: (event.target as HTMLInputElement).checked })
})

element<HTMLInputElement>('site').addEventListener('change', async (event) => {
  const host = await activeHost()
  if (!host) return
  const { sites } = await loadSettings()
  // A parent domain's rule covers this site too, so turning it back on drops that as well.
  const covering = (site: string): boolean => host === site || host.endsWith(`.${site}`)
  await saveSettings({
    sites: (event.target as HTMLInputElement).checked
      ? sites.filter((site) => !covering(site))
      : [...sites, host]
  })
})

element('grant').addEventListener('click', () => {
  void api.permissions.request(ALL_SITES).then(() => Promise.all([render(), renderBlocking()]))
})
element('open-mergelane').addEventListener('click', () => {
  void api.runtime.sendMessage({ what: ASK, wakeMergelane: true })
})
element('options').addEventListener('click', () => void api.runtime.openOptionsPage())

// Settings only: the session area is the background's stream lists, which announce themselves.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' && ownChange(changes)) void render()
})
api.runtime.onMessage.addListener((message) => {
  const changed = (message as Partial<MediaChanged>).mediaChanged
  if (changed !== undefined && changed === shownTab) void renderMedia()
})
void render()
void renderBlocking()
void renderVideo()
void renderMedia()
// So the toolbar icon agrees with the popup now, not at its next check.
void api.runtime.sendMessage({ what: ASK, checkMergelane: true }).catch(() => {})
