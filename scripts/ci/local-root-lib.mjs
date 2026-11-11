// The decisions scripts/ci/local-root.sh makes from what it reads off the Mac, kept here so they can
// be tested without root: routing-table parsing, the VPN refusal, netsim's reserved ranges, the
// before/after comparisons, the helper's backup manifest and the final summary.
//
// usage (each reads files the runner saved; exit 1 means "found something"):
//   node local-root-lib.mjs vpn <netstat -rn> <scutil --nc list>
//   node local-root-lib.mjs overlaps <ifconfig -a> <netstat -rn>
//   node local-root-lib.mjs marked <netstat -rn>
//   node local-root-lib.mjs helper-iface <netstat -rn>
//   node local-root-lib.mjs compare <before netstat -rn> <after netstat -rn> [--ignore-noise]
//   node local-root-lib.mjs leftovers <dir with ifaces, lo0, routes, pipes, anchor, neighbors, lo0-before>
//   node local-root-lib.mjs helper-diff <manifest before> <manifest after>
//   node local-root-lib.mjs summary <results: name|PASS/FAIL/SKIP|seconds|note per line>
//   node local-root-lib.mjs noise-regex
import { readFileSync } from 'node:fs'

/** Destinations that capture traffic: a default route, or the /1 halves a VPN (or Mergelane) adds. */
const CAPTURE = new Set(['default', '0/1', '0.0.0.0/1', '128.0/1', '128.0.0.0/1', '::/1', '8000::/1'])
const TUNNEL = /^(utun|ipsec|ppp|tun|tap)\d+$/
/** System interfaces whose IPv6 link-local entries macOS adds and removes by itself. */
export const NOISE_IFACES = ['utun', 'awdl', 'llw', 'anpi', 'ap', 'nan', 'bridge']
const NOISE_REF = new RegExp(`%(${NOISE_IFACES.join('|')})\\d+(/|$)`)
/** The daemon's own utun addresses (daemon/internal/tun: tunRange 198.18.0.0/15, tunIP6). */
const TUN_V6 = /^fd6e:6d65:7267:/
const TUN_V4 = /^198\.(18|19)(\.|\/|$)/

/** Parses `netstat -rn` (one or both families) into routes. */
export function parseRoutes(text) {
  const routes = []
  let family = null
  for (const line of text.split('\n')) {
    if (/^Internet:/.test(line)) family = 'inet'
    else if (/^Internet6:/.test(line)) family = 'inet6'
    else if (family && line.trim() && !/^Destination\s/.test(line)) {
      const [dest, gateway, flags, netif = '', expire = ''] = line.trim().split(/\s+/)
      routes.push({ family, dest, gateway, flags, netif, expire })
    }
  }
  return routes
}

const isScoped = (r) => r.flags.includes('I')
const isCloned = (r) => r.flags.includes('W')

/** Interfaces carrying capture routes marked with Mergelane's RTF_PROTO2 (netstat flag "2"). */
export function markedCaptureIfaces(routes) {
  const names = routes
    .filter((r) => r.dest !== 'default' && CAPTURE.has(r.dest) && r.flags.includes('2'))
    .map((r) => r.netif)
  return [...new Set(names)]
}

/**
 * Unscoped default or /1 routes on a tunnel interface that is not Mergelane's (ADR-0018): an active
 * VPN. Scoped defaults on a utun are macOS's own and capture nothing.
 */
export function vpnRoutes(routes) {
  const ours = new Set(markedCaptureIfaces(routes))
  return routes.filter((r) => CAPTURE.has(r.dest) && !isScoped(r) && TUNNEL.test(r.netif) && !ours.has(r.netif))
}

/** `scutil --nc list` services that are up or changing state. */
export function scutilActive(text) {
  return text
    .split('\n')
    .filter((l) => /\((Connected|Connecting|Disconnecting)\)/.test(l))
    .map((l) => l.trim())
}

/** Routes Mergelane marked (RTF_PROTO2 on a default or /1 route), the ones `cleanup` removes. */
export function markedRoutes(routes) {
  return routes.filter((r) => CAPTURE.has(r.dest) && r.flags.includes('2') && !/[WHL]/.test(r.flags))
}

