import { describe, expect, it, vi } from 'vitest'
import {
  blockingHint,
  levelFor,
  MODE_NONE,
  MODE_OPTIMAL,
  setSiteBlocking,
  siteBlocking,
  type Send
} from './adblock'

const PAGE = new URL('https://news.example.com/story')

/** A stand-in for uBO Lite's background: answers popupPanelData, getDefaultFilteringMode and
 * setFilteringMode the way background.js does. */
function ubol(answers: Record<string, unknown>): Send & ReturnType<typeof vi.fn> {
  return vi.fn(async (message: Record<string, unknown>) => {
    const answer = answers[message.what as string]
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as Send & ReturnType<typeof vi.fn>
}

describe('levelFor', () => {
  it('turns a site off to none', () => {
    expect(levelFor(false, 2)).toBe(MODE_NONE)
  })
  it('turns a site on to the default mode', () => {
    expect(levelFor(true, 1)).toBe(1)
    expect(levelFor(true, 3)).toBe(3)
  })
  it('turns a site on to optimal when blocking is off by default', () => {
    expect(levelFor(true, MODE_NONE)).toBe(MODE_OPTIMAL)
  })
})

describe('blockingHint', () => {
  it('says ads are blocked when the site has a mode', () => {
    expect(blockingHint({ level: 2, defaultLevel: 2, autoReload: true })).toBe(
      'Ads and trackers are blocked here.'
    )
  })
  it('says this site lets ads through', () => {
    expect(blockingHint({ level: 0, defaultLevel: 2, autoReload: true })).toBe(
      'Ads load as usual on this site.'
    )
  })
  it('says when blocking is off everywhere', () => {
    expect(blockingHint({ level: 0, defaultLevel: 0, autoReload: true })).toMatch(
      /off for every site/
    )
  })
})

describe('siteBlocking', () => {
  it("asks uBO Lite about the page's site", async () => {
    const send = ubol({
      popupPanelData: { level: 2, autoReload: true },
      getDefaultFilteringMode: 2
    })
    expect(await siteBlocking(send, PAGE)).toEqual({ level: 2, defaultLevel: 2, autoReload: true })
    expect(send).toHaveBeenCalledWith({
      what: 'popupPanelData',
      origin: 'https://news.example.com',
      hostname: 'news.example.com'
    })
    expect(send).toHaveBeenCalledWith({ what: 'getDefaultFilteringMode' })
  })
  it('keeps reloading on unless uBO Lite says it is off', async () => {
    const off = ubol({
      popupPanelData: { level: 0, autoReload: false },
      getDefaultFilteringMode: 1
    })
    expect((await siteBlocking(off, PAGE))?.autoReload).toBe(false)
    const unsaid = ubol({ popupPanelData: { level: 1 }, getDefaultFilteringMode: 1 })
    expect((await siteBlocking(unsaid, PAGE))?.autoReload).toBe(true)
  })
  it('is null when uBO Lite does not answer or answers nonsense', async () => {
    expect(await siteBlocking(ubol({}), PAGE)).toBeNull()
    const failing = ubol({ popupPanelData: new Error('no receiver'), getDefaultFilteringMode: 2 })
    expect(await siteBlocking(failing, PAGE)).toBeNull()
    const noDefault = ubol({
      popupPanelData: { level: 1 },
      getDefaultFilteringMode: new Error('x')
    })
    expect(await siteBlocking(noDefault, PAGE)).toBeNull()
    const odd = ubol({ popupPanelData: { level: 7 }, getDefaultFilteringMode: 2 })
    expect(await siteBlocking(odd, PAGE)).toBeNull()
    const fraction = ubol({ popupPanelData: { level: 1 }, getDefaultFilteringMode: 1.5 })
    expect(await siteBlocking(fraction, PAGE)).toBeNull()
    const text = ubol({ popupPanelData: { level: '2' }, getDefaultFilteringMode: 2 })
    expect(await siteBlocking(text, PAGE)).toBeNull()
  })
})

describe('setSiteBlocking', () => {
  it('sets the mode for the site and returns what uBO Lite set', async () => {
    const send = ubol({ setFilteringMode: 1 })
    expect(await setSiteBlocking(send, 'news.example.com', true, MODE_NONE)).toBe(1)
    expect(send).toHaveBeenCalledWith({
      what: 'setFilteringMode',
      hostname: 'news.example.com',
      level: MODE_OPTIMAL
    })
  })
  it('turns a site off', async () => {
    const send = ubol({ setFilteringMode: 0 })
    expect(await setSiteBlocking(send, 'news.example.com', false, 2)).toBe(0)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ level: MODE_NONE }))
  })
  it('is null when uBO Lite does not answer', async () => {
    expect(await setSiteBlocking(ubol({ setFilteringMode: new Error('x') }), 'a.b', true, 2)).toBe(
      null
    )
  })
})
