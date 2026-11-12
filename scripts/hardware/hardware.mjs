#!/usr/bin/env node
// The real-hardware suite (M3.8, docs/DECISIONS.md ADR-0050), run by the owner in their own Terminal on their
// own Mac: `node scripts/hardware/hardware.mjs`. It drives the installed Mergelane helper over its control
// socket, downloads real files over every network the Mac has, and asks the owner to unplug, sleep or switch
// a VPN at the right moments. It checks what it can by itself and asks the owner to confirm what only a person
// can see. Whatever happens (Ctrl-C included), it turns system merge off again, puts the helper's settings
// back and checks that no routes are left behind.
//
// It never runs sudo: the one step that needs it (a helper crash) is optional, and the owner runs the command it
// shows in a second Terminal window, where sudo has the keyboard to itself. The report goes to
// local-ci-logs/hardware-<time>/.
//
// Data: every download counts against a phone's data plan. The intro says how much the run uses.

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { markedRoutes, parseRoutes, scutilActive, vpnRoutes } from '../ci/local-root-lib.mjs'
import { PROTOCOL_VERSION, SOCKET_PATH, isResultOf } from '../../shared/daemon-api.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The helper as the app installs it (daemon/internal/launchd). */
export const LABEL = 'io.github.zahidnoor7.mergelane.daemon'
export const HELPER = `/Library/PrivilegedHelperTools/${LABEL}`

/** Bytes per download. */
export const CHUNK = 8_000_000

/**
 * While the suite runs, every network is capped at this (the helper's own per-link limit, `setLimit`), so a
 * download lasts long enough to be measured even on fast Ethernet, and the data used stays predictable. The
 * owner's own limits are put back at the end.
 */
export const TEST_MBPS = 16

/** The cap while a network is unplugged, so the downloads are still running when the owner pulls it. */
export const FAILOVER_MBPS = 4

/**
 * Public speed-test files on three sites; the two Hetzner hosts are one site (hetzner.com). Each is fetched
 * for CHUNK bytes: Cloudflare takes the size in the address, the others honour a byte range.
 */
export const FILES = {
  cloudflare: { site: 'cloudflare.com', url: `https://speed.cloudflare.com/__down?bytes=${CHUNK}` },
  ovh: { site: 'ovh.net', url: 'https://proof.ovh.net/files/100Mb.dat', range: true },
  hetznerAsh: { site: 'hetzner.com', url: 'https://ash-speed.hetzner.com/100MB.bin', range: true },
  hetznerNbg: { site: 'hetzner.com', url: 'https://nbg1-speed.hetzner.com/100MB.bin', range: true },
  /** "Does the internet work": 100 kB, small enough to get through a capped, busy network. */
  probe: { site: 'cloudflare.com', url: 'https://speed.cloudflare.com/__down?bytes=100000' }
}

/** How many CHUNK downloads each check makes, to state the data it uses up front. */
export const DOWNLOADS = {
  spread: 8,
  sticky: 8,
  sameSite: 4,
  sites: 3,
  failover: 4,
  perLinkBack: 2
}

/** The data a run uses, in MB, for `links` links tested for unplugging, with or without the site checks. */
export function dataEstimateMB(links, sites = true) {
  const fixed = sites
    ? DOWNLOADS.spread + DOWNLOADS.sticky + DOWNLOADS.sameSite + DOWNLOADS.sites
    : 0
  return Math.round(((fixed + links * (DOWNLOADS.failover + DOWNLOADS.perLinkBack)) * CHUNK) / 1e6)
}

// ---------------------------------------------------------------------------------------------------------
// What the checks decide, kept pure so they are tested on their own.

/**
 * Merged bytes per link over a run, from `stats` samples taken every `every` ms: each sample's rate times the
 * interval. System merge counts only what goes through it, so other apps' traffic shows here too: the
 * checks use shares, and the intro asks the owner to pause heavy use.
 */
export function bytesByLink(samples, every) {
  const bytes = {}
  for (const sample of samples) {
    for (const link of sample.links) {
      bytes[link.name] = (bytes[link.name] ?? 0) + ((link.rxBps + link.txBps) * every) / 1000
    }
  }
  return bytes
}

/** Each link's share of the bytes, largest first. */
export function shares(bytes) {
  const total = Object.values(bytes).reduce((a, b) => a + b, 0)
  return Object.entries(bytes)
    .map(([name, b]) => ({ name, share: total > 0 ? b / total : 0 }))
    .sort((a, b) => b.share - a.share)
}

