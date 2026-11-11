import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID, NATIVE_HOST } from '../src/shared/browserBridge'
import { browsers, hostManifest, registerNativeHost } from '../src/main/nativeHost'

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
      const [chrome, , chromium, mozilla] = browsers(home)
      await mkdir(chrome!.dir, { recursive: true })
      await mkdir(mozilla!.dir, { recursive: true })
      const written = await registerNativeHost('/bin/host', home)
      expect(written).toEqual([
        join(chrome!.dir, 'NativeMessagingHosts', `${NATIVE_HOST}.json`),
        join(mozilla!.dir, 'NativeMessagingHosts', `${NATIVE_HOST}.json`)
      ])
      expect(JSON.parse(await readFile(written[0]!, 'utf8')).allowed_origins).toBeDefined()
      expect(JSON.parse(await readFile(written[1]!, 'utf8')).allowed_extensions).toBeDefined()
      expect(chromium!.dir.endsWith('Chromium')).toBe(true)
      // Written again on every start: the same files, overwritten.
      expect(await registerNativeHost('/bin/other', home)).toHaveLength(2)
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