/** Addresses and routes on this Mac that collide with the ranges netsim uses. */
const NETSIM_RANGES = [/^10\.77\./, /^198\.51\.100\./, /^2001:db8:77:/i, /^2001:db8:198:51:100:/i]
export function netsimOverlaps(ifconfigText, routes) {
  const found = []
  for (const m of ifconfigText.matchAll(/^\s*inet6? ([0-9a-f.:]+)/gim)) {
    if (NETSIM_RANGES.some((re) => re.test(m[1]))) found.push(`address ${m[1]} is already in use`)
  }
  for (const r of routes) {
    if (!isCloned(r) && NETSIM_RANGES.some((re) => re.test(r.dest))) {
      found.push(`route ${r.dest} via ${r.gateway} on ${r.netif} is already in use`)
    }
  }
  return found
}

/** IPv6 link-local entries of system interfaces (utun, awdl, ...), which macOS changes on its own. */
export function isNoise(route) {
  return NOISE_REF.test(route.dest) || NOISE_REF.test(route.gateway)
}

/** The same rule as an extended regex over raw snapshot lines, for with-netsim.sh. */
export function noiseRegex() {
  const names = NOISE_IFACES.join('|')
  return `%(${names})[0-9]+(/|[[:space:]]|$)|^(${names})[0-9]+$`
}

/**
 * Routes as comparable lines. Cloned entries go; the Mergelane helper's utun (found by its marked
 * capture routes) is renamed, since a restarted helper gets a new one, and only its capture routes
 * are kept; the daemon's own utun addresses go; with ignoreNoise, so do macOS's link-local entries.
 */
export function normalizeRoutes(routes, { ignoreNoise = false } = {}) {
  const helper = new Set(markedCaptureIfaces(routes))
  const out = []
  for (const r of routes) {
    if (isCloned(r) || TUN_V6.test(r.dest) || (TUN_V4.test(r.dest) && r.netif.startsWith('utun'))) continue
    if (ignoreNoise && isNoise(r)) continue
    const onHelper = helper.has(r.netif) || [...helper].some((h) => r.dest.includes(`%${h}`) || r.gateway.includes(`%${h}`))
    if (onHelper) {
      if (CAPTURE.has(r.dest) && helper.has(r.netif)) out.push(`${r.family} ${r.dest} <mergelane-utun> ${r.flags} <mergelane-utun>`)
      continue
    }
    out.push(`${r.family} ${r.dest} ${r.gateway} ${r.flags} ${r.netif}`)
  }
  return out.sort()
}

/** Multiset difference of two line lists. */
export function diffLines(before, after) {
  const count = new Map()
  for (const l of before) count.set(l, (count.get(l) ?? 0) + 1)
  const added = []
  for (const l of after) {
    if (count.get(l)) count.set(l, count.get(l) - 1)
    else added.push(l)
  }
  const removed = [...count].flatMap(([l, n]) => Array(n).fill(l))
  return { removed, added }
}

/** Pipe numbers in `dnctl pipe show`. */
export function parsePipes(text) {
  return [...text.matchAll(/^0*(\d+):/gm)].map((m) => Number(m[1]))
}

/**
 * Everything netsim or the suites could have left behind, from what the runner saved. lo0Before
 * lists the go suite's aliases (127.0.0.2, 127.0.0.3) that were on lo0 before the run.
 */
export function harnessLeftovers({ ifaces = '', lo0 = '', routes = '', pipes = '', anchor = '', neighbors = '', lo0Before = '' }) {
  const found = []
  for (const name of ifaces.split(/\s+/).filter((n) => /^feth[1-8][01]$/.test(n))) found.push(`interface ${name}`)
  const kept = lo0Before.split(/\s+/)
  for (const addr of ['10.77.99.1', '2001:db8:77:99::1', '127.0.0.2', '127.0.0.3']) {
    if (kept.includes(addr)) continue
    if (new RegExp(`inet6? ${addr.replace(/\./g, '\\.')}( |$)`, 'm').test(lo0)) found.push(`lo0 address ${addr}`)
  }
  for (const r of parseRoutes(routes)) {
    if (NETSIM_RANGES.some((re) => re.test(r.dest) || re.test(r.gateway)) || r.dest === '192.0.2.77') {
      found.push(`route ${r.dest} via ${r.gateway} on ${r.netif}`)
    }
  }
  for (const n of parsePipes(pipes)) if (/^77[1-8][12]$/.test(String(n))) found.push(`dummynet pipe ${n}`)
  if (anchor.trim()) found.push(`pf anchor com.apple/mergelane-netsim: ${anchor.trim().split('\n')[0]}`)
  for (const l of neighbors.split('\n')) if (/10\.77\.|2001:db8:77:/i.test(l)) found.push(`neighbour entry: ${l.trim()}`)
  return found
}

