// Tests for the Windows helpers' build script, with a stand-in for go. Run: node --test
// --experimental-test-coverage --test-coverage-include='scripts/windows/build-helpers.mjs'
// scripts/windows/build-helpers.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { HELPERS, appVersion, binDir, buildHelpers, main, parseArgs } from './build-helpers.mjs'
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
    const code = await main(['--arch', 'x64'], { stdout: out.stream, stderr: capture().stream, root: fakeRoot(), runner })
    assert.equal(code, 0)
    assert.match(out.text(), /win-x64[/\\]mergelane-nmhost\.exe/)
  })

  it('exits 1 when a build fails and 2 for wrong usage', async () => {
    const err = capture()
    const { runner } = fakeGo({ fail: true })
    assert.equal(await main([], { stdout: capture().stream, stderr: err.stream, root: fakeRoot(), runner }), 1)
    assert.match(err.text(), /build-helpers: go build/)
    const usage = capture()
    assert.equal(await main(['--x'], { stdout: capture().stream, stderr: usage.stream }), 2)
    assert.match(usage.text(), /usage: node scripts\/windows\/build-helpers\.mjs/)
  })
})
