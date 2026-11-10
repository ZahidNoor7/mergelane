import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ERROR_CODES,
  isErrorResponse,
  isRequest,
  isResponse,
  isResultOf,
  METHODS,
  type Method
} from '../../shared/daemon-api'
import { callDaemon, DaemonError } from '../src/main/daemon/client'
import { appleScriptString, installCommand, shellWord } from '../src/main/daemon/installCommand'
import { startFakeDaemon } from './fakeDaemon'

// The app's side of the daemon contract (CLAUDE.md: shared/daemon-api.ts, tested from both
// sides). The Go side round-trips the same fixtures in daemon/internal/api.
const FIXTURES = join(__dirname, '..', '..', 'shared', 'fixtures', 'daemon-api')
const fixtures = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, value: JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) }))

test.describe('daemon API contract @smoke', () => {
  test('every request fixture is a valid request', () => {
    const requests = fixtures.filter((f) => f.name.endsWith('.request.json'))
    expect(requests.length).toBeGreaterThan(0)
    for (const { name, value } of requests) expect(isRequest(value), name).toBe(true)
  })

  test('every response fixture is valid, and ok results match their method', () => {
    for (const { name, value } of fixtures.filter((f) => f.name.endsWith('.response.json'))) {
      expect(isResponse(value), name).toBe(true)
      const method = name.split('.')[0] as Method
      if (value.ok) expect(isResultOf(method, value.result), name).toBe(true)
    }
  })

  test('every method and error code has a fixture', () => {
    for (const method of METHODS) {
      expect(
        fixtures.some((f) => f.name.startsWith(`${method}.`)),
        method
      ).toBe(true)
    }
    const codes = fixtures.filter((f) => isErrorResponse(f.value)).map((f) => f.value.error.code)
    for (const code of ERROR_CODES) expect(codes, code).toContain(code)
  })

  test('guards reject malformed messages', () => {
    expect(isRequest({ v: 1, id: 'x', method: 'reboot' })).toBe(false)
    expect(isRequest({ v: 1, id: 'x', method: 'setLimit', params: { link: 'en0' } })).toBe(false)
    expect(isResponse({ v: 1, id: 'x', ok: false, error: { code: 'NOPE', message: '' } })).toBe(
      false
    )
    expect(isResultOf('status', { state: 'sideways', version: '1', protocol: 1 })).toBe(false)
  })
})

test.describe('daemon client @smoke', () => {
  test('calls methods and returns typed results', async () => {
    const fake = await startFakeDaemon()
    try {
      const opts = { socketPath: fake.path }
      expect((await callDaemon('status', undefined, opts)).state).toBe('off')
      expect((await callDaemon('enable', undefined, opts)).state).toBe('on')
      expect((await callDaemon('links', undefined, opts)).links).toHaveLength(2)
      expect((await callDaemon('stats', undefined, opts)).links[0]?.activeFlows).toBe(3)
      expect((await callDaemon('disable', { reason: 'test' }, opts)).state).toBe('off')
      expect(fake.requests.map((r) => r.method)).toEqual([
        'status',
        'enable',
        'links',
        'stats',
        'disable'
      ])
      expect(fake.requests[4]?.params).toEqual({ reason: 'test' })
    } finally {
      await fake.close()
    }
  })

  test('maps a refusal to a DaemonError with its code and message', async () => {
    const fake = await startFakeDaemon()
    fake.refuseEnable = { code: 'VPN_ACTIVE', message: 'Another VPN (utun4) is on.' }
    try {
      const error = await callDaemon('enable', undefined, { socketPath: fake.path }).catch((e) => e)
      expect(error).toBeInstanceOf(DaemonError)
      expect(error.code).toBe('VPN_ACTIVE')
      expect(error.message).toBe('Another VPN (utun4) is on.')
    } finally {
      await fake.close()
    }
  })

  test('reports a missing helper, a silent one and protocol violations', async () => {
    const missing = await callDaemon('status', undefined, { socketPath: '/tmp/mlfd-none' }).catch(
      (e) => e
    )
    expect(missing.code).toBe('UNAVAILABLE')
    expect(missing.message).toMatch(/isn't running/)

    const fake = await startFakeDaemon()
    try {
      const opts = { socketPath: fake.path, timeoutMs: 300 }
      fake.silent = true
      expect((await callDaemon('status', undefined, opts).catch((e) => e)).message).toMatch(
        /did not answer in time/
      )
      fake.silent = false
      for (const [raw, pattern] of [
        ['not json', /not JSON/],
        ['{"v":1,"id":"x"}', /does not understand/],
        ['{"v":1,"id":"","ok":true,"result":{"state":"sideways"}}', /malformed/]
      ] as const) {
        fake.rawReply = raw
        expect((await callDaemon('status', undefined, opts).catch((e) => e)).message).toMatch(
          pattern
        )
      }
      fake.rawReply = 'x'.repeat(300_000)
      expect((await callDaemon('status', undefined, opts).catch((e) => e)).message).toMatch(
        /oversized/
      )
    } finally {
      await fake.close()
    }
  })
})

test.describe('helper install command @smoke', () => {
  test('quotes the binary path for the shell and for AppleScript', () => {
    const command = installCommand(`/Applications/My "Apps"/Merge'lane.app/x\\y`, 501)
    expect(command).toBe(
      "do shell script \"'/Applications/My \\\"Apps\\\"/Merge'\\\\''lane.app/x\\\\y' install --uid 501 --source '/Applications/My \\\"Apps\\\"/Merge'\\\\''lane.app/x\\\\y'\" with administrator privileges"
    )
    expect(shellWord("a'b")).toBe(`'a'\\''b'`)
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})
