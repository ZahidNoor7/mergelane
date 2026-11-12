import { describe, expect, it } from 'vitest'
import {
  browserOfExecutable,
  BROWSERS,
  EXTENSION_FOLDER_NAME,
  installSteps,
  pickPath,
  type BrowserState,
  notYetOn,
  windowsCandidates,
  type BrowserSpec
} from './browsers'

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

  it('gives each kind its steps, starting from the folder Mergelane saved', () => {
    const edge = BROWSERS.find((each) => each.id === 'edge')!
    expect(installSteps(edge)).toEqual([
      'Mergelane saved the extension in this folder. Keep it there: Edge loads it from there.',
      'Open Edge and go to edge://extensions.',
      'Turn on Developer mode.',
      'Click “Load unpacked” and choose that folder.'
    ])
    const firefox = BROWSERS.find((each) => each.id === 'firefox')!
    expect(installSteps(firefox)[1]).toBe(
      'Open Firefox and go to about:debugging#/runtime/this-firefox.'
    )
    expect(installSteps(firefox)).toHaveLength(4)
    expect(installSteps(BROWSERS.find((each) => each.id === 'safari')!)).toEqual([])
  })

  it('points the file picker at the folder, or at Firefox’s manifest.json', () => {
    const state = (id: string, extensionFolder: string | null): BrowserState => ({
      ...BROWSERS.find((each) => each.id === id)!,
      found: true,
      appPath: null,
      contact: null,
      extensionFolder
    })
    expect(pickPath(state('chrome', '/Users/a/Downloads/Mergelane Extension'))).toBe(
      '/Users/a/Downloads/Mergelane Extension'
    )
    expect(pickPath(state('firefox', '/Users/a/Downloads/Mergelane Extension for Firefox'))).toBe(
      '/Users/a/Downloads/Mergelane Extension for Firefox/manifest.json'
    )
    expect(pickPath(state('chrome', null))).toBeNull()
    expect(Object.values(EXTENSION_FOLDER_NAME)).toEqual([
      'Mergelane Extension',
      'Mergelane Extension for Firefox'
    ])
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

describe('the browsers on Windows', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local'
  }
  const spec = (id: string): BrowserSpec => BROWSERS.find((each) => each.id === id)!

  it('looks in the three install folders, the usual one first', () => {
    expect(windowsCandidates(spec('chrome'), env)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ])
    expect(windowsCandidates(spec('firefox'), { LOCALAPPDATA: 'L' })).toEqual([
      'L\\Mozilla Firefox\\firefox.exe'
    ])
    expect(windowsCandidates(spec('safari'), env)).toEqual([])
  })

  it('knows a browser by its executable', () => {
    expect(browserOfExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe(
      'chrome'
    )
    expect(
      browserOfExecutable('C:\\Users\\a\\AppData\\Local\\Chromium\\Application\\chrome.exe')
    ).toBe('chromium')
    expect(
      browserOfExecutable('C:\\PROGRAM FILES (X86)\\MICROSOFT\\EDGE\\APPLICATION\\MSEDGE.EXE')
    ).toBe('edge')
    expect(browserOfExecutable('C:\\Program Files\\Mozilla Firefox\\firefox.exe')).toBe('firefox')
    expect(browserOfExecutable('C:\\Windows\\System32\\cmd.exe')).toBeNull()
  })

  it('supports only browsers whose makers document their Windows key', () => {
    for (const id of ['chrome', 'edge', 'firefox'])
      expect(notYetOn(spec(id), 'win32'), id).toBeUndefined()
    expect(notYetOn(spec('chromium'), 'win32')).toBe(
      'Not supported yet: Chromium doesn’t document where it looks for Mergelane’s helper on Windows.'
    )
    expect(notYetOn(spec('brave'), 'win32')).toBe(spec('brave').notYet)
    expect(notYetOn(spec('safari'), 'win32')).toBe(spec('safari').notYet)
    // macOS as before.
    expect(notYetOn(spec('chromium'), 'darwin')).toBeUndefined()
  })

  it('points the file picker at a Windows folder with its own separator', () => {
    const firefox = {
      ...spec('firefox'),
      found: true,
      appPath: null,
      contact: null,
      extensionFolder: 'C:\\Ext\\F'
    }
    expect(pickPath(firefox)).toBe('C:\\Ext\\F\\manifest.json')
  })
})