/** The links that carried at least `min` of the bytes. */
export function linksUsed(bytes, min = 0.1) {
  return shares(bytes)
    .filter((s) => s.share >= min)
    .map((s) => s.name)
}

/** "en0 71%, en5 29%". */
export function describeShares(bytes) {
  const list = shares(bytes).filter((s) => s.share >= 0.005)
  return list.length
    ? list.map((s) => `${s.name} ${Math.round(s.share * 100)}%`).join(', ')
    : 'no traffic'
}

/** Our /1 capture routes in `netstat -rn` output, and whether there is exactly one per half. */
export function captureRoutes(netstat) {
  const marked = markedRoutes(parseRoutes(netstat)).filter((r) => r.family === 'inet')
  const halves = ['0/1', '128.0/1'].map((dest) => marked.filter((r) => r.dest === dest).length)
  return { count: marked.length, once: halves.every((n) => n === 1) }
}

/** Another VPN, as the helper's guard sees it: a capture route on a tunnel, or a connected service. */
export function otherVpn(netstat, scutil) {
  return vpnRoutes(parseRoutes(netstat)).length > 0 || scutilActive(scutil).length > 0
}

/** The commands that put each link's limit back as it was (0 means no limit). */
export function restoreCommands(links) {
  return links.map((l) => `${HELPER} limit ${l.name} ${l.limitMbps ?? 0}`).join(' ; ')
}

/** A link as the report names it: "iPhone USB (en7)". */
export const linkLabel = (link) => (link.kind ? `${link.kind} (${link.name})` : link.name)

/**
 * Each device's hardware port as System Settings names it ("Wi-Fi", "iPhone USB"), from
 * `networksetup -listallhardwareports` (man networksetup: "Displays list of all hardware ports"). The helper
 * doesn't send a link's kind, so the suite asks macOS itself.
 */
export function hardwarePorts(text) {
  const ports = {}
  let port = null
  for (const line of text.split('\n')) {
    const name = line.match(/^Hardware Port: (.+)$/)
    if (name) port = name[1].trim()
    const device = line.match(/^Device: (\S+)$/)
    if (device && port) {
      ports[device[1]] = port
      port = null
    }
  }
  return ports
}

/** How to take a network away and bring it back, in the words of its kind. */
export function unplugSteps(link) {
  const kind = link.kind ?? ''
  if (/wi-?fi|airport/i.test(kind)) {
    return {
      off: 'Turn Wi-Fi off (Wi-Fi in the menu bar)',
      on: 'Turn Wi-Fi back on and wait until it joins your network'
    }
  }
  if (/iphone|ipad|android|usb|rndis|modem/i.test(kind)) {
    return {
      off: `Unplug the ${kind} cable`,
      on: `Plug the ${kind} cable back in (keep the phone's hotspot on)`
    }
  }
  if (/ethernet|lan|thunderbolt/i.test(kind)) {
    return { off: `Unplug the ${kind} cable`, on: `Plug the ${kind} cable back in` }
  }
  return { off: `Disconnect ${linkLabel(link)}`, on: `Reconnect ${linkLabel(link)}` }
}

/** The suite's summary: one line per check, and a verdict. */
export function renderReport(results, facts) {
  const icon = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'skip', INFO: 'info' }
  const lines = [
    '# Mergelane hardware run',
    '',
    `- When: ${facts.when}`,
    `- Mac: ${facts.mac}`,
    `- Mergelane ${facts.app ?? 'not found'}, helper ${facts.helper ?? 'not reachable'}`,
    `- Networks: ${facts.links?.length ? facts.links.join(', ') : 'none found'}`,
    `- Data used: about ${facts.dataMB ?? 0} MB`,
    '',
    '| Check | Result | Seconds | Note |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.name} | ${icon[r.status]} | ${r.seconds ?? ''} | ${(r.note ?? '').replace(/\|/g, '/')} |`
    ),
    ''
  ]
  const failed = results.filter((r) => r.status === 'FAIL').length
  lines.push(failed ? `**${failed} check(s) failed.**` : '**Every check that ran passed.**', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------------
// The real Mac: the helper's socket, commands, downloads and the owner at the keyboard.

/** Calls the helper over its control socket (protocol 1, one JSON line each way). */
export function callHelper(method, params, { socketPath = SOCKET_PATH, timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    const done = (error, value) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => done(new Error(`the helper didn't answer ${method}`)), timeoutMs)
    socket.on('error', (error) => done(error))
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const request = { v: PROTOCOL_VERSION, id: '1', method, ...(params ? { params } : {}) }
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      let reply
      try {
        reply = JSON.parse(buffer.slice(0, end))
      } catch {
        return done(new Error(`the helper's answer to ${method} isn't JSON`))
      }
      if (!reply.ok) {
        const error = new Error(reply.error?.message ?? `${method} failed`)
        error.code = reply.error?.code
        return done(error)
      }
      if (!isResultOf(method, reply.result))
        return done(new Error(`the helper's answer to ${method} is malformed`))
      done(null, reply.result)
    })
  })
}

