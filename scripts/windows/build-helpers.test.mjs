// Tests for the Windows helpers' build script, with a stand-in for go. Run: node --test
// --experimental-test-coverage --test-coverage-include='scripts/windows/build-helpers.mjs'
// scripts/windows/build-helpers.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { HELPERS, WINTUN, appVersion, binDir, buildHelpers, fetchWintun, main, parseArgs } from './build-helpers.mjs'
import { UsageError } from './kit.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'mergelane-build-helpers-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function fakeRoot(version = '1.2.3') {
  const root = mkdtempSync(join(scratch, 'root-'))
  mkdirSync(join(root, 'app'))
  mkdirSync(join(root, 'daemon'))
  writeFileSync(join(root, 'app', 'package.json'), JSON.stringify({ version }))
  return root
}

function fakeGo({ fail = false } = {}) {
  const calls = []
  const runner = async (file, args, options) => {
    calls.push({ file, args, options })
    if (fail) return { code: 1, stdout: '', stderr: 'undefined: platform.IsAdmin\n' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

function capture() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (chunk) => (text += chunk))
  return { stream, text: () => text }
}

describe('parseArgs', () => {
  it('builds both chips by default, each chip once', () => {
    assert.deepEqual(parseArgs([]).arches, ['x64', 'arm64'])
    assert.deepEqual(parseArgs(['--arch', 'arm64', '--arch', 'arm64']).arches, ['arm64'])
  })

  it('refuses anything else', () => {
    assert.throws(() => parseArgs(['--arch']), UsageError)
    assert.throws(() => parseArgs(['--arch', 'ia32']), /unknown --arch ia32/)
    assert.throws(() => parseArgs(['--out', 'x']), /unknown argument: --out/)
  })
})

describe('buildHelpers', () => {
  it('cross-compiles each helper for each chip into daemon/bin/win-<arch>, with the app version', async () => {
    const root = fakeRoot('0.4.0')
    const { runner, calls } = fakeGo()
    const logged = []
    const built = await buildHelpers({ root, arches: ['x64', 'arm64'], runner, log: (l) => logged.push(l) })
    assert.equal(appVersion(root), '0.4.0')
    assert.deepEqual(built, [
      join(binDir(root, 'x64'), 'mergelane-daemon.exe'),
      join(binDir(root, 'x64'), 'mergelane-nmhost.exe'),
      join(binDir(root, 'arm64'), 'mergelane-daemon.exe'),
      join(binDir(root, 'arm64'), 'mergelane-nmhost.exe')
    ])
    assert.equal(calls.length, HELPERS.length * 2)
    const first = calls[0]
    assert.equal(first.file, 'go')
    assert.deepEqual(first.args, [
      'build',
      '-trimpath',
      '-ldflags',
      '-X main.version=0.4.0',
      '-o',
      join(root, 'daemon', 'bin', 'win-x64', 'mergelane-daemon.exe'),
      './cmd/mergelane-daemon'
    ])
    assert.equal(first.options.cwd, join(root, 'daemon'))
    assert.equal(first.options.env.GOOS, 'windows')
    assert.equal(first.options.env.GOARCH, 'amd64')
    assert.equal(first.options.env.CGO_ENABLED, '0')
    assert.equal(calls[2].options.env.GOARCH, 'arm64')
    assert.deepEqual(logged.slice(0, 2), ['building x64 mergelane-daemon.exe', 'building x64 mergelane-nmhost.exe'])
  })

  it("throws with the compiler's output when a build fails", async () => {
    const { runner } = fakeGo({ fail: true })
    await assert.rejects(
      buildHelpers({ root: fakeRoot(), arches: ['x64'], runner }),
      /go build mergelane-daemon for x64 failed:\nundefined: platform.IsAdmin/
    )
  })
})

describe('main', () => {
  it('lists the files it built and exits 0', async () => {
    const out = capture()
    const { runner } = fakeGo()
    const fetched = []
    const fetch = async ({ arches, root }) => {
      fetched.push({ arches, root })
      return [join(binDir(root, 'x64'), 'wintun.dll')]
    }
    const root = fakeRoot()
    const code = await main(['--arch', 'x64'], { stdout: out.stream, stderr: capture().stream, root, runner, fetch })
    assert.equal(code, 0)
    assert.match(out.text(), /win-x64[/\\]mergelane-nmhost\.exe/)
    assert.match(out.text(), /win-x64[/\\]wintun\.dll/)
    assert.deepEqual(fetched, [{ arches: ['x64'], root }])
  })

  it('exits 1 when a build fails and 2 for wrong usage', async () => {
    const err = capture()
    const { runner } = fakeGo({ fail: true })
    const fetch = async () => assert.fail('Wintun is fetched only after the helpers built')
    assert.equal(await main([], { stdout: capture().stream, stderr: err.stream, root: fakeRoot(), runner, fetch }), 1)
    assert.match(err.text(), /build-helpers: go build/)
    const usage = capture()
    assert.equal(await main(['--x'], { stdout: capture().stream, stderr: usage.stream }), 2)
    assert.match(usage.text(), /usage: node scripts\/windows\/build-helpers\.mjs/)
  })
})

describe('fetchWintun', () => {
  const MACHINE = { x64: 0x8664, arm64: 0xaa64 }

  /** A stand-in Windows DLL for a chip: an MZ header pointing at a PE header with its machine type. */
  function fakeDll(file, chip) {
    mkdirSync(dirname(file), { recursive: true })
    const bytes = Buffer.alloc(96)
    bytes.write('MZ', 0, 'latin1')
    bytes.writeUInt32LE(64, 0x3c)
    bytes.write('PE\0\0', 64, 'latin1')
    bytes.writeUInt16LE(MACHINE[chip], 68)
    writeFileSync(file, bytes)
  }

  /** A zip that is just some bytes, pinned by their hash, and an unzip that lays out wintun's folders. */
  function stand(chips = { x64: 'x64', arm64: 'arm64' }) {
    const zipBytes = 'stand-in wintun zip'
    const pin = { ...WINTUN, sha256: createHash('sha256').update(zipBytes).digest('hex') }
    const downloads = []
    const download = async (url, dest) => {
      downloads.push(url)
      writeFileSync(dest, zipBytes)
    }
    const unzip = async (_zip, dir) => {
      for (const [arch, chip] of Object.entries(chips)) fakeDll(join(dir, pin.dll[arch]), chip)
      writeFileSync(join(dir, pin.license), 'Prebuilt Binaries License')
    }
    return { pin, download, downloads, unzip }
  }

  it('pins wintun.net\'s published hash and each chip\'s DLL', () => {
    assert.equal(WINTUN.url, 'https://www.wintun.net/builds/wintun-0.14.1.zip')
    assert.match(WINTUN.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(Object.keys(WINTUN.dll).sort(), ['arm64', 'x64'])
  })

  it('downloads once, then puts each chip\'s DLL and the licence beside its helpers', async () => {
    const root = fakeRoot()
    const { pin, download, downloads, unzip } = stand()
    const written = await fetchWintun({ root, arches: ['x64', 'arm64'], pin, download, unzip })
    assert.deepEqual(written, [
      join(binDir(root, 'x64'), 'wintun.dll'),
      join(binDir(root, 'x64'), 'wintun-LICENSE.txt'),
      join(binDir(root, 'arm64'), 'wintun.dll'),
      join(binDir(root, 'arm64'), 'wintun-LICENSE.txt')
    ])
    assert.equal(readFileSync(join(binDir(root, 'arm64'), 'wintun-LICENSE.txt'), 'utf8'), 'Prebuilt Binaries License')
    assert.deepEqual(downloads, [WINTUN.url])
    // The zip is kept, and a second run uses it.
    await fetchWintun({ root, arches: ['x64'], pin, download, unzip })
    assert.deepEqual(downloads, [WINTUN.url])
  })

  it('refuses and deletes a download whose hash isn\'t the pinned one', async () => {
    const root = fakeRoot()
    const { download, unzip } = stand()
    const pin = { ...WINTUN, sha256: 'a'.repeat(64) }
    await assert.rejects(fetchWintun({ root, arches: ['x64'], pin, download, unzip }), /not the pinned a{64}/)
    assert.equal(existsSync(join(root, 'daemon', 'bin', `wintun-${pin.version}.zip`)), false)
  })

  it('refuses a DLL built for the other chip', async () => {
    const root = fakeRoot()
    const { pin, download, unzip } = stand({ x64: 'x64', arm64: 'x64' })
    await assert.rejects(
      fetchWintun({ root, arches: ['arm64'], pin, download, unzip }),
      /wintun\/bin\/arm64\/wintun\.dll is built for x64, not arm64/
    )
  })
})
