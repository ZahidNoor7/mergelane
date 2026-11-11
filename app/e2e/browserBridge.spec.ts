import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID } from '../src/shared/browserBridge'
import { expect, test } from './fixtures'

// The app's end of the browser bridge (docs/BROWSER-BRIDGE.md): the Unix socket the native host
// relays to. Driven here directly, as mergelane-nmhost would.
const OURS = `chrome-extension://${CHROME_EXTENSION_ID}/`
const dir = mkdtempSync('/tmp/mlbr-')
const SOCKET = join(dir, 's')
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
test.use({ appEnv: { MERGELANE_E2E_BROWSER_SOCKET: SOCKET } })

function ask(line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: SOCKET })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('end', () => resolve(JSON.parse(data)))
    socket.on('error', reject)
    socket.write(`${line}\n`)
  })
}
const send = (origin: string, message: unknown): Promise<Record<string, unknown>> =>
  ask(JSON.stringify({ v: 3, origin, message }))

test.describe('browser bridge socket @smoke', () => {
  test.describe.configure({ mode: 'serial' })

  test('only this user can open it, and anyone of this user may ask for health', async ({
    mergelane
  }) => {
    void mergelane
    await expect.poll(() => send('', { type: 'health' }).then((r) => r.ready)).toBe(true)
    expect(statSync(SOCKET).mode & 0o777).toBe(0o600)
    expect(await send('', { type: 'health' })).toMatchObject({ ok: true, app: 'mergelane' })
  })

  test('only our extensions are let in', async ({ mergelane }) => {
    void mergelane
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    expect(await send(OURS, { type: 'ping' })).toMatchObject({ ok: true, app: 'mergelane', api: 3 })
    expect(await send(FIREFOX_EXTENSION_ID, { type: 'wake' })).toMatchObject({ ok: true, api: 3 })
    expect(
      await send('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', { type: 'ping' })
    ).toEqual({ ok: false, error: 'forbidden' })
    expect(await send('', { type: 'ping' })).toEqual({ ok: false, error: 'forbidden' })
  })

  test('malformed and unknown requests are refused', async ({ mergelane }) => {
    void mergelane
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    expect(await ask('not json')).toEqual({ ok: false, error: 'bad-message' })
    expect(await ask('[]')).toEqual({ ok: false, error: 'bad-message' })
    expect(await ask(JSON.stringify({ v: 1, origin: OURS, message: { type: 'ping' } }))).toEqual({
      ok: false,
      error: 'unsupported'
    })
    expect(await ask(JSON.stringify({ v: 3, origin: OURS, message: 'ping' }))).toEqual({
      ok: false,
      error: 'bad-message'
    })
    expect(await send(OURS, { type: 'reboot' })).toEqual({ ok: false, error: 'unsupported' })
    expect(await send(OURS, { type: 'add', request: { url: 'file:///etc/passwd' } })).toEqual({
      ok: false,
      error: 'bad-message'
    })
    expect(await send(OURS, { type: 'confirm', token: 'nope' })).toEqual({ ok: false })
  })

  test('a download is offered, confirmed, and opens New download filled in', async ({
    mergelane,
    serve
  }) => {
    // Over the default minimum of 1 MB (ADR-0039).
    const origin = await serve({ size: 2 * 1024 * 1024 })
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    const added = await send(OURS, { type: 'add', request: { url: origin.url() } })
    expect(added).toMatchObject({ ok: true })
    expect(typeof added.token).toBe('string')
    expect(await send(OURS, { type: 'confirm', token: added.token })).toEqual({ ok: true })
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(origin.url())
    // A test's window stays hidden and never takes the Mac's focus, even when a link comes in: keys
    // typed at the Mac meanwhile mustn't land in it (openLinks.ts bringForward).
    expect(
      await mergelane.evaluateMain(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return { visible: window.isVisible(), focused: window.isFocused() }
      }, null)
    ).toEqual({ visible: false, focused: false })
    // Shown, not started; and a token works only once.
    expect(await mergelane.current()).toBeNull()
    expect(await send(OURS, { type: 'confirm', token: added.token })).toEqual({ ok: false })
  })

  test('a download smaller than the minimum stays with the browser', async ({
    mergelane,
    serve
  }) => {
    void mergelane
    const origin = await serve({ size: 1000 })
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    expect(
      await send(OURS, { type: 'add', request: { url: origin.url(), minBytes: 5000 } })
    ).toEqual({ ok: false, kept: 'smaller than the minimum size' })
  })

  test('Settings › Browser extensions’ rules apply to every download, and reach the extension', async ({
    mergelane,
    serve
  }) => {
    const MB = 1024 * 1024
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    // The defaults: over 1 MB, of a picked type or an unknown one.
    expect((await send(OURS, { type: 'ping' })).rules).toEqual({ capture: true, videoButton: true })
    const small = await serve({ size: 100_000 })
    expect(await send(OURS, { type: 'add', request: { url: small.url() } })).toEqual({
      ok: false,
      kept: 'smaller than the minimum size'
    })
    const pdf = await serve({
      size: 2 * MB,
      contentDisposition: 'attachment; filename="report.pdf"'
    })
    expect(await send(OURS, { type: 'add', request: { url: pdf.url() } })).toEqual({
      ok: false,
      kept: 'a type Mergelane doesn’t take'
    })

    // Documents ticked and any size: both go.
    await mergelane.api.updateSettings({
      captureRules: { capture: true, minSize: 'any', types: ['doc'], videoButton: false }
    })
    expect(await send(OURS, { type: 'add', request: { url: pdf.url() } })).toMatchObject({
      ok: true
    })
    expect(await send(OURS, { type: 'add', request: { url: small.url() } })).toMatchObject({
      ok: true
    })
    expect((await send(OURS, { type: 'ping' })).rules).toEqual({
      capture: true,
      videoButton: false
    })

    // Off: everything stays with the browser, magnet links too.
    await mergelane.api.updateSettings({
      captureRules: { capture: false, minSize: 'any', types: ['doc'], videoButton: true }
    })
    expect(
      await send(OURS, { type: 'add', request: { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) } })
    ).toEqual({
      ok: false,
      kept: 'sending downloads to Mergelane is off'
    })
    expect((await send(OURS, { type: 'ping' })).rules).toMatchObject({ capture: false })
  })

  test('remembers which browser’s extension reached it, and its version', async ({
    mergelane,
    dirs
  }) => {
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const before = Date.now()
    const reply = await ask(
      JSON.stringify({
        v: 3,
        origin: OURS,
        browser: chrome,
        message: { type: 'ping', extension: '1.0.0' }
      })
    )
    expect(reply).toMatchObject({ ok: true })
    // An executable that isn't a browser Mergelane knows is ignored.
    await ask(
      JSON.stringify({ v: 3, origin: OURS, browser: '/usr/bin/curl', message: { type: 'ping' } })
    )
    await expect
      .poll(async () => {
        const { readFile } = await import('node:fs/promises')
        return JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
          .browserContacts
      })
      .toEqual({ chrome: { at: expect.any(Number), extension: '1.0.0' } })
    const report = await mergelane.api.browsers()
    const contact = report.browsers.find((each) => each.id === 'chrome')!.contact
    expect(contact?.extension).toBe('1.0.0')
    expect(contact!.at).toBeGreaterThanOrEqual(before)
  })
})