/** Runs a command; never throws. */
export function run(command, args = [], { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      resolvePromise({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr
      })
    })
  })
}

/** Downloads a test file (CHUNK bytes) through whatever route macOS picks, discarding it. */
export async function download(file, { seconds = 60, bytes = CHUNK, runner = run } = {}) {
  const args = [
    '-sS',
    '-o',
    '/dev/null',
    '--max-time',
    String(seconds),
    '-w',
    '%{http_code} %{size_download}'
  ]
  if (file.range) args.push('-r', `0-${bytes - 1}`)
  const started = Date.now()
  const result = await runner('curl', [...args, file.url], { timeoutMs: (seconds + 10) * 1000 })
  const [status, size] = result.stdout.trim().split(' ').map(Number)
  return {
    ok: result.code === 0 && (status === 200 || status === 206) && size > 0,
    bytes: size || 0,
    ms: Date.now() - started,
    error: result.code === 0 ? undefined : result.stderr.trim().split('\n').pop()
  }
}

/** The real Mac, as the suite sees it. Ctrl-C (`interrupt`) ends the prompt or wait in progress. */
export function realMac({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output })
  const controller = new AbortController()
  const mac = {
    helper: (method, params) => callHelper(method, params),
    run,
    download: (file, options) => download(file, options),
    say: (text) => output.write(`${text}\n`),
    ask: async (question) =>
      (await rl.question(`${question} `, { signal: controller.signal })).trim(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    aborted: () => controller.signal.aborted,
    interrupt: () => controller.abort(),
    close: () => rl.close()
  }
  rl.on('SIGINT', () => mac.interrupt())
  return mac
}

/** What a Ctrl-C raises. */
export const stopped = () =>
  Object.assign(new Error('stopped by the owner (Ctrl-C)'), { name: 'AbortError' })

// ---------------------------------------------------------------------------------------------------------
// The suite.

/** Polls `check` until it returns a truthy value or `ms` passes; returns the last value. */
export async function until(mac, check, ms, every = 1000) {
  const end = mac.now() + ms
  let value
  for (;;) {
    if (mac.aborted?.()) throw stopped()
    value = await check().catch(() => undefined)
    if (value || mac.now() >= end) return value
    await mac.wait(every)
  }
}

const yes = (answer, byDefault) => (answer === '' ? byDefault : /^y(es)?$/i.test(answer))

/** Downloads `files` at once while sampling the helper's stats; returns the bytes per link and the results. */
export async function measured(mac, files, every = 500) {
  const samples = []
  let running = true
  const sampling = (async () => {
    while (running) {
      const stats = await mac.helper('stats').catch(() => null)
      if (stats) samples.push(stats)
      await mac.wait(every)
    }
  })()
  const results = await Promise.all(files.map((file) => mac.download(file)))
  running = false
  await sampling
  return { bytes: bytesByLink(samples, every), results }
}

const repeat = (file, n) => Array.from({ length: n }, () => file)

/**
 * Runs the suite on `mac`. Options: `links` limits the unplug checks to these names; `skip` lists checks to
 * leave out (sites, unplug, sleep, vpn, crash, app). Returns { results, facts }.
 */
