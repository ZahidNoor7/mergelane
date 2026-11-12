// Tests for the real-hardware suite, without the hardware: a stand-in Mac whose helper, commands, downloads and
// owner are scripted. Run: node --test --experimental-test-coverage
// --test-coverage-include='scripts/hardware/hardware.mjs' scripts/hardware/hardware.test.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import {
  CHUNK,
  FAILOVER_MBPS,
  FILES,
  HELPER,
  LABEL,
  TEST_MBPS,
  bytesByLink,
  callHelper,
  captureRoutes,
  dataEstimateMB,
  hardwarePorts,
  describeShares,
  download,
  linkLabel,
  linksUsed,
  main,
  realMac,
  renderReport,
  restoreCommands,
  run,
  runSuite,
  shares,
  stopped,
  unplugSteps,
  until,
  writeReport
} from './hardware.mjs'

const NETSTAT_OFF = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.1.1        UGScg                 en0
192.168.1          link#11            UCS                   en0      !
`
const NETSTAT_ON = `${NETSTAT_OFF}0/1                198.18.0.1         UGSc2               utun4
128.0/1            198.18.0.1         UGSc2               utun4
`
const NETSTAT_VPN = `${NETSTAT_OFF}0/1                10.8.0.1           UGSc                utun5
128.0/1            10.8.0.1           UGSc                utun5
`

/**
 * A stand-in Mac. `answers` are what the owner types, in order; `world` sets how the helper behaves. Every
 * helper call is kept in `calls`.
 */
function fakeMac(answers = [], world = {}) {
  let clock = Date.UTC(2026, 10, 12, 12, 0, 0)
  const w = {
    version: '0.3.2',
    app: '0.3.2',
    state: 'off',
    sticky: true,
    hasSticky: true,
    links: [
      { name: 'en0', kind: 'Ethernet', up: true, state: 'up', index: 4 },
      { name: 'en1', kind: 'Wi-Fi', up: true, state: 'up', index: 11, limitMbps: 50 },
      { name: 'en7', kind: 'iPhone USB', up: true, state: 'up', index: 20 }
    ],
    unplugged: new Set(),
    stickyWorks: true,
    netstat: null,
    inFlight: [],
    ...world
  }
  const tick = () => new Promise((r) => setImmediate(r))
  const calls = []
  const said = []
  const queue = [...answers]
  let crashed = false
  /** The owner's `sudo kill -9` in another window: launchd starts a new helper, off unless it resumes. */
  w.crash = () => {
    crashed = true
    if (!w.autoResumeAfterCrash) w.state = 'off'
  }
  const status = () => ({
    state: w.state,
    version: w.version,
    protocol: 1,
    autoResume: false,
    ...(w.reason ? { reason: w.reason } : {}),
    ...(w.hasSticky ? { stickySites: w.sticky } : {})
  })
  const visible = () => w.links.filter((l) => !w.unplugged.has(l.name))
  const mac = {
    calls,
    said,
    world: w,
    async helper(method, params) {
      calls.push(params === undefined ? method : `${method} ${JSON.stringify(params)}`)
      if (w.unreachable) throw new Error('connect ENOENT /var/run/mergelane/daemon.sock')
      if (w.fail?.[method])
        throw Object.assign(new Error(w.fail[method].message), { code: w.fail[method].code })
      switch (method) {
        case 'status':
          return status()
        case 'links':
          return { links: visible() }
        case 'enable':
          if (w.vpnOn) throw Object.assign(new Error('Another VPN is on.'), { code: 'VPN_ACTIVE' })
          if (!w.neverOn) w.state = 'on'
          return status()
        case 'disable':
          w.state = 'off'
          return status()
        case 'setStickySites':
          w.sticky = params.enabled
          return status()
        case 'setLimit':
          return params
        case 'stats': {
          // Each site in flight takes one link while sticky works; otherwise everything spreads.
          const up = visible().filter((l) => l.up)
          const sites = new Set(w.inFlight).size
          const spread = !w.sticky || !w.stickyWorks
          return {
            at: '2026-11-12T12:00:00Z',
            links: up.map((l, i) => ({
              name: l.name,
              rxBps: sites > 0 && (spread || i < sites) ? 1e6 : 0,
              txBps: 0,
              linkRxBps: 0,
              linkTxBps: 0,
              activeFlows: 1,
              totalFlows: 1,
              weight: 1,
              failed: 0
            }))
          }
        }
      }
      throw new Error(`unexpected ${method}`)
    },
    ran: [],
    async run(command, args = []) {
      mac.ran.push(command)
      const out = (stdout, code = 0) => ({ code, stdout, stderr: '' })
      switch (command) {
        case 'sw_vers':
          return out('27.0\n')
        case 'uname':
          return out('arm64\n')
        case 'defaults':
          return w.app ? out(`${w.app}\n`) : out('', 1)
        case 'netstat':
          return out(
            w.netstat ?? (w.vpnOn ? NETSTAT_VPN : w.state === 'on' ? NETSTAT_ON : NETSTAT_OFF)
          )
        case 'networksetup':
          return out(
            'Hardware Port: Wi-Fi\nDevice: en1\nEthernet Address: aa\n\nHardware Port: iPhone USB\nDevice: en7\nEthernet Address: bb\n\nHardware Port: Ethernet\nDevice: en0\n'
          )
        case 'scutil':
          return out(w.vpnOn ? '* (Connected) 1234 VPN (com.example) "Work"\n' : '')
        case 'pgrep':
          return out(w.noPid ? '' : crashed ? '222\n' : '111\n')
      }
      return out('', 1)
    },
    async download(file) {
      w.inFlight.push(file.site)
      await tick()
      await tick()
      w.inFlight.splice(w.inFlight.indexOf(file.site), 1)
      // The internet check can be made to fail a few times first, as right after a network goes.
      if (file === FILES.probe && w.probeFailures > 0) {
        w.probeFailures -= 1
        return { ok: false, bytes: 0, ms: 10, error: 'curl: (6) Could not resolve host' }
      }
      return {
        ok: !w.offline,
        bytes: CHUNK,
        ms: 10,
        ...(w.offline ? { error: 'curl: (7) Failed to connect' } : {})
      }
    },
    say: (text) => said.push(text),
    async ask(question) {
      said.push(question)
      const answer = queue.shift() ?? ''
      if (typeof answer === 'function') return answer(w, mac)
      if (answer === '^C') throw stopped()
      return answer
    },
    wait: async (ms) => {
      clock += ms
      await tick()
    },
    now: () => clock,
    aborted: () => false,
    interrupt: () => {},
    close: () => {}
  }
  return mac
}

/** The owner's answers for a full run that tests everything once, and unplugs every link. */
function everything(world) {
  const answers = ['y', 'y'] // start, Mergelane's own download showed every network
  for (const link of world?.links ?? fakeMac().world.links) {
    answers.push(
      '', // test unplugging it: yes
      (w) => (w.unplugged.add(link.name), ''),
      (w) => (w.unplugged.delete(link.name), '')
    )
  }
  answers.push(
    'y',
    '',
    'y',
    (w) => ((w.vpnOn = true), (w.state = 'off'), (w.reason = 'Another VPN (utun5) is on.'), ''),
    (w) => ((w.vpnOn = false), ''),
    'y',
    (w) => (w.crash(), '')
  )
  return answers
}

const statuses = (results) => Object.fromEntries(results.map((r) => [r.name, r.status]))

describe('the pure parts', () => {
  it('turns stats samples into bytes, shares and the links used', () => {
    const samples = [
      {
        links: [
          { name: 'en0', rxBps: 1000, txBps: 1000 },
          { name: 'en7', rxBps: 500, txBps: 0 }
        ]
      },
      { links: [{ name: 'en0', rxBps: 2000, txBps: 0 }] }
    ]
    const bytes = bytesByLink(samples, 500)
    assert.deepEqual(bytes, { en0: 2000, en7: 250 })
    assert.deepEqual(
      shares(bytes).map((s) => s.name),
      ['en0', 'en7']
    )
    assert.deepEqual(linksUsed(bytes), ['en0', 'en7'])
    assert.deepEqual(linksUsed(bytes, 0.2), ['en0'])
    assert.equal(describeShares(bytes), 'en0 89%, en7 11%')
    assert.equal(describeShares({}), 'no traffic')
    assert.deepEqual(shares({ en0: 0 }), [{ name: 'en0', share: 0 }])
  })

  it('reads the capture routes and other VPNs from the routing table', () => {
    assert.deepEqual(captureRoutes(NETSTAT_ON), { count: 2, once: true })
    assert.deepEqual(captureRoutes(NETSTAT_OFF), { count: 0, once: false })
    assert.deepEqual(
      captureRoutes(
        `${NETSTAT_ON}0/1                198.18.0.1         UGSc2               utun6\n`
      ),
      {
        count: 3,
        once: false
      }
    )
  })

  it('says how much data a run uses, and how to put the limits back', () => {
    assert.equal(dataEstimateMB(0), Math.round((23 * CHUNK) / 1e6))
    assert.equal(dataEstimateMB(3), Math.round(((23 + 3 * 6) * CHUNK) / 1e6))
    assert.equal(dataEstimateMB(2, false), Math.round((2 * 6 * CHUNK) / 1e6))
    assert.equal(
      restoreCommands([{ name: 'en0' }, { name: 'en1', limitMbps: 50 }]),
      `${HELPER} limit en0 0 ; ${HELPER} limit en1 50`
    )
    assert.equal(linkLabel({ name: 'en7', kind: 'iPhone USB' }), 'iPhone USB (en7)')
    assert.equal(linkLabel({ name: 'en9' }), 'en9')
    assert.equal(HELPER, `/Library/PrivilegedHelperTools/${LABEL}`)
    assert.equal(FILES.hetznerAsh.site, FILES.hetznerNbg.site)
  })

  it('names each network by its hardware port, and says how to take it away', () => {
    const ports = hardwarePorts(
      'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: x\n\nHardware Port: iPhone USB\nDevice: en7\n\nHardware Port: Bluetooth PAN\nDevice: en9\n\nDevice: en99\n'
    )
    assert.deepEqual(ports, { en0: 'Wi-Fi', en7: 'iPhone USB', en9: 'Bluetooth PAN' })
    assert.match(unplugSteps({ name: 'en0', kind: 'Wi-Fi' }).off, /Turn Wi-Fi off/)
    assert.match(unplugSteps({ name: 'en0', kind: 'Wi-Fi' }).on, /Turn Wi-Fi back on/)
    assert.equal(
      unplugSteps({ name: 'en7', kind: 'iPhone USB' }).off,
      'Unplug the iPhone USB cable'
    )
    assert.match(unplugSteps({ name: 'en8', kind: 'Android' }).on, /hotspot on/)
    assert.equal(
      unplugSteps({ name: 'en5', kind: 'Thunderbolt Ethernet Slot 1' }).on,
      'Plug the Thunderbolt Ethernet Slot 1 cable back in'
    )
    assert.equal(
      unplugSteps({ name: 'en9', kind: 'Bluetooth PAN' }).off,
      'Disconnect Bluetooth PAN (en9)'
    )
    assert.equal(unplugSteps({ name: 'en9' }).on, 'Reconnect en9')
  })

  it('renders the report', () => {
    const facts = {
      when: 'now',
      mac: 'macOS 27.0 on arm64',
      app: '0.3.2',
      helper: '0.3.2',
      links: ['Wi-Fi (en1)'],
      dataMB: 10
    }
    const passed = renderReport([{ name: 'A', status: 'PASS', seconds: 3, note: 'a | b' }], facts)
    assert.match(passed, /\| A \| PASS \| 3 \| a \/ b \|/)
    assert.match(passed, /Every check that ran passed/)
    const failed = renderReport(
      [
        { name: 'B', status: 'FAIL' },
        { name: 'C', status: 'SKIP' }
      ],
      { when: 'now', mac: '' }
    )
    assert.match(failed, /1 check\(s\) failed/)
    assert.match(failed, /Mergelane not found, helper not reachable/)
    assert.match(failed, /Networks: none found/)
    assert.match(failed, /\| C \| skip \|/)
  })

  it('waits until a check holds, and gives up', async () => {
    const mac = fakeMac()
    let n = 0
    assert.equal(await until(mac, async () => ++n >= 3 && 'done', 10_000), 'done')
    assert.equal(await until(mac, async () => false, 3000), false)
    assert.equal(
      await until(
        mac,
        async () => {
          throw new Error('x')
        },
        1000
      ),
      undefined
    )
    mac.aborted = () => true
    await assert.rejects(
      until(mac, async () => true, 1000),
      { name: 'AbortError' }
    )
  })
})

describe('the suite', () => {
  it('runs every check and puts everything back', async () => {
    const mac = fakeMac(everything())
    const { results, facts } = await runSuite(mac)
    const failed = results.filter((r) => r.status === 'FAIL')
    assert.deepEqual(failed, [])
    assert.equal(facts.mac, 'macOS 27.0 on arm64')
    assert.deepEqual(facts.links, ['Ethernet (en0)', 'Wi-Fi (en1)', 'iPhone USB (en7)'])
    const s = statuses(results)
    for (const name of [
      'One site, sticky off: its connections spread',
      'One site, sticky on: it stays on one network',
      'Two hosts of one site stay on one network',
      'Different sites still spread',
      "Mergelane's own download uses every network",
      'Unplug Ethernet (en0): the others carry on',
      'Reconnect iPhone USB (en7): it is used again',
      'Sleep and wake',
      'A VPN turns merging off, and enabling is refused',
      'With the VPN off, merging turns on again',
      'A helper crash leaves the internet working',
      'Put back as it was'
    ]) {
      assert.equal(s[name], 'PASS', name)
    }
    // Every link was capped for the run and put back as it was; merging is off again, sticky on again.
    assert.ok(mac.calls.includes(`setLimit ${JSON.stringify({ link: 'en7', mbps: TEST_MBPS })}`))
    assert.ok(
      mac.calls.includes(`setLimit ${JSON.stringify({ link: 'en7', mbps: FAILOVER_MBPS })}`)
    )
    assert.match(
      results.find((r) => r.name.startsWith('Unplug Wi-Fi')).note,
      /4\/4 downloads finished/
    )
    assert.ok(mac.calls.includes(`setLimit ${JSON.stringify({ link: 'en1', mbps: 50 })}`))
    assert.ok(mac.calls.includes(`setLimit ${JSON.stringify({ link: 'en0', mbps: 0 })}`))
    assert.equal(mac.world.state, 'off')
    assert.equal(mac.world.sticky, true)
    assert.ok(mac.said.some((t) => /about \d+ MB/.test(t)))
    assert.ok(mac.said.some((t) => t.includes(`${HELPER} limit en1 50`)))
  })

  it('names networks from macOS when the helper sends no kind', async () => {
    const links = fakeMac().world.links.map(({ kind, ...rest }) => rest)
    const mac = fakeMac(['n'], { links })
    const { facts } = await runSuite(mac)
    assert.deepEqual(facts.links, ['Ethernet (en0)', 'Wi-Fi (en1)', 'iPhone USB (en7)'])
  })

  it('stops at the preflight when something isn’t right, changing nothing', async () => {
    const cases = [
      [{ unreachable: true }, 'The helper answers'],
      [{ app: '0.3.1' }, 'The helper matches the app'],
      [
        { links: [{ name: 'en1', kind: 'Wi-Fi', up: true, state: 'up', index: 1 }] },
        'At least two networks are up'
      ],
      [{ vpnOn: true }, 'No other VPN is on'],
      [{ offline: true }, 'The internet works before starting']
    ]
    for (const [world, check] of cases) {
      const mac = fakeMac([], world)
      const { results } = await runSuite(mac)
      assert.equal(results.at(-1).name, check)
      assert.equal(results.at(-1).status, 'FAIL')
      assert.ok(!mac.calls.includes('enable'), check)
    }
    // No app in /Applications: the helper alone is checked.
    const { results } = await runSuite(fakeMac(['n'], { app: undefined }))
    assert.equal(results.at(-1).name, 'Started')
  })

  it('does nothing when the owner doesn’t start', async () => {
    const mac = fakeMac(['n'])
    const { results } = await runSuite(mac)
    assert.equal(results.at(-1).status, 'SKIP')
    assert.ok(!mac.calls.includes('enable'))
  })

  it('reports a merge that won’t turn on', async () => {
    let mac = fakeMac(['y'], {
      fail: { enable: { message: 'No network can reach the internet.' } }
    })
    let { results } = await runSuite(mac)
    assert.equal(statuses(results)['System merge turns on'], 'FAIL')
    assert.equal(results.at(-1).name, 'Put back as it was')
    mac = fakeMac(['y'], { neverOn: true })
    ;({ results } = await runSuite(mac))
    assert.match(results.find((r) => r.name === 'System merge turns on').note, /never reported on/)
  })

  it('skips the sticky checks on a helper without them, and fails them when sites spread anyway', async () => {
    let mac = fakeMac(['y', 's'], { hasSticky: false })
    let { results } = await runSuite(mac, { skip: ['unplug', 'sleep', 'vpn', 'crash'] })
    assert.equal(statuses(results)['Sticky per site'], 'SKIP')
    assert.equal(statuses(results)["Mergelane's own download uses every network"], 'SKIP')
    assert.ok(!mac.calls.some((c) => c.startsWith('setStickySites')))
    mac = fakeMac(['y', 'n'], { stickyWorks: false })
    ;({ results } = await runSuite(mac, { skip: ['unplug', 'sleep', 'vpn', 'crash'] }))
    const s = statuses(results)
    assert.equal(s['One site, sticky on: it stays on one network'], 'FAIL')
    assert.equal(s['Two hosts of one site stay on one network'], 'FAIL')
    assert.equal(s["Mergelane's own download uses every network"], 'FAIL')
  })

  it('gives the internet a moment after a network goes, and says how long it took', async () => {
    const answers = [
      'y',
      'y',
      '',
      (w) => (w.unplugged.add('en0'), (w.probeFailures = 3), ''),
      (w) => (w.unplugged.delete('en0'), '')
    ]
    const mac = fakeMac(answers, { links: fakeMac().world.links.slice(0, 2) })
    const { results } = await runSuite(mac, { links: ['en0'], skip: ['sleep', 'vpn', 'crash'] })
    const unplug = results.find((r) => r.name.startsWith('Unplug Ethernet'))
    assert.equal(unplug.status, 'PASS')
    assert.match(unplug.note, /internet works \(after \d+ s\)/)
    // Never back within 30 s: broken, with the last error.
    const never = fakeMac(
      [
        'y',
        'y',
        '',
        (w) => (w.unplugged.add('en0'), (w.probeFailures = 1000), ''),
        (w) => (w.unplugged.delete('en0'), (w.probeFailures = 0), '')
      ],
      { links: fakeMac().world.links.slice(0, 2) }
    )
    const broken = (
      await runSuite(never, { links: ['en0'], skip: ['sleep', 'vpn', 'crash'] })
    ).results.find((r) => r.name.startsWith('Unplug Ethernet'))
    assert.equal(broken.status, 'FAIL')
    assert.match(broken.note, /internet broken for 3\d s \(curl: \(6\) Could not resolve host\)/)
  })

  it('fails an unplug that is never seen, and a link that never comes back', async () => {
    const mac = fakeMac(['y', 'y', '', '', '', 'n', 'n', 'n'], {
      links: fakeMac().world.links.slice(0, 2)
    })
    // The link is "unplugged" but stays up, then really disappears for good.
    mac.ask = ((ask) => async (q) => {
      if (/back in/.test(q)) mac.world.unplugged.add('en0')
      return ask(q)
    })(mac.ask)
    const { results } = await runSuite(mac, { links: ['en0'] })
    const s = statuses(results)
    assert.equal(s['Unplug Ethernet (en0): the others carry on'], 'FAIL')
    assert.equal(s['Reconnect Ethernet (en0): it is used again'], 'FAIL')
    assert.match(results.find((r) => r.name.startsWith('Reconnect')).note, /never came back/)
  })

  it('leaves the site checks out with --skip sites, using no data for them', async () => {
    const mac = fakeMac(['y', 's', 'n', 'n'])
    const { results } = await runSuite(mac, { skip: ['sites', 'unplug', 'vpn'] })
    assert.equal(statuses(results)['Spreading and sticky sites'], 'SKIP')
    assert.equal(statuses(results)['One site, sticky on: it stays on one network'], undefined)
    assert.ok(!mac.calls.includes('stats'))
  })

  it('lets the owner skip each optional check', async () => {
    const mac = fakeMac(['y', 'y', 'n', 'n', 'n', 'n', 'n'])
    const { results } = await runSuite(mac)
    const s = statuses(results)
    assert.equal(s['Unplug Ethernet (en0)'], 'SKIP')
    assert.equal(s['A helper crash leaves the internet working'], 'SKIP')
    assert.equal(s['Sleep and wake'], undefined)
    assert.equal(s['Put back as it was'], 'PASS')
    const none = await runSuite(fakeMac(['y', 'y', 'n', 'n', 'n', 'n', 'n'], { noPid: true }), {
      skip: ['unplug']
    })
    assert.match(none.results.find((r) => r.name.startsWith('A helper crash')).note, /not found/)
  })

  it('fails a VPN that doesn’t stop merging, and a crash that breaks things', async () => {
    // The owner says yes to the crash, then presses Enter without stopping the helper.
    const answers = ['y', 'y', 'n', 'y', '', '', 'y', '']
    const mac = fakeMac(answers)
    const { results } = await runSuite(mac, { skip: ['unplug'] })
    const s = statuses(results)
    assert.equal(s['A VPN turns merging off, and enabling is refused'], 'FAIL')
    assert.equal(s['A helper crash leaves the internet working'], 'FAIL')
    assert.match(results.find((r) => r.name.startsWith('A helper crash')).note, /wasn't stopped/)
    // It never runs sudo itself, and shows the command to run in another window.
    assert.ok(!mac.ran.includes('sudo'))
    assert.ok(mac.said.some((t) => /second Terminal window[\s\S]*sudo kill -9 111/.test(t)))
  })

  it('accepts a crash that auto-resume turns back on', async () => {
    const mac = fakeMac(['y', 'y', 'n', 'n', 'y', (w) => (w.crash(), '')], {
      autoResumeAfterCrash: true
    })
    const { results } = await runSuite(mac, { skip: ['unplug'] })
    assert.equal(statuses(results)['A helper crash leaves the internet working'], 'PASS')
  })

  it('fails sleep and wake when the routes or the internet are wrong after it', async () => {
    const mac = fakeMac(['y', 'y', 'y', (w) => ((w.offline = true), ''), 'n', 'n'])
    const { results } = await runSuite(mac, { skip: ['unplug'] })
    assert.equal(statuses(results)['Sleep and wake'], 'FAIL')
    assert.equal(statuses(results)['Put back as it was'], 'FAIL')
  })

  it('puts everything back after Ctrl-C or an unexpected error', async () => {
    let mac = fakeMac(['y', '^C'])
    let { results } = await runSuite(mac)
    assert.equal(statuses(results).Stopped, 'SKIP')
    assert.equal(statuses(results)['Put back as it was'], 'PASS')
    assert.equal(mac.world.state, 'off')
    mac = fakeMac(['y', 'y'], { fail: { setStickySites: { message: 'the helper went away' } } })
    ;({ results } = await runSuite(mac))
    assert.equal(statuses(results)['Unexpected error'], 'FAIL')
    assert.match(results.at(-1).note, /the helper went away/)
  })

  it('reports capture routes left behind, with the cleanup command', async () => {
    const mac = fakeMac(['y', '^C'])
    mac.run = ((runOriginal) => async (command, args) => {
      if (command === 'netstat' && mac.world.state === 'off' && mac.calls.includes('disable')) {
        return { code: 0, stdout: NETSTAT_ON, stderr: '' }
      }
      return runOriginal(command, args)
    })(mac.run)
    const { results } = await runSuite(mac)
    assert.equal(results.at(-1).status, 'FAIL')
    assert.match(results.at(-1).note, /sudo .* cleanup/)
  })

  it('leaves merging on when it was on before', async () => {
    const mac = fakeMac(['y', '^C'], { state: 'on' })
    await runSuite(mac)
    assert.equal(mac.world.state, 'on')
    assert.ok(!mac.calls.includes('disable'))
  })
})

describe('the real Mac’s parts', () => {
  it('talks to the helper over its socket', async () => {
    const dir = mkdtempSync('/tmp/mlhw-')
    const path = join(dir, 's')
    const replies = []
    const server = createSocketServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (line) => {
        const request = JSON.parse(line)
        const reply = replies.shift()
        if (reply === 'silent') return
        socket.write(
          typeof reply === 'string'
            ? reply
            : `${JSON.stringify({ v: 1, id: request.id, ...reply })}\n`
        )
      })
    })
    await new Promise((r) => server.listen(path, r))
    try {
      replies.push({ ok: true, result: { state: 'off', version: '0.3.2', protocol: 1 } })
      assert.equal((await callHelper('status', undefined, { socketPath: path })).version, '0.3.2')
      replies.push({ ok: false, error: { code: 'VPN_ACTIVE', message: 'Another VPN is on.' } })
      await assert.rejects(callHelper('enable', undefined, { socketPath: path }), {
        code: 'VPN_ACTIVE',
        message: 'Another VPN is on.'
      })
      replies.push({ ok: false })
      await assert.rejects(callHelper('disable', {}, { socketPath: path }), /disable failed/)
      replies.push({ ok: true, result: { nope: true } })
      await assert.rejects(callHelper('status', undefined, { socketPath: path }), /malformed/)
      replies.push('not json\n')
      await assert.rejects(callHelper('status', undefined, { socketPath: path }), /isn't JSON/)
      replies.push('{"v":1,')
      replies.push('silent')
      await assert.rejects(
        callHelper('status', undefined, { socketPath: path, timeoutMs: 200 }),
        /didn't answer/
      )
      await assert.rejects(
        callHelper('status', undefined, { socketPath: join(dir, 'missing') }),
        /ENOENT/
      )
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs commands, and downloads with curl', async () => {
    assert.equal((await run('true')).code, 0)
    assert.equal((await run('false')).code, 1)
    assert.notEqual((await run('/no/such/command')).code, 0)
    const server = createServer((req, res) => {
      if (req.url === '/broken') return res.writeHead(500).end()
      const range = req.headers.range
      res.writeHead(range ? 206 : 200)
      res.end(Buffer.alloc(range ? 100 : 50))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const ranged = await download({ url: `${base}/file`, range: true }, { bytes: 100 })
      assert.equal(ranged.ok, true)
      assert.equal(ranged.bytes, 100)
      assert.equal((await download({ url: `${base}/file` })).bytes, 50)
      assert.equal((await download({ url: `${base}/broken` })).ok, false)
      const gone = await download({ url: 'http://127.0.0.1:9/' }, { seconds: 2 })
      assert.equal(gone.ok, false)
      assert.ok(gone.error)
    } finally {
      server.close()
    }
  })

  it('asks the owner, and Ctrl-C ends the question', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const mac = realMac({ input, output })
    const answer = mac.ask('Ready?')
    input.write('  yes \n')
    assert.equal(await answer, 'yes')
    assert.equal(mac.aborted(), false)
    const pending = mac.ask('Again?')
    mac.interrupt()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(mac.aborted(), true)
    mac.say('said')
    await mac.wait(1)
    assert.ok(mac.now() > 0)
    mac.close()
  })

  it('writes the report', () => {
    const root = mkdtempSync(join(tmpdir(), 'mlhw-'))
    try {
      const dir = writeReport(
        [{ name: 'A', status: 'PASS' }],
        { when: 'now', mac: 'm' },
        root,
        'stamp'
      )
      assert.equal(dir, join(root, 'local-ci-logs', 'hardware-stamp'))
      assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /Every check that ran passed/)
      assert.equal(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).results[0].name, 'A')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs from the command line, and exits 1 on a failure or a stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mlhw-'))
    const cwd = process.cwd()
    try {
      const failing = fakeMac([], { unreachable: true })
      failing.say = () => {}
      assert.equal(await main([], failing, root), 1)
      const declined = fakeMac(['n'])
      declined.say = () => {}
      assert.equal(await main(['--skip', 'unplug,sleep', '--links', 'en0'], declined, root), 0)
      const stoppedMac = fakeMac(['y', '^C'])
      stoppedMac.say = () => {}
      let aborted = false
      stoppedMac.interrupt = () => (aborted = true)
      stoppedMac.aborted = () => aborted
      process.emit('SIGINT')
      assert.equal(aborted, false) // not listening yet
      const done = main([], stoppedMac, root)
      process.emit('SIGINT')
      assert.equal(await done, 1)
      const throwing = fakeMac()
      throwing.say = () => {}
      throwing.run = async () => {
        throw new Error('no sw_vers')
      }
      assert.equal(await main([], throwing, root), 1)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
