// Tests for local-root-lib.mjs. Run: node --test scripts/ci/local-root-lib.test.mjs
// The routing tables are in the exact format `netstat -rn` prints on macOS 27.0.1.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cli,
  diffLines,
  harnessLeftovers,
  helperDiff,
  isNoise,
  markedCaptureIfaces,
  markedRoutes,
  netsimOverlaps,
  noiseRegex,
  normalizeRoutes,
  parseManifest,
  parsePipes,
  parseRoutes,
  scutilActive,
  summarize,
  vpnRoutes
} from './local-root-lib.mjs'

// The owner's Mac on 2026-11-11: Wi-Fi only, Mergelane's helper merging on utun7.
const MERGING = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                utun7              US2cg               utun7
default            192.168.1.1        UGScg                 en0
default            192.168.1.1        UGS2cIg               en0
127                127.0.0.1          UCS                   lo0
127.0.0.1          127.0.0.1          UH                    lo0
128.0/1            utun7              US2c                utun7
192.168.1          link#14            UCS                   en0      !
192.168.1.1        f4:e8:4f:df:cb:76  UHLWIir               en0   1196
198.18.0.1         198.18.0.1         UH                  utun7

Internet6:
Destination                             Gateway                                 Flags               Netif Expire
::/1                                    utun7                                   US2cg               utun7
default                                 fe80::%utun0                            UGcIg               utun0
::1                                     ::1                                     UHL                   lo0
8000::/1                                utun7                                   US2c                utun7
fd6e:6d65:7267::/64                     fe80::a821:f3bc:bb4c:ad23%utun7         Uc                  utun7
fd6e:6d65:7267::1                       link#29                                 UHL                   lo0
fe80::%utun0/64                         fe80::8c37:16dd:e1a1:e65f%utun0         UcI                 utun0
fe80::%utun7/64                         fe80::a821:f3bc:bb4c:ad23%utun7         UcI                 utun7
fe80::a821:f3bc:bb4c:ad23%utun7         link#29                                 UHLI                  lo0
`

// The same Mac after the run: the helper restarted on utun9, macOS dropped utun0's link-local.
const RESTORED = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                utun9              US2cg               utun9
default            192.168.1.1        UGScg                 en0
default            192.168.1.1        UGS2cIg               en0
127                127.0.0.1          UCS                   lo0
127.0.0.1          127.0.0.1          UH                    lo0
128.0/1            utun9              US2c                utun9
192.168.1          link#14            UCS                   en0      !
192.168.1.3        f0:c7:25:5e:56:1a  UHLWI                 en0   1195
198.18.0.1         198.18.0.1         UH                  utun9

Internet6:
Destination                             Gateway                                 Flags               Netif Expire
::/1                                    utun9                                   US2cg               utun9
::1                                     ::1                                     UHL                   lo0
8000::/1                                utun9                                   US2c                utun9
fd6e:6d65:7267::1                       link#31                                 UHL                   lo0
fe80::%utun9/64                         fe80::1111:2222:3333:4444%utun9         UcI                 utun9
`

const VPN = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                10.8.0.1           UGSc                utun4
default            192.168.1.1        UGScg                 en0
128.0/1            10.8.0.1           UGSc                utun4

Internet6:
Destination                             Gateway                                 Flags               Netif Expire
default                                 fe80::%utun0                            UGcIg               utun0
`

test('parseRoutes reads both families, skipping titles and headers', () => {
  const routes = parseRoutes(MERGING)
  assert.equal(routes.filter((r) => r.family === 'inet').length, 9)
  assert.equal(routes.filter((r) => r.family === 'inet6').length, 9)
  assert.deepEqual(routes[0], { family: 'inet', dest: '0/1', gateway: 'utun7', flags: 'US2cg', netif: 'utun7', expire: '' })
  assert.equal(routes.find((r) => r.dest === '192.168.1').expire, '!')
  assert.deepEqual(parseRoutes('no table here\n'), [])
})

test("the helper's utun is the one whose capture routes carry the RTF_PROTO2 mark", () => {
  assert.deepEqual(markedCaptureIfaces(parseRoutes(MERGING)), ['utun7'])
  assert.deepEqual(markedCaptureIfaces(parseRoutes(VPN)), [])
})

test("Mergelane's marked capture routes are not a VPN; another utun's unscoped /1 routes are", () => {
  assert.deepEqual(vpnRoutes(parseRoutes(MERGING)), [])
  assert.deepEqual(
    vpnRoutes(parseRoutes(VPN)).map((r) => `${r.dest} ${r.netif}`),
    ['0/1 utun4', '128.0/1 utun4']
  )
  // An ipsec default (a classic VPN) counts; a scoped utun default does not (ADR-0018).
  const ipsec = parseRoutes('Internet:\nDestination Gateway Flags Netif Expire\ndefault 10.0.0.1 UGSc ipsec0\n')
  assert.equal(vpnRoutes(ipsec).length, 1)
})

test('scutil services that are up or changing count; disconnected ones do not', () => {
  const text = `Available network connection services in the current set (*=enabled):
