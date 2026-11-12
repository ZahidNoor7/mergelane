import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ERROR_CODES,
  isErrorResponse,
  isEventsResult,
  isRequest,
  isResponse,
  isResultOf,
  METHODS,
  type Method
} from '../../shared/daemon-api'
import { callDaemon, DaemonError } from '../src/main/daemon/client'
import {
  appleScriptString,
  installCommand,
  shellWord,
  uninstallCommand
} from '../src/main/daemon/installCommand'
import { adminFailure, removeHelper, simulatedAdminPrompt } from '../src/main/daemon/removal'
import {
  afterInstall,
  mergeIsOn,
  outagesFrom,
  readSnapshot,
  switchAutoResume,
  switchMerge,
  switchStickySites,
  versionMismatch,
  type SnapshotContext
} from '../src/main/daemon/snapshot'
import type { SystemMergeLinkEvent } from '../src/shared/types'
import { startFakeDaemon, type FakeDaemon } from './fakeDaemon'

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

  test('turns auto-resume on and off, and reads the link-change log', async () => {
    const fake = await startFakeDaemon()
    fake.events = [
      { at: '2026-11-10T09:00:00Z', link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' }
    ]
    try {
      const opts = { socketPath: fake.path }
      expect((await callDaemon('status', undefined, opts)).autoResume).toBe(false)
      expect((await callDaemon('setAutoResume', { enabled: true }, opts)).autoResume).toBe(true)
      expect(fake.autoResume).toBe(true)
      expect((await callDaemon('setAutoResume', { enabled: false }, opts)).autoResume).toBe(false)
      const events = await callDaemon('events', undefined, opts)
      expect(isEventsResult(events)).toBe(true)
      expect(events.events).toEqual(fake.events)
      expect(fake.requests[1]).toEqual({ method: 'setAutoResume', params: { enabled: true } })
      // The fake is as strict as the daemon about the one param.
      const bad = await callDaemon('setAutoResume', { enabled: 'yes' } as never, opts).catch(
        (e) => e
      )
      expect(bad.code).toBe('BAD_REQUEST')
      expect(fake.autoResume).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('a helper that speaks another protocol is UNSUPPORTED_VERSION', async () => {
    const fake = await startFakeDaemon()
    try {
      const opts = { socketPath: fake.path }
      fake.protocol = 2
      const envelope = await callDaemon('status', undefined, opts).catch((e) => e)
      expect(envelope).toBeInstanceOf(DaemonError)
      expect(envelope.code).toBe('UNSUPPORTED_VERSION')
      expect(envelope.message).toMatch(/protocol version 2; this app speaks 1/)

      // A v1 envelope around a status that says another protocol is the same mismatch.
      fake.protocol = undefined
      fake.rawReply =
        '{"v":1,"id":"","ok":true,"result":{"state":"off","version":"9","protocol":3}}'
      const status = await callDaemon('status', undefined, opts).catch((e) => e)
      expect(status.code).toBe('UNSUPPORTED_VERSION')
      expect(status.message).toMatch(/protocol version 3/)
    } finally {
      await fake.close()
    }
  })
})

/** A fake daemon and the context the snapshot reads it with: the app at version 'fake', the same
 * as the fake helper's, with the version check on as in a packaged app. */
async function withFake(
  run: (fake: FakeDaemon, context: SnapshotContext) => Promise<void>
): Promise<void> {
  const fake = await startFakeDaemon()
  try {
    await run(fake, {
      socketPath: fake.path,
      installed: true,
      appVersion: 'fake',
      compareVersions: true
    })
  } finally {
    await fake.close()
  }
}

const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 10, 9, minutes)).toISOString()