export async function runSuite(mac, options = {}) {
  const results = []
  const facts = { when: new Date(mac.now()).toISOString(), mac: '', links: [], dataMB: 0 }
  const skip = new Set(options.skip ?? [])
  const record = (name, status, note, started) => {
    const r = {
      name,
      status,
      note,
      seconds: started ? Math.round((mac.now() - started) / 1000) : undefined
    }
    results.push(r)
    mac.say(`  ${status.padEnd(4)}  ${name}${note ? ` — ${note}` : ''}`)
    return r
  }
  /**
   * Whether a new connection gets through, trying for up to `ms`: right after a network goes, macOS and the
   * helper take a moment to move new connections over. Says how long it took, or the last error.
   */
  const internet = async (ms = 15_000) => {
    const begun = mac.now()
    let last = { ok: false, error: 'not tried' }
    for (;;) {
      last = await mac.download(FILES.probe, { seconds: 10 })
      const seconds = Math.round((mac.now() - begun) / 1000)
      if (last.ok)
        return {
          ok: true,
          seconds,
          note: seconds > 1 ? `internet works (after ${seconds} s)` : 'internet works'
        }
      if (mac.now() - begun >= ms || mac.aborted?.()) {
        return {
          ok: false,
          seconds,
          note: `internet broken for ${seconds} s (${last.error ?? 'no answer'})`
        }
      }
      await mac.wait(1000)
    }
  }
  const internetWorks = async () => (await internet()).ok

  // Preflight: what is here, and is it safe to go on.
  const sw = await mac.run('sw_vers', ['-productVersion'])
  const arch = await mac.run('uname', ['-m'])
  facts.mac = `macOS ${sw.stdout.trim()} on ${arch.stdout.trim()}`
  const plist = await mac.run('defaults', [
    'read',
    '/Applications/Mergelane.app/Contents/Info',
    'CFBundleShortVersionString'
  ])
  facts.app = plist.code === 0 ? plist.stdout.trim() : undefined
  let status
  try {
    status = await mac.helper('status')
  } catch (error) {
    record(
      'The helper answers',
      'FAIL',
      `${error.message}. Install it from Mergelane › Networks › System merge.`
    )
    return { results, facts }
  }
  facts.helper = status.version
  record('The helper answers', 'PASS', `helper ${status.version}, protocol ${status.protocol}`)
  if (facts.app && facts.app !== status.version) {
    record(
      'The helper matches the app',
      'FAIL',
      `app ${facts.app}, helper ${status.version}: update the helper first`
    )
    return { results, facts }
  }
  const ports = hardwarePorts((await mac.run('networksetup', ['-listallhardwareports'])).stdout)
  const links = (await mac.helper('links')).links.map((l) => ({
    ...l,
    kind: l.kind ?? ports[l.name]
  }))
  const up = links.filter((l) => l.up && l.state === 'up')
  facts.links = up.map(linkLabel)
  if (up.length < 2) {
    record(
      'At least two networks are up',
      'FAIL',
      `found ${facts.links.join(', ') || 'none'}; connect at least two`
    )
    return { results, facts }
  }
  record('At least two networks are up', 'PASS', facts.links.join(', '))
  const before = await mac.run('netstat', ['-rn'])
  const scutil = await mac.run('scutil', ['--nc', 'list'])
  if (otherVpn(before.stdout, scutil.stdout)) {
    record('No other VPN is on', 'FAIL', 'turn your VPN off before starting')
    return { results, facts }
  }
  if (!(await internetWorks())) {
    record('The internet works before starting', 'FAIL', 'a 1 MB download failed')
    return { results, facts }
  }

  const unplug = skip.has('unplug')
    ? []
    : up.filter((l) => !options.links || options.links.includes(l.name))
  facts.dataMB = dataEstimateMB(unplug.length, !skip.has('sites'))
  mac.say(
    `\nThis run downloads about ${facts.dataMB} MB in all, over every network, including any phone's data plan.`
  )
  mac.say('Pause big downloads, backups and video calls meanwhile: they share the same networks.')
  mac.say(
    `During the run each network is capped at ${TEST_MBPS} Mbit/s; your own limits come back at the end.`
  )
  mac.say(
    `If the run is cut off (say, the Mac restarts), put them back with: ${restoreCommands(links)}`
  )
  mac.say(`If your internet ever stops working afterwards: sudo ${HELPER} cleanup\n`)
  if (!yes(await mac.ask('Start? [y/N]'), false)) {
    record('Started', 'SKIP', 'the owner chose not to start')
    return { results, facts }
  }

  const original = {
    state: status.state,
    stickySites: status.stickySites,
    autoResume: status.autoResume
  }
  const limits = Object.fromEntries(links.map((l) => [l.name, l.limitMbps ?? 0]))
  const hasSticky = status.stickySites !== undefined
  const setSticky = (on) =>
    hasSticky ? mac.helper('setStickySites', { enabled: on }) : Promise.resolve()

  try {
    // On.
    let started = mac.now()
    try {
      await mac.helper('enable')
    } catch (error) {
      record('System merge turns on', 'FAIL', error.message, started)
      return { results, facts }
    }
    const on = await until(mac, async () => (await mac.helper('status')).state === 'on', 15_000)
    const routes = captureRoutes((await mac.run('netstat', ['-rn'])).stdout)
    record(
      'System merge turns on',
      on && routes.once ? 'PASS' : 'FAIL',
      on
        ? routes.once
          ? 'both capture routes in place'
          : `capture routes wrong (${routes.count})`
        : 'it never reported on',
      started
    )
    if (!on) return { results, facts }
    for (const name of Object.keys(limits))
      await mac.helper('setLimit', { link: name, mbps: TEST_MBPS })

    // The site checks (`--skip sites` leaves them out, to repeat only the rest).
    if (skip.has('sites')) {
      record('Spreading and sticky sites', 'SKIP', 'left out (--skip sites)')
    } else {
      // Spread: with sticky off, one site's connections go over every network.
      started = mac.now()
      await setSticky(false)
      let run1 = await measured(mac, repeat(FILES.cloudflare, DOWNLOADS.spread))
      let used = linksUsed(run1.bytes)
      record(
        'One site, sticky off: its connections spread',
        used.length >= 2 && run1.results.every((r) => r.ok) ? 'PASS' : 'FAIL',
        describeShares(run1.bytes),
        started
      )

      // Sticky: one site stays on one network, also across its hosts; different sites still spread.
      if (!hasSticky) {
        record('Sticky per site', 'SKIP', 'this helper has no sticky-per-site; update it')
      } else {
        started = mac.now()
        await setSticky(true)
        run1 = await measured(mac, repeat(FILES.cloudflare, DOWNLOADS.sticky))
        used = linksUsed(run1.bytes, 0.15)
        record(
          'One site, sticky on: it stays on one network',
          used.length === 1 ? 'PASS' : 'FAIL',
          describeShares(run1.bytes),
          started
        )
        started = mac.now()
        const half = DOWNLOADS.sameSite / 2
        run1 = await measured(mac, [
          ...repeat(FILES.hetznerAsh, half),
          ...repeat(FILES.hetznerNbg, half)
        ])
        used = linksUsed(run1.bytes, 0.15)
        record(
          'Two hosts of one site stay on one network',
          used.length === 1 ? 'PASS' : 'FAIL',
          describeShares(run1.bytes),
          started
        )
        started = mac.now()
        run1 = await measured(mac, [FILES.cloudflare, FILES.ovh, FILES.hetznerAsh])
        used = linksUsed(run1.bytes)
        record(
          'Different sites still spread',
          used.length >= 2 ? 'PASS' : 'FAIL',
          describeShares(run1.bytes),
          started
        )
      }
    }

    // Mergelane's own downloads pin each connection to its network (IP_BOUND_IF) while system merge is on.
    if (!skip.has('app')) {
      mac.say(`\nIn Mergelane, start a new download of:\n  ${FILES.hetznerNbg.url}`)
      mac.say('Select it and watch its networks while it downloads, then cancel it.')
      const seen = await mac.ask('Did it show traffic on every network? [y/n/s to skip]')
      if (/^s/i.test(seen))
        record("Mergelane's own download uses every network", 'SKIP', 'skipped by the owner')
      else
        record(
          "Mergelane's own download uses every network",
          yes(seen, false) ? 'PASS' : 'FAIL',
          'seen by the owner'
        )
    }

    // Unplugging each network, with downloads running.
    for (const link of unplug) {
      const label = linkLabel(link)
      if (!yes(await mac.ask(`\nTest unplugging ${label}? [Y/n]`), true)) {
        record(`Unplug ${label}`, 'SKIP', 'skipped by the owner')
        continue
      }
      await setSticky(false)
      const capAll = async (mbps) => {
        for (const name of Object.keys(limits))
          await mac.helper('setLimit', { link: name, mbps }).catch(() => {})
      }
      await capAll(FAILOVER_MBPS)
      const running = Promise.all(
        repeat(FILES.ovh, DOWNLOADS.failover).map((f) => mac.download(f, { seconds: 120 }))
      )
      const steps = unplugSteps(link)
      await mac.ask(`${steps.off} now, then press Enter.`)
      started = mac.now()
      const gone = await until(
        mac,
        async () => {
          const now = (await mac.helper('links')).links.find((l) => l.name === link.name)
          return !now || !now.up || now.state !== 'up'
        },
        30_000
      )
      const stillOn = (await mac.helper('status')).state === 'on'
      const net = await internet(30_000)
      const works = net.ok
      // Downloads on the unplugged network break, as any connection would; the rest finish.
      const finished = (await running).filter((r) => r.ok).length
      await capAll(TEST_MBPS)
      record(
        `Unplug ${label}: the others carry on`,
        gone && stillOn && works && finished > 0 ? 'PASS' : 'FAIL',
        [
          gone ? 'seen gone' : 'never seen gone',
          stillOn ? 'merge stayed on' : 'merge went off',
          net.note,
          `${finished}/${DOWNLOADS.failover} downloads finished`
        ].join(', '),
        started
      )
      await mac.ask(`${steps.on}, then press Enter.`)
      started = mac.now()
      const back = await until(
        mac,
        async () => {
          const now = (await mac.helper('links')).links.find((l) => l.name === link.name)
          return now?.up && now.state === 'up'
        },
        120_000,
        2000
      )
      const again = back
        ? await measured(mac, repeat(FILES.cloudflare, DOWNLOADS.perLinkBack))
        : null
      record(
        `Reconnect ${label}: it is used again`,
        back && linksUsed(again.bytes, 0.05).includes(link.name) ? 'PASS' : 'FAIL',
        back ? describeShares(again.bytes) : 'it never came back up within 2 minutes',
        started
      )
    }
    await setSticky(original.stickySites ?? true)

    // Sleep and wake.
    if (!skip.has('sleep') && yes(await mac.ask('\nTest sleep and wake? [Y/n]'), true)) {
      await mac.ask(
        'Put the Mac to sleep (Apple menu › Sleep). Wait 30 seconds, wake it, then press Enter here.'
      )
      started = mac.now()
      const answered = await until(mac, () => mac.helper('status'), 30_000)
      const linksBack = await until(
        mac,
        async () =>
          (await mac.helper('links')).links.filter((l) => l.up && l.state === 'up').length >= 2,
        120_000,
        2000
      )
      const state = (await mac.helper('status').catch(() => ({}))).state
      const once = captureRoutes((await mac.run('netstat', ['-rn'])).stdout).once
      const works = await internetWorks()
      record(
        'Sleep and wake',
        answered && linksBack && state === 'on' && once && works ? 'PASS' : 'FAIL',
        `helper ${answered ? 'answers' : 'silent'}, ${linksBack ? 'networks back' : 'networks missing'}, merge ${state ?? 'unknown'}, routes ${once ? 'once' : 'wrong'}, internet ${works ? 'works' : 'broken'}`,
        started
      )
    }

    // A VPN turning on makes merging step aside, and it can come back after.
    if (!skip.has('vpn') && yes(await mac.ask('\nTest a VPN? You need a VPN app. [y/N]'), false)) {
      await mac.ask('Turn your VPN on, wait until it says connected, then press Enter.')
      started = mac.now()
      const off = await until(
        mac,
        async () => {
          const s = await mac.helper('status')
          return s.state === 'off' && /vpn/i.test(s.reason ?? '') ? s : undefined
        },
        30_000
      )
      const refused = await mac.helper('enable').then(
        () => null,
        (error) => error.code
      )
      const ours = captureRoutes((await mac.run('netstat', ['-rn'])).stdout).count
      record(
        'A VPN turns merging off, and enabling is refused',
        off && refused === 'VPN_ACTIVE' && ours === 0 ? 'PASS' : 'FAIL',
        off
          ? `"${off.reason}"; enable: ${refused ?? 'accepted'}; our routes: ${ours}`
          : 'merging stayed on',
        started
      )
      await mac.ask('Turn the VPN off, then press Enter.')
      started = mac.now()
      const back = await until(
        mac,
        async () => {
          await mac.helper('enable')
          return (await mac.helper('status')).state === 'on'
        },
        60_000,
        3000
      )
      record('With the VPN off, merging turns on again', back ? 'PASS' : 'FAIL', '', started)
    }

    // A helper crash: launchd restarts it, the routes are gone and the internet works. The owner stops it
    // from a second Terminal window: sudo must have the keyboard to itself (this script reads it too, and an
    // early version that ran sudo itself echoed what was typed at the password prompt).
    if (!skip.has('crash')) {
      const pid = (await mac.run('pgrep', ['-x', LABEL])).stdout.trim().split('\n')[0]
      if (
        pid &&
        yes(
          await mac.ask(
            '\nTest a helper crash? You stop it yourself in another Terminal window. [y/N]'
          ),
          false
        )
      ) {
        await mac.ask(
          `Open a second Terminal window (⌘N) and run:\n  sudo kill -9 ${pid}\nType your password there, not here. Then come back and press Enter.`
        )
        started = mac.now()
        const restarted = await until(
          mac,
          async () => {
            const again = (await mac.run('pgrep', ['-x', LABEL])).stdout.trim()
            return again && again !== pid && (await mac.helper('status'))
          },
          30_000
        )
        const ours = captureRoutes((await mac.run('netstat', ['-rn'])).stdout)
        const net = await internet()
        const fine = restarted && (restarted.state === 'off' ? ours.count === 0 : ours.once)
        record(
          'A helper crash leaves the internet working',
          fine && net.ok ? 'PASS' : 'FAIL',
          restarted
            ? `restarted (${restarted.state}), our routes ${ours.count}, ${net.note}`
            : `the helper (process ${pid}) wasn't stopped, or didn't come back within 30 s`,
          started
        )
      } else {
        record(
          'A helper crash leaves the internet working',
          'SKIP',
          pid ? 'skipped by the owner' : 'helper process not found'
        )
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') record('Stopped', 'SKIP', 'stopped by the owner (Ctrl-C)')
    else record('Unexpected error', 'FAIL', error.message)
  } finally {
    // Back as it was: merging off unless it was on before, the settings restored, nothing left behind.
    const started = mac.now()
    const notes = []
    try {
      for (const [name, mbps] of Object.entries(limits)) {
        // A link that went away meanwhile can't be set; its saved limit is untouched.
        await mac.helper('setLimit', { link: name, mbps }).catch(() => {})
      }
      if (hasSticky) await mac.helper('setStickySites', { enabled: original.stickySites })
      if (original.state !== 'on') await mac.helper('disable')
    } catch (error) {
      notes.push(error.message)
    }
    const after = (await mac.run('netstat', ['-rn'])).stdout
    const ours = captureRoutes(after).count
    const works = await internetWorks()
    const leftOver = original.state !== 'on' && ours > 0
    if (leftOver) notes.push(`${ours} capture routes left: run sudo ${HELPER} cleanup`)
    notes.push(works ? 'internet works' : 'internet broken')
    record(
      'Put back as it was',
      !leftOver && works && notes.length === 1 ? 'PASS' : 'FAIL',
      notes.join('; '),
      started
    )
  }
  return { results, facts }
}

/** Writes the report and the raw results; returns the folder. */
export function writeReport(
  results,
  facts,
  root = ROOT,
  stamp = new Date().toISOString().replace(/[:.]/g, '-')
) {
  const dir = join(root, 'local-ci-logs', `hardware-${stamp}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.md'), renderReport(results, facts))
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ facts, results }, null, 2)}\n`)
  return dir
}

/** The command line: `node scripts/hardware/hardware.mjs [--links en0,en7] [--skip sites,unplug,sleep,vpn,crash,app]`. */
export async function main(argv = process.argv.slice(2), mac = realMac(), root = ROOT) {
  const option = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1]?.split(',').filter(Boolean) : undefined
  }
  mac.say('Mergelane real-hardware suite (M3.8). Ctrl-C at any time puts everything back.\n')
  const onInt = () => {
    mac.say('\nStopping: putting everything back first…')
    mac.interrupt?.()
  }
  process.on('SIGINT', onInt)
  try {
    const { results, facts } = await runSuite(mac, {
      links: option('--links'),
      skip: option('--skip')
    })
    const dir = writeReport(results, facts, root)
    mac.say(`\n${renderReport(results, facts)}\nReport: ${dir}/report.md`)
    return results.some((r) => r.status === 'FAIL') || mac.aborted?.() ? 1 : 0
  } catch (error) {
    // Only before anything changed (the preflight): there is nothing to put back.
    mac.say(`\nStopped before anything changed: ${error.message}`)
    return 1
  } finally {
    process.removeListener('SIGINT', onInt)
    mac.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
