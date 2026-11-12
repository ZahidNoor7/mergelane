import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID, NATIVE_HOST } from '../src/shared/browserBridge'
import {
  browsers,
  hostManifest,
  registerNativeHost,
  registerNativeHostWindows,
  windowsHostKeys
} from '../src/main/nativeHost'

// The per-user manifests that let the browsers start mergelane-nmhost (docs/BROWSER-BRIDGE.md).
test.describe('browser host registration @smoke', () => {
  test('Chrome-family manifests allow only our extension, by origin', () => {
    const manifest = JSON.parse(
      hostManifest('/Applications/Mergelane.app/x/mergelane-nmhost', false)
    )
    expect(manifest).toEqual({
      name: NATIVE_HOST,
      description: 'Hands downloads from the browser to Mergelane',
      path: '/Applications/Mergelane.app/x/mergelane-nmhost',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    })
    // Chrome's rule for host names: lowercase letters, digits, underscores and single dots.
    expect(NATIVE_HOST).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/)
  })

  test('the Firefox manifest allows only our add-on, by ID', () => {
    const manifest = JSON.parse(hostManifest('/bin/host', true))
    expect(manifest.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    expect(manifest.allowed_origins).toBeUndefined()
  })

  test('writes a manifest for each installed browser only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mergelane-home-'))
    try {
      const [chrome, , chromium, mozilla, edge] = browsers(home)
      await mkdir(chrome!.dir, { recursive: true })
      await mkdir(mozilla!.dir, { recursive: true })
      await mkdir(edge!.dir, { recursive: true })
      const written = await registerNativeHost('/bin/host', home)
      expect(written).toEqual([
        join(chrome!.dir, 'NativeMessagingHosts', `${NATIVE_HOST}.json`),
        join(mozilla!.dir, 'NativeMessagingHosts', `${NATIVE_HOST}.json`),
        // Microsoft's docs: the Stable channel's user data folder (learn.microsoft.com).
        join(
          home,
          'Library',
          'Application Support',
          'Microsoft Edge',
          'NativeMessagingHosts',
          `${NATIVE_HOST}.json`
        )
      ])
      expect(JSON.parse(await readFile(written[0]!, 'utf8')).allowed_origins).toBeDefined()
      expect(JSON.parse(await readFile(written[1]!, 'utf8')).allowed_extensions).toBeDefined()
      expect(JSON.parse(await readFile(written[2]!, 'utf8')).allowed_origins).toBeDefined()
      expect(chromium!.dir.endsWith('Chromium')).toBe(true)
      // Written again on every start: the same files, overwritten.
      expect(await registerNativeHost('/bin/other', home)).toHaveLength(3)
      expect(JSON.parse(await readFile(written[0]!, 'utf8')).path).toBe('/bin/other')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('a folder that cannot be written is skipped, not fatal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mergelane-home-'))
    try {
      // A file where the NativeMessagingHosts folder should be.
      const [chrome] = browsers(home)
      await mkdir(chrome!.dir, { recursive: true })
      await (
        await import('node:fs/promises')
      ).writeFile(join(chrome!.dir, 'NativeMessagingHosts'), '')
      const warn = console.warn
      console.warn = () => {}
      try {
        expect(await registerNativeHost('/bin/host', home)).toEqual([])
      } finally {
        console.warn = warn
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

// Windows (W2): manifests in Mergelane's own folder, and one HKCU key per installed browser.
test.describe('browser host registration on Windows @smoke', () => {
  const chrome = { hostKey: 'Software\\Google\\Chrome\\NativeMessagingHosts', firefox: false }
  const edge = { hostKey: 'Software\\Microsoft\\Edge\\NativeMessagingHosts', firefox: false }
  const firefox = { hostKey: 'Software\\Mozilla\\NativeMessagingHosts', firefox: true }
  const chromium = { hostKey: null, firefox: false }

  test('one key per browser that documents one, pointing at the manifest of its kind', () => {
    expect(
      windowsHostKeys({ chrome: 'C:\\m\\chrome.json', firefox: 'C:\\m\\firefox.json' }, [
        chrome,
        chromium,
        firefox
      ])
    ).toEqual([
      {
        key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
        manifest: 'C:\\m\\chrome.json'
      },
      {
        key: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST}`,
        manifest: 'C:\\m\\firefox.json'
      }
    ])
  })

  test('writes both manifests and runs reg add for each key, skipping one that fails', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mergelane-win-host-'))
    try {
      const calls: string[][] = []
      const written = await registerNativeHostWindows(
        'C:\\App\\resources\\mergelane-nmhost.exe',
        folder,
        [chrome, edge, firefox],
        async (args) => {
          calls.push(args)
          if (args[1]!.includes('Edge')) throw new Error('access denied')
        }
      )
      const chromeManifest = join(folder, 'NativeMessagingHosts', 'chrome.json')
      expect(calls[0]).toEqual([
        'add',
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        chromeManifest,
        '/f'
      ])
      expect(written.map((entry) => entry.key)).toEqual([
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
        `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST}`
      ])
      expect(JSON.parse(await readFile(chromeManifest, 'utf8')).path).toBe(
        'C:\\App\\resources\\mergelane-nmhost.exe'
      )
      const firefoxManifest = JSON.parse(
        await readFile(join(folder, 'NativeMessagingHosts', 'firefox.json'), 'utf8')
      )
      expect(firefoxManifest.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  test('writes nothing when no installed browser can be registered', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mergelane-win-host-'))
    try {
      expect(await registerNativeHostWindows('x.exe', folder, [chromium], async () => {})).toEqual(
        []
      )
      await expect(readFile(join(folder, 'NativeMessagingHosts', 'chrome.json'))).rejects.toThrow()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