/** key=value lines, the helper backup's manifest. */
export function parseManifest(text) {
  const m = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return m
}

// Not state/support: the helper's settings are put back, but a current helper rewrites them as it starts.
const HELPER_FACTS = ['plist', 'plist_sha', 'binary', 'binary_sha', 'loaded', 'merge', 'disabled']
/** How the helper now differs from the backup's record of it. launchd's "enabled" is its default, so
 * no record and an "enabled" one (which the test install's `launchctl enable` leaves) are the same. */
export function helperDiff(before, after) {
  const value = (m, k) => (k === 'disabled' && m[k] === 'enabled' ? '' : (m[k] ?? ''))
  return HELPER_FACTS.filter((k) => value(before, k) !== value(after, k)).map(
    (k) => `${k}: was ${before[k] || '(none)'}, now ${after[k] || '(none)'}`
  )
}

/** The end-of-run table. Rows: name|PASS/FAIL/SKIP|seconds|note. */
export function summarize(text) {
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [name, result, seconds, ...note] = l.split('|')
      return { name, result, seconds: Number(seconds) || 0, note: note.join('|') }
    })
  const width = Math.max(4, ...rows.map((r) => r.name.length))
  const time = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`)
  const lines = rows.map((r) => `${r.result.padEnd(4)}  ${r.name.padEnd(width)}  ${time(r.seconds).padStart(6)}${r.note ? `  ${r.note}` : ''}`)
  return { text: lines.join('\n'), failed: rows.filter((r) => r.result === 'FAIL').length }
}

const read = (path) => readFileSync(path, 'utf8')

/** The command line; returns the exit code. */
export function cli(argv, out = console.log) {
  const [cmd, a, b, flag] = argv
  const report = (items) => {
    for (const item of items) out(item)
    return items.length ? 1 : 0
  }
  switch (cmd) {
    case 'vpn': {
      const routes = vpnRoutes(parseRoutes(read(a))).map((r) => `VPN route ${r.dest} on ${r.netif}`)
      return report([...routes, ...scutilActive(read(b)).map((s) => `VPN service: ${s}`)])
    }
    case 'overlaps':
      return report(netsimOverlaps(read(a), parseRoutes(read(b))))
    case 'marked':
      return report(markedRoutes(parseRoutes(read(a))).map((r) => `${r.dest} ${r.gateway} ${r.flags} ${r.netif}`))
    case 'helper-iface':
      out(markedCaptureIfaces(parseRoutes(read(a))).join(' '))
      return 0
    case 'compare': {
      const opts = { ignoreNoise: flag === '--ignore-noise' }
      const { removed, added } = diffLines(normalizeRoutes(parseRoutes(read(a)), opts), normalizeRoutes(parseRoutes(read(b)), opts))
      return report([...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)])
    }
    case 'leftovers': {
      const file = (name) => {
        try {
          return read(`${a}/${name}`)
        } catch {
          return ''
        }
      }
      const names = ['ifaces', 'lo0', 'routes', 'pipes', 'anchor', 'neighbors']
      return report(harnessLeftovers({ ...Object.fromEntries(names.map((n) => [n, file(n)])), lo0Before: file('lo0-before') }))
    }
    case 'helper-diff':
      return report(helperDiff(parseManifest(read(a)), parseManifest(read(b))))
    case 'summary': {
      const { text, failed } = summarize(read(a))
      out(text)
      return failed ? 1 : 0
    }
    case 'noise-regex':
      out(noiseRegex())
      return 0
    default:
      out('usage: node local-root-lib.mjs vpn|overlaps|marked|helper-iface|compare|leftovers|helper-diff|summary|noise-regex ...')
      return 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = cli(process.argv.slice(2))
