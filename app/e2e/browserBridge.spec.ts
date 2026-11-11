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
  ask(JSON.stringify({ v: 2, origin, message }))

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
    expect(await send(OURS, { type: 'ping' })).toMatchObject({ ok: true, app: 'mergelane', api: 2 })
    expect(await send(FIREFOX_EXTENSION_ID, { type: 'wake' })).toMatchObject({ ok: true, api: 2 })
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
    expect(await ask(JSON.stringify({ v: 2, origin: OURS, message: 'ping' }))).toEqual({
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
    const origin = await serve({ size: 64 * 1024 })
    await expect.poll(() => send(OURS, { type: 'ping' }).then((r) => r.ok)).toBe(true)
    const added = await send(OURS, { type: 'add', request: { url: origin.url() } })
    expect(added).toMatchObject({ ok: true })
    expect(typeof added.token).toBe('string')
    expect(await send(OURS, { type: 'confirm', token: added.token })).toEqual({ ok: true })
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(origin.url())
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
})