test.describe('system merge snapshot @smoke', () => {
  test('reads state, traffic, auto-resume and outages from a current helper', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      fake.autoResume = true
      fake.events = [
        { at: at(1), link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' },
        { at: at(2), link: 'en5', from: 'down', to: 'up', reason: 'probe-ok' }
      ]
      const snapshot = await readSnapshot(context)
      expect(snapshot).toMatchObject({
        installed: true,
        reachable: true,
        state: 'on',
        appVersion: 'fake',
        helperVersion: 'fake',
        helperOutdated: false,
        autoResume: true,
        events: fake.events,
        outages: [{ link: 'en5', kind: 'down', at: at(1), backAt: at(2), reason: 'probe-failed' }]
      })
      expect(snapshot.error).toBeUndefined()
      expect(snapshot.links).toEqual([
        { name: 'feth10', state: 'up', rxBps: 2_500_000, txBps: 100_000, activeFlows: 3 },
        { name: 'feth20', state: 'down', rxBps: 0, txBps: 0, activeFlows: 0 }
      ])
      expect((await readSnapshot(context, 'Earlier failure.')).error).toBe('Earlier failure.')
    })
  })

  test('a helper with another version is out of date, with both versions', async () => {
    await withFake(async (fake, context) => {
      fake.version = '0.0.9'
      expect(await readSnapshot({ ...context, appVersion: '0.1.0' })).toMatchObject({
        reachable: true,
        helperOutdated: true,
        helperVersion: '0.0.9',
        appVersion: '0.1.0'
      })
      // A development build compares nothing.
      const dev = await readSnapshot({ ...context, appVersion: '0.1.0', compareVersions: false })
      expect(dev.helperOutdated).toBe(false)
    })
  })

  test('a helper from before M2.4 is out of date and has no auto-resume', async () => {
    await withFake(async (fake, context) => {
      fake.legacy = true
      const snapshot = await readSnapshot({ ...context, compareVersions: false })
      expect(snapshot).toMatchObject({ reachable: true, helperOutdated: true, events: [] })
      expect(snapshot).not.toHaveProperty('autoResume')

      // Only the event log missing is enough.
      fake.legacy = false
      fake.unknownMethods = ['events']
      expect((await readSnapshot(context)).helperOutdated).toBe(true)
    })
  })

  test('a failing event log leaves the history empty, not the snapshot', async () => {
    await withFake(async (fake, context) => {
      fake.events = [{ at: at(1), link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' }]
      fake.refuse = { events: { code: 'INTERNAL', message: 'log unavailable' } }
      const snapshot = await readSnapshot(context)
      expect(snapshot).toMatchObject({
        reachable: true,
        helperOutdated: false,
        events: [],
        outages: []
      })
    })
  })

  test('a helper in another protocol is out of date and unreachable, without an error', async () => {
    await withFake(async (fake, context) => {
      fake.protocol = 2
      const snapshot = await readSnapshot(context)
      expect(snapshot).toMatchObject({
        reachable: false,
        state: 'off',
        helperOutdated: true,
        links: [],
        events: [],
        outages: []
      })
      expect(snapshot.error).toBeUndefined()

      // A status this app can't read is the same, and says what went wrong.
      fake.protocol = undefined
      fake.rawReply = '{"v":1,"id":"","ok":true,"result":{"state":"sideways"}}'
      const malformed = await readSnapshot(context)
      expect(malformed.helperOutdated).toBe(true)
      expect(malformed.error).toMatch(/malformed/)
    })
  })

  test('a missing helper is unreachable, not out of date; an error only once installed', async () => {
    const missing = {
      socketPath: '/tmp/mlfd-none',
      installed: false,
      appVersion: '0.1.0',
      compareVersions: true
    }
    // Not installed: the install prompt says it all, so no error.
    const notInstalled = await readSnapshot(missing)
    expect(notInstalled).toMatchObject({
      installed: false,
      reachable: false,
      helperOutdated: false
    })
    expect(notInstalled.error).toBeUndefined()
    // Installed but not answering is a problem worth an alert.
    expect((await readSnapshot({ ...missing, installed: true })).error).toMatch(/isn't running/)
    // A request that failed is always shown.
    expect((await readSnapshot(missing, 'Installation was canceled.')).error).toBe(
      'Installation was canceled.'
    )
  })

  test('switches merging on and off, and shows a refusal in the daemon’s words', async () => {
    await withFake(async (fake, context) => {
      expect((await switchMerge(context, true)).state).toBe('on')
      expect((await switchMerge(context, false)).state).toBe('off')
      fake.refuseEnable = { code: 'VPN_ACTIVE', message: 'Another VPN (utun4) is on.' }
      const refused = await switchMerge(context, true)
      expect(refused).toMatchObject({ state: 'off', error: 'Another VPN (utun4) is on.' })
    })
  })

  test('switches auto-resume, and reports a helper without it as out of date', async () => {
    await withFake(async (fake, context) => {
      expect((await switchAutoResume(context, true)).autoResume).toBe(true)
      expect(fake.autoResume).toBe(true)
      expect((await switchAutoResume(context, false)).autoResume).toBe(false)

      // Anything but a boolean is refused before it's sent.
      const sent = fake.requests.length
      const notBoolean = await switchAutoResume(context, 'yes' as unknown as boolean)
      expect(notBoolean.error).toBe('That setting needs on or off.')
      expect(fake.requests.slice(sent).some((r) => r.method === 'setAutoResume')).toBe(false)

      fake.refuse = { setAutoResume: { code: 'NOT_ROOT', message: 'The helper is not root.' } }
      expect((await switchAutoResume(context, true)).error).toBe('The helper is not root.')

      // Its status still claims the setting, but the method is missing: believe the method.
      fake.refuse = undefined
      fake.unknownMethods = ['setAutoResume']
      const old = await switchAutoResume(context, true)
      expect(old).toMatchObject({ reachable: true, helperOutdated: true })
      expect(old).not.toHaveProperty('autoResume')
      expect(old.error).toMatch(/Update it first/)
      expect(fake.autoResume).toBe(false)
    })
  })

  test('switches sticky sites, and reports a helper without them as out of date', async () => {
    await withFake(async (fake, context) => {
      expect((await readSnapshot(context)).stickySites).toBe(true)
      expect((await switchStickySites(context, false)).stickySites).toBe(false)
      expect(fake.stickySites).toBe(false)
      expect((await switchStickySites(context, true)).stickySites).toBe(true)

      const sent = fake.requests.length
      const notBoolean = await switchStickySites(context, 'yes' as unknown as boolean)
      expect(notBoolean.error).toBe('That setting needs on or off.')
      expect(fake.requests.slice(sent).some((r) => r.method === 'setStickySites')).toBe(false)

      fake.refuse = { setStickySites: { code: 'INTERNAL', message: 'saving failed' } }
      expect((await switchStickySites(context, false)).error).toBe('saving failed')

      fake.refuse = undefined
      fake.unknownMethods = ['setStickySites']
      const old = await switchStickySites(context, false)
      expect(old).toMatchObject({ reachable: true, helperOutdated: true })
      expect(old).not.toHaveProperty('stickySites')
      expect(old.error).toMatch(/can't keep a site on one network\. Update it first/)
      expect(fake.stickySites).toBe(true)

      // A helper whose status has no stickySites predates it: out of date, without the setting.
      fake.unknownMethods = undefined
      fake.legacy = true
      const legacy = await readSnapshot(context)
      expect(legacy).toMatchObject({ helperOutdated: true })
      expect(legacy).not.toHaveProperty('stickySites')
    })
  })

  test('after an update, merging that was on comes back on once the new helper answers', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      expect(await mergeIsOn(context)).toBe(true)
      // The update stops the old helper cleanly: the new one starts off and doesn't auto-resume.
      fake.state = 'off'
      expect(await mergeIsOn(context)).toBe(false)
      const resumed = await afterInstall(context, true, { everyMs: 50 })
      expect(resumed).toMatchObject({ reachable: true, state: 'on' })
      expect(resumed.error).toBeUndefined()
      expect(fake.requests.filter((r) => r.method === 'enable')).toHaveLength(1)

      // Already on (or off before the update): nothing to turn on.
      await afterInstall(context, true, { everyMs: 50 })
      fake.state = 'off'
      expect((await afterInstall(context, false, { everyMs: 50 })).state).toBe('off')
      expect(fake.requests.filter((r) => r.method === 'enable')).toHaveLength(1)

      // A refusal says why it stayed off.
      fake.refuseEnable = { code: 'VPN_ACTIVE', message: 'Another VPN (utun4) is on.' }
      const refused = await afterInstall(context, true, { everyMs: 50 })
      expect(refused.state).toBe('off')
      expect(refused.error).toBe(
        "The helper is updated, but system merge didn't turn back on: Another VPN (utun4) is on."
      )
    })
  })

  test('after an update, it waits for the new helper, but not forever', async () => {
    await withFake(async (fake, context) => {
      // Still starting: connections are accepted but not answered for a moment.
      fake.silent = true
      setTimeout(() => (fake.silent = false), 300)
      const resumed = await afterInstall(context, true, { everyMs: 50 })
      expect(resumed.state).toBe('on')
    })
    expect(
      await mergeIsOn({
        socketPath: '/tmp/mlfd-none',
        installed: true,
        appVersion: '0.1.0',
        compareVersions: false
      })
    ).toBe(false)
    const never = await afterInstall(
      {
        socketPath: '/tmp/mlfd-none',
        installed: true,
        appVersion: '0.1.0',
        compareVersions: false
      },
      true,
      { waitMs: 200, everyMs: 50 }
    )
    expect(never).toMatchObject({ reachable: false, state: 'off' })
    expect(never.error).toMatch(/isn't running/)
  })

  test('outages pair each drop with its recovery, per link', () => {
    const events: SystemMergeLinkEvent[] = [
      // Out of order on purpose: the log is sorted by time first.
      { at: at(9), link: 'en5', from: 'gone', to: 'up', reason: 'returned' },
      { at: at(1), link: 'en0', from: 'unknown', to: 'up', reason: 'probe-ok' },
      { at: at(2), link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' },
      { at: at(3), link: 'en0', from: 'up', to: 'gone', reason: 'lost' },
      { at: at(4), link: 'en5', from: 'down', to: 'gone', reason: 'lost' },
      { at: at(5), link: 'en0', from: 'gone', to: 'unknown', reason: 'returned' },
      { at: at(6), link: 'en0', from: 'unknown', to: 'up', reason: 'probe-ok' },
      { at: at(7), link: 'en7', from: 'up', to: 'down', reason: 'probe-failed' }
    ]
    expect(outagesFrom(events)).toEqual([
      { link: 'en5', kind: 'gone', at: at(2), backAt: at(9), reason: 'probe-failed' },
      { link: 'en0', kind: 'gone', at: at(3), backAt: at(6), reason: 'lost' },
      { link: 'en7', kind: 'down', at: at(7), reason: 'probe-failed' }
    ])
    expect(outagesFrom([])).toEqual([])
    // A link that comes up after a probe, with no drop before it, is not an outage.
    expect(
      outagesFrom([{ at: at(1), link: 'en0', from: 'unknown', to: 'up', reason: 'probe-ok' }])
    ).toEqual([])
  })

  test('version check skips development builds on either side', () => {
    const context = { installed: true, appVersion: '0.2.0', compareVersions: true }
    expect(versionMismatch(context, '0.1.0')).toBe(true)
    expect(versionMismatch(context, '0.2.0')).toBe(false)
    expect(versionMismatch(context, 'dev')).toBe(false)
    expect(versionMismatch({ ...context, appVersion: 'dev' }, '0.1.0')).toBe(false)
    expect(versionMismatch({ ...context, compareVersions: false }, '0.1.0')).toBe(false)
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

// "Remove helper" (ADR-0046). Nothing here asks for a password or touches /Library: the prompt is
// a stand-in that records the script, and the daemon is the fake.
const TRICKY = `/Applications/My "Apps"/Merge'lane.app/Contents/Resources/mergelane-daemon`

test.describe('helper removal @smoke', () => {
  test('the uninstall command is the bundled binary’s uninstall, quoted for the shell and for AppleScript', () => {
    expect(uninstallCommand(TRICKY)).toBe(
      "do shell script \"'/Applications/My \\\"Apps\\\"/Merge'\\\\''lane.app/Contents/Resources/mergelane-daemon' uninstall\" with administrator privileges"
    )
    expect(
      uninstallCommand('/Applications/Mergelane.app/Contents/Resources/mergelane-daemon')
    ).toBe(
      `do shell script "'/Applications/Mergelane.app/Contents/Resources/mergelane-daemon' uninstall" with administrator privileges`
    )
  })

  test('AppleScript and /bin/sh read the command back as exactly two words', () => {
    const shell = `${shellWord(TRICKY)} uninstall`
    // AppleScript decodes its string literal back to the shell line (a plain `return`: no
    // privileges, nothing run)…
    const decoded = execFileSync(
      '/usr/bin/osascript',
      ['-e', `return ${appleScriptString(shell)}`],
      {
        encoding: 'utf8'
      }
    ).replace(/\n$/, '')
    expect(decoded).toBe(shell)
    // …and the shell splits that line into the binary's path and `uninstall` (printed, not run).
    const words = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${decoded}`], { encoding: 'utf8' })
    expect(words.split('\n').slice(0, -1)).toEqual([TRICKY, 'uninstall'])
  })

  test('reads osascript’s failures: a dismissed prompt, a reason, or nothing', async () => {
    const cancel = await simulatedAdminPrompt('cancel').catch((caught: unknown) => caught)
    expect(adminFailure(cancel)).toEqual({ canceled: true, reason: 'User canceled.' })
    const failed = await simulatedAdminPrompt('fail:error: launchd: launchctl bootout: busy').catch(
      (caught: unknown) => caught
    )
    expect(adminFailure(failed)).toEqual({
      canceled: false,
      reason: 'error: launchd: launchctl bootout: busy'
    })
    await expect(simulatedAdminPrompt('allow')).resolves.toBeUndefined()
    const bare = await simulatedAdminPrompt('fail:').catch((caught: unknown) => caught)
    expect(adminFailure(bare).reason).toBe('failed')
    // Without stderr, the error's own message; without either, a fallback.
    expect(adminFailure(new Error('spawn osascript ENOENT'))).toEqual({
      canceled: false,
      reason: 'spawn osascript ENOENT'
    })
    expect(adminFailure(Object.assign(new Error('x'), { stderr: '  ' })).reason).toBe('x')
    expect(adminFailure('').reason).toBe('osascript failed without saying why.')
    expect(adminFailure(null).canceled).toBe(false)
    // A multi-line reason becomes one line.
    expect(adminFailure({ stderr: '1:2: execution error: a\nb (1)' }).reason).toBe('a b')
  })

  test('turns merging off before the prompt, then reads the helper again', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      const scripts: string[] = []
      let stateAtPrompt = ''
      let installed = true
      const removal = await removeHelper(
        () => ({ ...context, installed }),
        TRICKY,
        async (script) => {
          scripts.push(script)
          stateAtPrompt = fake.state
          installed = false
        }
      )
      expect(scripts).toEqual([uninstallCommand(TRICKY)])
      expect(stateAtPrompt).toBe('off')
      expect(fake.requests.map((r) => r.method)).toContain('disable')
      expect(removal.outcome).toBe('removed')
      expect(removal.message).toBe('Helper removed. Install it again to use system merge.')
      expect(removal.snapshot.installed).toBe(false)
    })
  })

  test('a dismissed prompt removes nothing and turns merging back on', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      const removal = await removeHelper(
        () => context,
        TRICKY,
        () => simulatedAdminPrompt('cancel')
      )
      expect(removal.outcome).toBe('canceled')
      expect(removal.message).toBe('Removal canceled. The helper is still installed.')
      expect(
        fake.requests.map((r) => r.method).filter((m) => m === 'disable' || m === 'enable')
      ).toEqual(['disable', 'enable'])
      expect(removal.snapshot.state).toBe('on')

      // Turning it back on can be refused; that is said too.
      fake.refuseEnable = { code: 'VPN_ACTIVE', message: 'Another VPN (utun4) is on.' }
      const refused = await removeHelper(
        () => context,
        TRICKY,
        () => simulatedAdminPrompt('cancel')
      )
      expect(refused.message).toBe(
        'Removal canceled. The helper is still installed. System merge stayed off: Another VPN (utun4) is on.'
      )
      expect(refused.snapshot.state).toBe('off')

      // Merging that was off stays off.
      fake.refuseEnable = undefined
      const sent = fake.requests.length
      await removeHelper(
        () => context,
        TRICKY,
        () => simulatedAdminPrompt('cancel')
      )
      expect(fake.requests.slice(sent).some((r) => r.method === 'enable')).toBe(false)
    })
  })

  test('a failed removal says why, and leaves merging off', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      const removal = await removeHelper(
        () => context,
        TRICKY,
        () => simulatedAdminPrompt('fail:error: must run as root')
      )
      expect(removal).toMatchObject({
        outcome: 'failed',
        message: "Couldn't remove the helper: error: must run as root"
      })
      expect(fake.state).toBe('off')
      expect(fake.requests.some((r) => r.method === 'enable')).toBe(false)
    })
  })

  test('a helper that won’t turn off, or doesn’t answer, is removed anyway', async () => {
    await withFake(async (fake, context) => {
      fake.state = 'on'
      fake.refuse = { disable: { code: 'INTERNAL', message: 'stuck' } }
      const scripts: string[] = []
      const stuck = await removeHelper(
        () => context,
        TRICKY,
        async (script) => {
          scripts.push(script)
        }
      )
      expect(stuck.outcome).toBe('removed')
      expect(scripts).toHaveLength(1)
    })
    const gone = {
      socketPath: '/tmp/mlfd-none',
      installed: true,
      appVersion: 'x',
      compareVersions: false
    }
    const scripts: string[] = []
    const removal = await removeHelper(
      () => gone,
      TRICKY,
      async (script) => {
        scripts.push(script)
      }
    )
    expect(removal.outcome).toBe('removed')
    expect(scripts).toEqual([uninstallCommand(TRICKY)])
  })
})
