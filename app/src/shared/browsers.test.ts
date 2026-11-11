import { describe, expect, it } from 'vitest'
import { browserOfExecutable, BROWSERS, installSteps } from './browsers'

describe('the browsers Mergelane knows', () => {
  it('a supported browser has an extension build and a page to load it on; the rest say why not', () => {
    for (const browser of BROWSERS) {
      if (browser.notYet) {
        expect(browser.kind, browser.id).toBeNull()
        expect(browser.extensionsPage, browser.id).toBeNull()
      } else {
        expect(browser.kind, browser.id).not.toBeNull()
        expect(browser.extensionsPage, browser.id).toMatch(/^(chrome|edge|about):/)
      }
    }
    expect(BROWSERS.filter((each) => !each.notYet).map((each) => each.id)).toEqual([
      'chrome',
      'edge',
      'chromium',
      'firefox'
    ])
  })

  it('gives each kind its steps, starting from the folder in the Finder', () => {
    const edge = BROWSERS.find((each) => each.id === 'edge')!
    expect(installSteps(edge)).toEqual([
      'Show the extension folder in the Finder.',
      'In Edge, go to edge://extensions.',
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ])
    const firefox = BROWSERS.find((each) => each.id === 'firefox')!
    expect(installSteps(firefox)[1]).toBe(
      'In Firefox, go to about:debugging#/runtime/this-firefox.'
    )
    expect(installSteps(firefox)).toHaveLength(4)
    expect(installSteps(BROWSERS.find((each) => each.id === 'safari')!)).toEqual([])
  })
})

describe('browserOfExecutable', () => {
  it('names the browser whose app bundle holds the executable', () => {
    expect(
      browserOfExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ).toBe('chrome')
    expect(
      browserOfExecutable('/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    ).toBe('edge')
    expect(browserOfExecutable('/Applications/Firefox.app/Contents/MacOS/firefox')).toBe('firefox')
    expect(browserOfExecutable('/usr/bin/python3')).toBeNull()
    expect(browserOfExecutable('')).toBeNull()
  })
})
