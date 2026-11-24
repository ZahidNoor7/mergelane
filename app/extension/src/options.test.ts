/// <reference types="vite/client" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASK } from './ask'
import html from './options.html?raw'

// options.ts drives options.html: it runs against the page's real markup, with a stand-in for the
// extension API's storage and messages, and for whether Mergelane answers (mergelane.ts).
const store: Record<string, unknown> = {}
const changed: ((changes: Record<string, unknown>) => void)[] = []
const sendMessage = vi.fn(async () => undefined)
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (defaults: Record<string, unknown>) => {
        const found: Record<string, unknown> = {}
        for (const key of Object.keys(defaults))
          found[key] = key in store ? store[key] : defaults[key]
        return found
      }),
      set: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
        const changes = Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, { newValue: value }])
        )
        for (const listener of changed) listener(changes)
      })
    },
    onChanged: {
      addListener: (listener: (changes: Record<string, unknown>) => void) => changed.push(listener)
    }
  },
  runtime: { getManifest: () => ({ version: '1.2.3' }), sendMessage }
})

const reach = vi.fn(async () => 'ok' as 'ok' | 'closed' | 'update')
vi.mock('./mergelane', () => ({ reach: () => reach() }))

let options: typeof import('./options')

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
/** Lets the page's promises (storage, the connection check) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const change = (id: string, value?: string | boolean): void => {
  const input = byId<HTMLInputElement>(id)
  if (typeof value === 'boolean') input.checked = value
  else if (value !== undefined) input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
const submitSite = async (text: string): Promise<void> => {
  byId<HTMLInputElement>('site').value = text
  byId<HTMLFormElement>('add-site').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  )
  await settle()
  await settle()
}

beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  options = await import('./options')
  await settle()
})

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key]
  reach.mockResolvedValue('ok')
  await options.render()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the page', () => {
  it('shows the extension version', () => {
    expect(byId('version').textContent).toBe('Extension 1.2.3')
  })
  it('links its two sections, this one current', () => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('.sections a')]
    expect(links.map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
      ['Downloads', 'options.html'],
      ['Ad blocking', 'dashboard.html']
    ])
    expect(links[0].getAttribute('aria-current')).toBe('page')
    expect(byId('open-blocking').getAttribute('href')).toBe('dashboard.html')
  })
})

describe('capture', () => {
  it('starts on, saying where downloads go', () => {
    expect(byId<HTMLInputElement>('capture').checked).toBe(true)
    expect(byId('capture-hint').textContent).toMatch(/^Every download this browser starts/)
    expect(byId('app-off').hidden).toBe(true)
  })
  it('turned off, saves that and says the browser keeps downloads', async () => {
    change('capture', false)
    await settle()
    expect(store.capture).toBe(false)
    expect(byId('capture-hint').textContent).toMatch(/^Off: the browser keeps every download/)
  })
  it("says so when Mergelane's own setting stops downloads being sent", async () => {
    store.appRules = { capture: false, videoButton: true }
    await options.render()
    expect(byId('app-off').hidden).toBe(false)
    store.capture = false
    await options.render()
    expect(byId('app-off').hidden).toBe(true)
  })
})

describe('skip small files', () => {
  it('starts off, with the size field disabled', () => {
    expect(byId<HTMLInputElement>('skip-small').checked).toBe(false)
    expect(byId<HTMLInputElement>('min-mb').disabled).toBe(true)
  })
  it('turned on, saves that and enables the size field', async () => {
    change('skip-small', true)
    await settle()
    expect(store.skipSmall).toBe(true)
    expect(byId<HTMLInputElement>('min-mb').disabled).toBe(false)
  })
  it('saves a whole number of megabytes', async () => {
    change('min-mb', '4.6')
    await settle()
    expect(store.minMegabytes).toBe(5)
  })
  it('puts the saved size back for one under 1', async () => {
    store.minMegabytes = 3
    change('min-mb', '0')
    await settle()
    await settle()
    expect(store.minMegabytes).toBe(3)
    expect(byId<HTMLInputElement>('min-mb').value).toBe('3')
  })
  it("doesn't overwrite the size while it is being typed", async () => {
    const field = byId<HTMLInputElement>('min-mb')
    field.disabled = false
    field.focus()
    field.value = '12'
    store.minMegabytes = 7
    await options.render()
    expect(field.value).toBe('12')
    field.blur()
  })
})

describe('sites that keep their downloads', () => {
  it('starts empty, saying every site goes to Mergelane', () => {
    expect(byId('sites').children).toHaveLength(0)
    expect(byId('no-sites').hidden).toBe(false)
  })
  it('adds a typed site once, as its host name', async () => {
    await submitSite('https://Drive.Google.com/file')
    await submitSite('drive.google.com')
    expect(store.sites).toEqual(['drive.google.com'])
    expect(byId<HTMLInputElement>('site').value).toBe('')
    const item = byId('sites').querySelector('li')!
    expect(item.querySelector('span')?.textContent).toBe('drive.google.com')
    expect(byId('no-sites').hidden).toBe(true)
  })
  it('says what is wrong with something that is not a site, until it is edited', async () => {
    await submitSite('not a site')
    expect(byId('site-error').hidden).toBe(false)
    expect(byId('site').getAttribute('aria-invalid')).toBe('true')
    expect(store.sites).toBeUndefined()
    byId('site').dispatchEvent(new Event('input'))
    expect(byId('site-error').hidden).toBe(true)
    expect(byId('site').hasAttribute('aria-invalid')).toBe(false)
  })
  it('ignores an empty field without an error', async () => {
    await submitSite('   ')
    expect(byId('site-error').hidden).toBe(true)
  })
  it('removes a site', async () => {
    store.sites = ['a.example', 'b.example']
    await options.render()
    const remove = byId('sites').querySelector<HTMLButtonElement>(
      '[aria-label="Remove a.example"]'
    )!
    remove.click()
    await settle()
    await settle()
    expect(store.sites).toEqual(['b.example'])
    expect([...byId('sites').querySelectorAll('li span')].map((span) => span.textContent)).toEqual([
      'b.example'
    ])
  })
})

describe('the connection', () => {
  it('says connected', async () => {
    await options.renderConnection()
    expect(byId('status').dataset.state).toBe('ok')
    expect(byId('connection').textContent).toBe('Connected to Mergelane')
    expect(byId('dot').className).toBe('dot ok')
    expect(byId('open-mergelane').hidden).toBe(true)
  })
  it('asks for an update when Mergelane is too old', async () => {
    reach.mockResolvedValue('update')
    await options.renderConnection()
    expect(byId('status').dataset.state).toBe('update')
    expect(byId('dot').className).toBe('dot warn')
    expect(byId('open-mergelane').hidden).toBe(true)
  })
  it('offers to open Mergelane when it is closed, and checks again after', async () => {
    reach.mockResolvedValue('closed')
    await options.renderConnection()
    const open = byId<HTMLButtonElement>('open-mergelane')
    expect(byId('connection').textContent).toBe('Mergelane isn’t open')
    expect(open.hidden).toBe(false)

    vi.useFakeTimers()
    open.click()
    expect(open.disabled).toBe(true)
    expect(open.textContent).toBe('Opening…')
    expect(sendMessage).toHaveBeenCalledWith({ what: ASK, wakeMergelane: true })
    reach.mockResolvedValue('ok')
    await vi.advanceTimersByTimeAsync(options.WAKE_RECHECK_MS)
    vi.useRealTimers()
    await settle()
    expect(byId('connection').textContent).toBe('Connected to Mergelane')
    expect(open.hidden).toBe(true)
    expect(open.disabled).toBe(false)
    expect(open.textContent).toBe('Open Mergelane')
  })
})

describe('changes made elsewhere', () => {
  it("redraws for Mergelane's settings, not for others", async () => {
    const render = vi.spyOn(document, 'getElementById')
    for (const listener of changed) listener({ unrelated: { newValue: 1 } })
    expect(render).not.toHaveBeenCalled()
    store.capture = false
    for (const listener of changed) listener({ capture: { newValue: false } })
    await settle()
    expect(byId<HTMLInputElement>('capture').checked).toBe(false)
    render.mockRestore()
  })
})
