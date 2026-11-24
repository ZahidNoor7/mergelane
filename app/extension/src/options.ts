import { api } from './api'
import { ASK } from './ask'
import { reach, type Reach } from './mergelane'
import { loadAppRules, loadSettings, ownChange, saveSettings, siteOf } from './settings'

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** How long Mergelane gets to open before the page asks again whether it is there. */
export const WAKE_RECHECK_MS = 4000

export async function render(): Promise<void> {
  const [settings, app] = await Promise.all([loadSettings(), loadAppRules()])
  element<HTMLInputElement>('capture').checked = settings.capture
  element('capture-hint').textContent = settings.capture
    ? 'Every download this browser starts opens in Mergelane. If Mergelane isn’t open, the browser keeps it.'
    : 'Off: the browser keeps every download. Right-click › Download with Mergelane still sends a link.'
  element('app-off').hidden = !settings.capture || app.capture

  element<HTMLInputElement>('skip-small').checked = settings.skipSmall
  const minimum = element<HTMLInputElement>('min-mb')
  // Not while it is being typed in: a save would put the stored value back under the cursor.
  if (document.activeElement !== minimum) minimum.value = String(settings.minMegabytes)
  minimum.disabled = !settings.skipSmall

  const list = element('sites')
  list.replaceChildren(
    ...settings.sites.map((site) => {
      const item = document.createElement('li')
      item.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-globe" /></svg>'
      const name = document.createElement('span')
      name.textContent = site
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ghost small'
      remove.textContent = 'Remove'
      remove.setAttribute('aria-label', `Remove ${site}`)
      remove.addEventListener('click', () => {
        void saveSettings({ sites: settings.sites.filter((other) => other !== site) })
      })
      item.append(name, remove)
      return item
    })
  )
  element('no-sites').hidden = settings.sites.length > 0
}

const CONNECTION: Record<Reach, { tone: string; text: string }> = {
  ok: { tone: 'ok', text: 'Connected to Mergelane' },
  update: { tone: 'warn', text: 'Update Mergelane to use this extension' },
  closed: { tone: '', text: 'Mergelane isn’t open' }
}

export async function renderConnection(): Promise<void> {
  const reached = await reach()
  const { tone, text } = CONNECTION[reached]
  element('status').dataset.state = reached
  element('dot').className = `dot ${tone}`
  element('connection').textContent = text
  const open = element<HTMLButtonElement>('open-mergelane')
  open.hidden = reached !== 'closed'
  open.disabled = false
  open.textContent = 'Open Mergelane'
}

element<HTMLInputElement>('capture').addEventListener('change', (event) => {
  void saveSettings({ capture: (event.target as HTMLInputElement).checked })
})
element<HTMLInputElement>('skip-small').addEventListener('change', (event) => {
  void saveSettings({ skipSmall: (event.target as HTMLInputElement).checked })
})
element<HTMLInputElement>('min-mb').addEventListener('change', (event) => {
  const field = event.target as HTMLInputElement
  const megabytes = Math.round(Number(field.value))
  if (megabytes >= 1) void saveSettings({ minMegabytes: megabytes })
  else {
    field.blur()
    void render()
  }
})

const siteField = element<HTMLInputElement>('site')
function showSiteError(shown: boolean): void {
  element('site-error').hidden = !shown
  if (shown) siteField.setAttribute('aria-invalid', 'true')
  else siteField.removeAttribute('aria-invalid')
}
siteField.addEventListener('input', () => showSiteError(false))
element<HTMLFormElement>('add-site').addEventListener('submit', async (event) => {
  event.preventDefault()
  const site = siteOf(siteField.value)
  showSiteError(site === null && siteField.value.trim() !== '')
  if (!site) return
  const { sites } = await loadSettings()
  if (!sites.includes(site)) await saveSettings({ sites: [...sites, site] })
  siteField.value = ''
})

element<HTMLButtonElement>('open-mergelane').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  button.disabled = true
  button.textContent = 'Opening…'
  void api.runtime
    .sendMessage({ what: ASK, wakeMergelane: true })
    .then(() => setTimeout(() => void renderConnection(), WAKE_RECHECK_MS))
})

element('version').textContent = `Extension ${api.runtime.getManifest().version}`
api.storage.onChanged.addListener((changes) => {
  if (ownChange(changes)) void render()
})
void render()
void renderConnection()