* (Connected)      1234 VPN (com.example) "Work"     [VPN/com.example]
* (Disconnected)   5678 VPN (IKEv2)       "Home"     [VPN/IKEv2]
* (Connecting)     9abc PPP --> Modem      "Dial"     [PPP/Modem]
`
  assert.deepEqual(scutilActive(text).length, 2)
  assert.match(scutilActive(text)[0], /Work/)
  assert.deepEqual(scutilActive('Available network connection services in the current set (*=enabled):\n'), [])
})

test('markedRoutes lists the routes cleanup would remove', () => {
  assert.deepEqual(
    markedRoutes(parseRoutes(MERGING)).map((r) => `${r.dest} ${r.netif}`),
    ['0/1 utun7', 'default en0', '128.0/1 utun7', '::/1 utun7', '8000::/1 utun7']
  )
  assert.deepEqual(markedRoutes(parseRoutes(VPN)), [])
})

test("netsimOverlaps finds addresses and routes in netsim's ranges", () => {
  const ifconfig = 'en0: flags=8863<UP>\n\tinet 192.168.1.7 netmask 0xffffff00\nen5: flags=8863\n\tinet 10.77.3.4 netmask 0xffffff00\n\tinet6 2001:db8:77:1::9 prefixlen 64\n'
  const routes = parseRoutes('Internet:\nDestination Gateway Flags Netif Expire\n198.51.100.10 10.0.0.1 UGHS en0\n10.77.5.9 1:2:3:4:5:6 UHLWI en5 100\n')
  assert.deepEqual(netsimOverlaps(ifconfig, routes), [
    'address 10.77.3.4 is already in use',
    'address 2001:db8:77:1::9 is already in use',
    'route 198.51.100.10 via 10.0.0.1 on en0 is already in use'
  ])
  assert.deepEqual(netsimOverlaps('en0:\n\tinet 192.168.1.7\n', parseRoutes(MERGING)), [])
})

test('normalizeRoutes keeps what matters across a helper restart and ignores macOS noise', () => {
  const before = normalizeRoutes(parseRoutes(MERGING), { ignoreNoise: true })
  const after = normalizeRoutes(parseRoutes(RESTORED), { ignoreNoise: true })
  assert.deepEqual(diffLines(before, after), { removed: [], added: [] })
  assert.ok(before.includes('inet 0/1 <mergelane-utun> US2cg <mergelane-utun>'))
  assert.ok(before.includes('inet6 8000::/1 <mergelane-utun> US2c <mergelane-utun>'))
  assert.ok(!before.some((l) => /utun7|198\.18|fd6e|W/.test(l)))
  // Without ignoring noise, macOS's own utun0 link-local entries are compared too.
  const strict = diffLines(normalizeRoutes(parseRoutes(MERGING)), normalizeRoutes(parseRoutes(RESTORED)))
  assert.deepEqual(strict.added, [])
  assert.equal(strict.removed.length, 2)
})

test('normalizeRoutes reports a route the run left behind, and one it removed', () => {
  const leaked = RESTORED.replace(/^(127\.0\.0\.1 .*\n)/m, '$1192.0.2.77         127.0.0.1          UGHS                  lo0\n')
  const { added, removed } = diffLines(normalizeRoutes(parseRoutes(MERGING), { ignoreNoise: true }), normalizeRoutes(parseRoutes(leaked), { ignoreNoise: true }))
  assert.deepEqual(added, ['inet 192.0.2.77 127.0.0.1 UGHS lo0'])
  assert.deepEqual(removed, [])
  const helperOff = RESTORED.replace(/^(0\/1|128\.0\/1|::\/1|8000::\/1) .*\n/gm, '')
  const off = diffLines(normalizeRoutes(parseRoutes(MERGING), { ignoreNoise: true }), normalizeRoutes(parseRoutes(helperOff), { ignoreNoise: true }))
  assert.equal(off.removed.length, 4) // merging did not come back on
})

test('isNoise and noiseRegex agree on what macOS changes by itself', () => {
  const [u0] = parseRoutes(MERGING).filter((r) => r.dest === 'fe80::%utun0/64')
  assert.ok(isNoise(u0))
  assert.ok(!isNoise(parseRoutes(MERGING).find((r) => r.dest === '::/1')))
  const re = new RegExp(noiseRegex().replaceAll('[[:space:]]', '\\s'))
  for (const line of ['fe80::%utun0/64  fe80::8c37%utun0  UcI  utun0', 'default  fe80::%utun5  UGcIg  utun5', 'utun4', 'awdl0']) {
    assert.match(line, re, line)
  }
  for (const line of ['::/1  utun7  US2cg  utun7', '0/1  utun8  US2c  utun8', 'feth10', 'en0', '198.18.0.1  198.18.0.1  UH  utun8']) {
    assert.doesNotMatch(line, re, line)
  }
})

test('parsePipes reads dnctl pipe numbers', () => {
  assert.deepEqual(parsePipes('07711:  20.000 Mbit/s   10 ms  100 sl. 1 queues\n    mask: 0x00\n00042:  1.000 Mbit/s\n'), [7711, 42])
})

test('harnessLeftovers lists everything netsim and the tests could leave behind', () => {
  assert.deepEqual(harnessLeftovers({}), [])
  const found = harnessLeftovers({
    ifaces: 'lo0 en0 feth10 feth21 feth0 utun3',
    lo0: 'lo0: flags\n\tinet 127.0.0.1 netmask 0xff000000\n\tinet 10.77.99.1 netmask 0xffffffff\n\tinet6 2001:db8:77:99::1 prefixlen 128\n',
    routes: 'Internet:\nDestination Gateway Flags Netif Expire\n198.51.100.10 10.77.1.1 UGHS feth10\n192.0.2.77 127.0.0.1 UGHS lo0\n127 127.0.0.1 UCS lo0\n',
    pipes: '07711: 20.000 Mbit/s\n00042: 1.000 Mbit/s\n07782: 1 Mbit/s\n07792: 1 Mbit/s\n',
    anchor: 'rdr on feth11 inet proto tcp from any to 198.51.100.10 port = 80 -> 10.77.99.1 port 8081\n',
    neighbors: '? (10.77.1.1) at 1:2:3:4:5:6 on feth10 ifscope permanent [ethernet]\n? (192.168.1.1) at f4:e8 on en0\n'
  })
  assert.deepEqual(found, [
    'interface feth10',
    'interface feth21',
    'lo0 address 10.77.99.1',
    'lo0 address 2001:db8:77:99::1',
    'route 198.51.100.10 via 10.77.1.1 on feth10',
    'route 192.0.2.77 via 127.0.0.1 on lo0',
    'dummynet pipe 7711',
    'dummynet pipe 7782',
    'pf anchor com.apple/mergelane-netsim: rdr on feth11 inet proto tcp from any to 198.51.100.10 port = 80 -> 10.77.99.1 port 8081',
    'neighbour entry: ? (10.77.1.1) at 1:2:3:4:5:6 on feth10 ifscope permanent [ethernet]'
  ])
})

test("harnessLeftovers flags the go suite's lo0 aliases unless they were there before", () => {
  const lo0 = 'lo0: flags\n\tinet 127.0.0.1 netmask 0xff000000\n\tinet 127.0.0.2 netmask 0xff000000\n\tinet 127.0.0.3 netmask 0xff000000\n'
  assert.deepEqual(harnessLeftovers({ lo0 }), ['lo0 address 127.0.0.2', 'lo0 address 127.0.0.3'])
  assert.deepEqual(harnessLeftovers({ lo0, lo0Before: '127.0.0.3 ' }), ['lo0 address 127.0.0.2'])
  assert.deepEqual(harnessLeftovers({ lo0, lo0Before: '127.0.0.2 127.0.0.3' }), [])
})

test('the manifest round-trips and helperDiff names what changed', () => {
  const before = parseManifest('plist=present\nplist_sha=abc\nbinary=present\nbinary_sha=def\nloaded=yes\nmerge=on\ndisabled=enabled\nnote = a=b\n\n')
  assert.equal(before.note, 'a=b')
  assert.deepEqual(helperDiff(before, { ...before }), [])
  assert.deepEqual(helperDiff({ ...before, disabled: '' }, before), []) // launchd's default either way
  assert.deepEqual(helperDiff(before, { ...before, disabled: 'disabled' }), ['disabled: was enabled, now disabled'])
  assert.deepEqual(helperDiff(before, { ...before, merge: 'off', binary_sha: '' }), [
    'binary_sha: was def, now (none)',
    'merge: was on, now off'
  ])
})

test('summarize formats the table and counts failures', () => {
  const { text, failed } = summarize('netsim|PASS|75|\ndaemon|FAIL|430|3 checks failed\n\napp|SKIP||not selected\n')
  assert.equal(failed, 1)
  assert.equal(text.split('\n').length, 3)
  assert.match(text, /^PASS  netsim\s+1m15s$/m)
  assert.match(text, /^FAIL  daemon\s+7m10s  3 checks failed$/m)
  assert.match(text, /^SKIP  app\s+0s  not selected$/m)
})

test('cli: every command, with exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-root-lib-'))
  try {
    const f = (name, text) => {
      writeFileSync(join(dir, name), text)
      return join(dir, name)
    }
    const lines = []
    const run = (...argv) => cli(argv, (l) => lines.push(l))
    const merging = f('merging', MERGING)
    const vpn = f('vpn', VPN)
    const scutilNone = f('scutil-none', 'Available network connection services in the current set (*=enabled):\n')
    const scutilUp = f('scutil-up', '* (Connected) 1234 VPN (IKEv2) "Work" [VPN/IKEv2]\n')

    assert.equal(run('vpn', merging, scutilNone), 0)
    assert.equal(run('vpn', vpn, scutilNone), 1)
    assert.equal(run('vpn', merging, scutilUp), 1)
    assert.match(lines.at(-1), /^VPN service: .*Work/)

    assert.equal(run('overlaps', f('ifc', 'en0:\n\tinet 10.77.1.2 netmask 0xffffff00\n'), merging), 1)
    assert.equal(run('overlaps', f('ifc2', 'en0:\n\tinet 192.168.1.7\n'), merging), 0)

    assert.equal(run('marked', merging), 1)
    assert.equal(run('marked', vpn), 0)

    lines.length = 0
    assert.equal(run('helper-iface', merging), 0)
    assert.deepEqual(lines, ['utun7'])

    assert.equal(run('compare', merging, f('restored', RESTORED), '--ignore-noise'), 0)
    assert.equal(run('compare', merging, join(dir, 'restored')), 1)

    const clean = join(dir, 'clean')
    const dirty = join(dir, 'dirty')
    for (const d of [clean, dirty]) rmSync(d, { recursive: true, force: true })
    f('ifaces-only', '')
    writeFileSync(join(dir, 'ifaces'), 'lo0 en0')
    assert.equal(run('leftovers', dir), 0) // files that are missing count as empty
    writeFileSync(join(dir, 'ifaces'), 'lo0 feth10')
    assert.equal(run('leftovers', dir), 1)
    writeFileSync(join(dir, 'ifaces'), 'lo0')
    writeFileSync(join(dir, 'lo0'), '\tinet 127.0.0.2 netmask 0xff000000\n')
    assert.equal(run('leftovers', dir), 1)
    writeFileSync(join(dir, 'lo0-before'), '127.0.0.2 ')
    assert.equal(run('leftovers', dir), 0)

    const m1 = f('m1', 'merge=on\nloaded=yes\n')
    assert.equal(run('helper-diff', m1, f('m2', 'merge=on\nloaded=yes\n')), 0)
    assert.equal(run('helper-diff', m1, f('m3', 'merge=off\nloaded=yes\n')), 1)

    assert.equal(run('summary', f('ok', 'a|PASS|1|\n')), 0)
    assert.equal(run('summary', f('bad', 'a|FAIL|1|\n')), 1)

    lines.length = 0
    assert.equal(run('noise-regex'), 0)
    assert.equal(lines[0], noiseRegex())
    assert.equal(run('nope'), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
