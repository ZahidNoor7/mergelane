// Tests for fetch.mjs against a local HTTP server, with tiny Mach-O fixtures built by clang: no network.
// The build-from-source path runs fake build scripts that unpack a prebuilt fixture: no real compile.
// Run: node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/fetch.mjs' \
//        scripts/media-tools/fetch.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  archsOf,
  DEFAULT_MANIFEST,
  DEFAULT_OUT_DIR,
  download,
  downloadWithRetries,
  extract,
  fetchAll,
  fetchTool,
  INSTALL_KINDS,
  peMachineOf,
  programName,
  targetOf,
  isTransient,
  loadManifest,
  main,
  REQUIRED_FIELDS,
  sha256File,
  stampPath,
  treeHash,
  urlProblem,
  validateManifest
} from './fetch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FETCH = join(HERE, 'fetch.mjs')
const hashOf = (data) => createHash('sha256').update(data).digest('hex')
const quiet = { log: () => {}, error: () => {} }

let root // everything the tests create lives here and is removed in after()
let manifestDir
let base // http://127.0.0.1:<port>
const bodies = {}
const hits = {}

function compile(arch, out) {
  execFileSync('/usr/bin/clang', ['-arch', arch, '-x', 'c', '-', '-o', out], {
    input: 'int main(void) { return 0; }\n'
  })
}

/** A valid tool entry for the arm64 fixture, with overrides. */
function tool(overrides = {}) {
  return {
    name: 'tiny',
    version: '1.0.0',
    install: 'file',
    url: `${base}/arm64`,
    sha256: hashOf(bodies.arm64),
    archive: 'none',
    license: 'MIT',
    licenseUrl: 'https://example.invalid/LICENSE',
    licenseFiles: ['licenses/tiny/LICENSE'],
    sourceUrl: 'https://example.invalid/tiny-1.0.0.tar.gz',
    ...overrides
  }
}

/** A valid folder install: the folder fixture's zip, with overrides. */
function folderTool(overrides = {}) {
  const { url, sha256, archive, licenseFiles, ...common } = tool()
  return {
    ...common,
    install: 'folder',
    url: `${base}/folder.zip`,
    sha256: hashOf(bodies.folderZip),
    archive: 'zip',
    executable: 'prog',
    licenseFiles,
    ...overrides
  }
}

/** A valid build install: the arm64 fixture tarball, built by build-ok.sh, with overrides. */
function buildTool(overrides = {}) {
  const { url, sha256, archive, ...common } = tool()
  return {
    ...common,
    install: 'build',
    buildScript: 'build-ok.sh',
    sourceUrl: `${base}/tool.tar.gz`,
    sourceSha256: hashOf(bodies.tar),
    ...overrides
  }
}

const freshOut = () => mkdtempSync(join(root, 'out-'))
/** The fake build scripts that have run so far, in order. */
const buildRuns = () =>
  existsSync(join(manifestDir, 'runs.log'))
    ? readFileSync(join(manifestDir, 'runs.log'), 'utf8').trim().split('\n')
    : []
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const mode = (path) => statSync(path).mode & 0o777

let server
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'media-tools-test-'))
  const build = join(root, 'build')
  mkdirSync(join(build, 'pkg', 'bin'), { recursive: true })

  // Mach-O fixtures: the real check is lipo, so they must be real executables.
  compile('arm64', join(build, 'pkg', 'bin', 'tool'))
  compile('x86_64', join(build, 'x86_64'))
  bodies.arm64 = readFileSync(join(build, 'pkg', 'bin', 'tool'))
  bodies.x86_64 = readFileSync(join(build, 'x86_64'))
  bodies.text = Buffer.from('not an executable\n')

  // Archives, made with the same macOS tools fetch.mjs extracts with.
  execFileSync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    join(build, 'pkg'),
    join(build, 'tool.zip')
  ])
  execFileSync('/usr/bin/tar', ['-czf', join(build, 'tool.tar.gz'), '-C', build, 'pkg'])
  bodies.zip = readFileSync(join(build, 'tool.zip'))
  bodies.tar = readFileSync(join(build, 'tool.tar.gz'))
  // Deno's release zip holds the program alone, at its top level.
  mkdirSync(join(build, 'deno-zip'))
  compile('arm64', join(build, 'deno-zip', 'deno'))
  bodies.deno = readFileSync(join(build, 'deno-zip', 'deno'))
  execFileSync('/usr/bin/ditto', [
    '-c',
    '-k',
    join(build, 'deno-zip', 'deno'),
    join(build, 'deno.zip')
  ])
  bodies.denoZip = readFileSync(join(build, 'deno.zip'))

  // An archive whose "executable" sits behind a symlink that leads out of the archive.
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'tool'), bodies.arm64)
  mkdirSync(join(build, 'evil'))
  symlinkSync(outside, join(build, 'evil', 'link'))
  execFileSync('/usr/bin/tar', ['-czf', join(build, 'evil.tar.gz'), '-C', build, 'evil'])
  bodies.evil = readFileSync(join(build, 'evil.tar.gz'))

  // A folder program, as yt-dlp's unpacked build: the program and its files at the archive's top
  // level, with a link that stays inside.
  const folder = join(build, 'folder')
  mkdirSync(join(folder, '_internal'), { recursive: true })
  compile('arm64', join(folder, 'prog'))
  compile('arm64', join(folder, '_internal', 'Python'))
  writeFileSync(join(folder, '_internal', 'data.txt'), 'data\n')
  symlinkSync('data.txt', join(folder, '_internal', 'current'))
  execFileSync('/usr/bin/ditto', ['-c', '-k', folder, join(build, 'folder.zip')])
  bodies.folderZip = readFileSync(join(build, 'folder.zip'))
  // The same with an x86_64 program, and with entries that must never be copied into the app.
  const variant = (name, change) => {
    const dir = join(build, name)
    execFileSync('/bin/cp', ['-R', folder, dir])
    change(dir)
    execFileSync('/usr/bin/tar', ['-czf', join(build, `${name}.tar.gz`), '-C', dir, '.'], {
      stdio: 'ignore'
    })
    return readFileSync(join(build, `${name}.tar.gz`))
  }
  bodies.folderX86 = variant('folder-x86', (dir) => compile('x86_64', join(dir, 'prog')))
  bodies.folderOut = variant('folder-out', (dir) =>
    symlinkSync(outside, join(dir, '_internal', 'out'))
  )
  bodies.folderDangling = variant('folder-dangling', (dir) =>
    symlinkSync('nothing-here', join(dir, '_internal', 'dangling'))
  )
  bodies.folderFifo = variant('folder-fifo', (dir) =>
    execFileSync('/usr/bin/mkfifo', [join(dir, '_internal', 'pipe')])
  )

  // A framework whose links the archive stored as copies (as `zip -r` without -y does with
  // yt-dlp's Python.framework), one that kept its links, and one whose "copy" differs.
  const flat = join(build, 'folder-flat')
  execFileSync('/bin/cp', ['-R', folder, flat])
  const fw = join(flat, '_internal', 'Lib.framework')
  mkdirSync(join(fw, 'Versions', '1', 'Resources'), { recursive: true })
  compile('arm64', join(fw, 'Versions', '1', 'Lib'))
  writeFileSync(join(fw, 'Versions', '1', 'Resources', 'Info.plist'), '<plist/>\n')
  execFileSync('/bin/cp', ['-R', join(fw, 'Versions', '1'), join(fw, 'Versions', 'Current')])
  execFileSync('/bin/cp', [join(fw, 'Versions', '1', 'Lib'), join(fw, 'Lib')])
  execFileSync('/bin/cp', ['-R', join(fw, 'Versions', '1', 'Resources'), join(fw, 'Resources')])
  execFileSync('/usr/bin/ditto', ['-c', '-k', flat, join(build, 'folder-flat.zip')])
  bodies.folderFlat = readFileSync(join(build, 'folder-flat.zip'))
  bodies.folderLinked = variant('folder-linked', (dir) => {
    const lib = join(dir, '_internal', 'Lib.framework')
    mkdirSync(join(lib, 'Versions', '1', 'Resources'), { recursive: true })
    compile('arm64', join(lib, 'Versions', '1', 'Lib'))
    symlinkSync('1', join(lib, 'Versions', 'Current'))
    symlinkSync('Versions/Current/Lib', join(lib, 'Lib'))
    symlinkSync('Versions/Current/Resources', join(lib, 'Resources'))
  })
  bodies.folderChanged = variant('folder-changed', (dir) => {
    execFileSync('/bin/cp', ['-R', join(fw), join(dir, '_internal', 'Lib.framework')])
    writeFileSync(join(dir, '_internal', 'Lib.framework', 'Lib'), 'not the same\n')
  })

  // A "source tarball" for the fake build scripts: the arm64 fixture (bodies.tar), or an x86_64 one.
  mkdirSync(join(build, 'x86src', 'pkg', 'bin'), { recursive: true })
  compile('x86_64', join(build, 'x86src', 'pkg', 'bin', 'tool'))
  execFileSync('/usr/bin/tar', [
    '-czf',
    join(build, 'x86src.tar.gz'),
    '-C',
    join(build, 'x86src'),
    'pkg'
  ])
  bodies.x86src = readFileSync(join(build, 'x86src.tar.gz'))

  // Windows programs (W3): only their PE header matters to fetch.mjs, so a stub with the header is enough.
  const pe = (machine) => {
    const body = Buffer.alloc(0x48)
    body.write('MZ', 0, 'latin1')
    body.writeUInt32LE(0x40, 0x3c)
    body.write('PE\0\0', 0x40, 'latin1')
    body.writeUInt16LE(machine, 0x44)
    return body
  }
  bodies.peX64 = pe(0x8664)
  bodies.peArm64 = pe(0xaa64)
  bodies.peOdd = pe(0x1c4)
  bodies.mzOnly = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(0x46)])
  mkdirSync(join(build, 'winsrc', 'pkg', 'bin'), { recursive: true })
  writeFileSync(join(build, 'winsrc', 'pkg', 'bin', 'tool'), bodies.peX64)
  execFileSync('/usr/bin/tar', [
    '-czf',
    join(build, 'winsrc.tar.gz'),
    '-C',
    join(build, 'winsrc'),
    'pkg'
  ])
  bodies.winsrc = readFileSync(join(build, 'winsrc.tar.gz'))
  bodies.inputA = Buffer.from('cross-compiler\n')
  bodies.inputB = Buffer.from('zlib\n')

  manifestDir = join(root, 'manifest')
  mkdirSync(join(manifestDir, 'licenses', 'tiny'), { recursive: true })
  writeFileSync(join(manifestDir, 'licenses', 'tiny', 'LICENSE'), 'tiny licence text\n')
  // Fake build scripts, run by fetch.mjs as `/bin/bash <script> <tarball> <out-dir>`. Each run is
  // logged next to the script, so a test can tell whether it ran at all.
  const script = (name, body) =>
    writeFileSync(
      join(manifestDir, name),
      `#!/bin/bash\nset -eu\necho "${name}" >> "\${0%/*}/runs.log"\n${body}\n`
    )
  script(
    'build-ok.sh',
    [
      'echo "configuring with TMPDIR=$TMPDIR"',
      'echo "compiling" >&2',
      'work=$(mktemp -d "$TMPDIR/fake-build.XXXXXX")',
      'tar -xf "$1" -C "$work"',
      'mkdir -p "$2"',
      'cp "$work/pkg/bin/tool" "$2/tiny"'
    ].join('\n')
  )
  script(
    'build-fail.sh',
    [
      'mkdir -p "$2"',
      'printf partial > "$2/tiny"',
      'for i in $(seq 1 30); do echo "line $i"; done',
      'echo "error: the compiler gave up" >&2',
      'exit 3'
    ].join('\n')
  )
  script('build-nothing.sh', 'echo "nothing to do"')
  // A Windows build: writes <name>.exe, and notes its arguments after the tarball and out folder.
  script(
    'build-win.sh',
    [
      'work=$(mktemp -d "$TMPDIR/fake-build.XXXXXX")',
      'tar -xf "$1" -C "$work"',
      'mkdir -p "$2"',
      'cp "$work/pkg/bin/tool" "$2/tiny.exe"',
      'shift 2',
      'for arg in "$@"; do echo "$(basename "$arg"):$(cat "$arg" 2>/dev/null || echo -)"; done > "${0%/*}/win-args.log"'
    ].join('\n')
  )
  script('build-killed.sh', 'kill -KILL $$')

  const routes = {
    '/arm64': (res) => res.end(bodies.arm64),
    '/x86_64': (res) => res.end(bodies.x86_64),
    '/text': (res) => res.end(bodies.text),
    '/tool.zip': (res) => res.end(bodies.zip),
    '/tool.tar.gz': (res) => res.end(bodies.tar),
    '/deno.zip': (res) => res.end(bodies.denoZip),
    '/evil.tar.gz': (res) => res.end(bodies.evil),
    '/folder.zip': (res) => res.end(bodies.folderZip),
    '/folder-flat.zip': (res) => res.end(bodies.folderFlat),
    '/folder-linked.tar.gz': (res) => res.end(bodies.folderLinked),
    '/folder-changed.tar.gz': (res) => res.end(bodies.folderChanged),
    '/folder-x86.tar.gz': (res) => res.end(bodies.folderX86),
    '/folder-out.tar.gz': (res) => res.end(bodies.folderOut),
    '/folder-dangling.tar.gz': (res) => res.end(bodies.folderDangling),
    '/folder-fifo.tar.gz': (res) => res.end(bodies.folderFifo),
    '/x86src.tar.gz': (res) => res.end(bodies.x86src),
    '/pe-x64': (res) => res.end(bodies.peX64),
    '/pe-arm64': (res) => res.end(bodies.peArm64),
    '/winsrc.tar.gz': (res) => res.end(bodies.winsrc),
    '/input-a': (res) => res.end(bodies.inputA),
    '/input-b': (res) => res.end(bodies.inputB),
    // A relative redirect, then an absolute one, as GitHub's release downloads do.
    '/hop1': (res) => res.writeHead(302, { location: '/hop2' }).end(),
    '/hop2': (res) => res.writeHead(301, { location: `${base}/arm64` }).end(),
    '/loop': (res) => res.writeHead(302, { location: '/loop' }).end(),
    '/no-location': (res) => res.writeHead(302).end(),
    '/offsite': (res) => res.writeHead(307, { location: 'http://example.invalid/tool' }).end(),
    '/hang': () => {},
    // Fail the first time, as ffmpeg.org sometimes does: the connection is cut, or a server error.
    '/flaky-reset': (res) =>
      hits['/flaky-reset'] === 1 ? res.socket.destroy() : res.end(bodies.arm64),
    '/flaky-503': (res) =>
      hits['/flaky-503'] === 1 ? res.writeHead(503).end('busy') : res.end(bodies.arm64),
    '/always-503': (res) => res.writeHead(503).end('busy'),
    '/stall': (res) => {
      res.writeHead(200)
      res.write(bodies.arm64.subarray(0, 16))
    }
  }
  server = createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1
    const route = routes[req.url]
    if (route) route(res)
    else res.writeHead(404).end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

describe('the committed manifest', () => {
  test('is valid, uses https, and its licence texts are committed', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST)
    assert.deepEqual(
      manifest.tools.map((t) => t.name),
      ['yt-dlp', 'ffmpeg', 'deno']
    )
    assert.deepEqual(
      manifest.tools.map((t) => t.install),
      ['folder', 'build', 'file']
    )
    for (const t of manifest.tools) {
      for (const url of [t.url, t.sourceUrl].filter(Boolean)) {
        assert.ok(url.startsWith('https://'), url)
      }
      for (const file of t.licenseFiles) {
        assert.ok(existsSync(join(HERE, file)), `${t.name}: ${file} is not committed`)
      }
    }
  })

  test('installs into app/resources/bin by default', () => {
    assert.ok(DEFAULT_OUT_DIR.endsWith(join('app', 'resources', 'bin')), DEFAULT_OUT_DIR)
  })
})

describe('FFmpeg, built from its source release (ADR-0028)', () => {
  const pinned = async () =>
    (await loadManifest(DEFAULT_MANIFEST)).tools.find((entry) => entry.name === 'ffmpeg')

  test('is pinned to ffmpeg.org’s signed 9.0.2 tarball and built by build-ffmpeg.sh', async () => {
    const ffmpeg = await pinned()
    assert.equal(ffmpeg.version, '9.0.2')
    assert.equal(ffmpeg.install, 'build')
    // The values checked on 2026-11-11: 12,040,788 bytes, "Good signature" from the key that
    // ffmpeg.org's download page publishes.
    assert.equal(ffmpeg.sourceUrl, 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz')
    assert.equal(
      ffmpeg.sourceSha256,
      '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
    )
    assert.equal(ffmpeg.signatureUrl, `${ffmpeg.sourceUrl}.asc`)
    assert.equal(ffmpeg.signingKey, 'FCF986EA15E6E293A5644F10B4322F04D67658D8')
    assert.equal(ffmpeg.buildScript, 'build-ffmpeg.sh')
    assert.ok(existsSync(join(HERE, ffmpeg.buildScript)))
    // Nothing is downloaded but the source: no prebuilt program.
    assert.equal(ffmpeg.url, undefined)
  })

  test('is LGPL 2.1 or later: the build asks for nothing that would change that', async () => {
    const ffmpeg = await pinned()
    assert.match(ffmpeg.license, /^LGPL-2\.1-or-later\b/)
    assert.deepEqual(ffmpeg.licenseFiles, [
      'licenses/ffmpeg/LICENSE.md',
      'licenses/ffmpeg/COPYING.LGPLv2.1'
    ])
    const lgpl = readFileSync(join(HERE, 'licenses', 'ffmpeg', 'COPYING.LGPLv2.1'), 'utf8')
    assert.match(lgpl, /^\s+GNU LESSER GENERAL PUBLIC LICENSE\n\s+Version 2\.1, February 1999\n/)
    const license = readFileSync(join(HERE, 'licenses', 'ffmpeg', 'LICENSE.md'), 'utf8')
    assert.match(license, /GNU Lesser General Public License version 2\.1\nor later/)
    assert.deepEqual(readdirSync(join(HERE, 'licenses', 'ffmpeg')).sort(), [
      'COPYING.LGPLv2.1',
      'LICENSE.md'
    ])

    // The configure call, from "./configure" to the line before "make".
    const script = readFileSync(join(HERE, ffmpeg.buildScript), 'utf8')
    const configure = script.slice(script.indexOf('./configure'), script.indexOf('\nmake '))
    assert.ok(configure.length > 0)
    for (const flag of ['--enable-gpl', '--enable-version3', '--enable-nonfree']) {
      assert.ok(!configure.includes(flag), flag)
    }
    for (const flag of ['--disable-everything', '--disable-autodetect', '--disable-network']) {
      assert.ok(configure.includes(flag), flag)
    }
    // And the script refuses a result that reports anything but the LGPL.
    assert.ok(script.includes("grep -q 'GNU Lesser General Public'"))
  })
})

describe('yt-dlp, the unpacked macOS build (ADR-0031)', () => {
  test('is pinned to the release’s yt-dlp_macos.zip, installed as a folder', async () => {
    const ytdlp = (await loadManifest(DEFAULT_MANIFEST)).tools.find((t) => t.name === 'yt-dlp')
    const release = `https://github.com/yt-dlp/yt-dlp/releases/download/${ytdlp.version}`
    assert.equal(ytdlp.install, 'folder')
    assert.equal(ytdlp.url, `${release}/yt-dlp_macos.zip`)
    assert.equal(ytdlp.archive, 'zip')
    assert.equal(ytdlp.executable, 'yt-dlp_macos')
    // Its line in the release's SHA2-256SUMS (and GitHub's digest of the upload), 2026-11-11.
    assert.equal(ytdlp.sha256, '20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1')
    assert.equal(ytdlp.checksumSource, `${release}/SHA2-256SUMS`)
    // The licence analysis is unchanged, and so is the source (ADR-0031).
    assert.match(ytdlp.license, /^GPL-3\.0-or-later\b/)
    assert.equal(ytdlp.sourceUrl, `${release}/yt-dlp.tar.gz`)
    assert.match(ytdlp.sourceSha256, /^[0-9a-f]{64}$/)
  })
})

describe('Deno, the JavaScript runtime yt-dlp needs for YouTube', () => {
  const pinned = async () =>
    (await loadManifest(DEFAULT_MANIFEST)).tools.find((entry) => entry.name === 'deno')

  test('is pinned to the publisher’s checksums of the arm64 zip and of the program in it', async () => {
    const deno = await pinned()
    const release = `https://github.com/denoland/deno/releases/download/v${deno.version}`
    assert.match(deno.version, /^\d+\.\d+\.\d+$/)
    assert.equal(deno.url, `${release}/deno-aarch64-apple-darwin.zip`)
    assert.equal(deno.archive, 'zip')
    assert.equal(deno.archivePath, 'deno')
    // The zip's hash is in deno-aarch64-apple-darwin.zip.sha256sum, the program's in
    // deno-aarch64-apple-darwin.sha256sum: both published with the release.
    assert.equal(deno.checksumSource, `${release}/deno-aarch64-apple-darwin.zip.sha256sum`)
    assert.equal(deno.binaryChecksumSource, `${release}/deno-aarch64-apple-darwin.sha256sum`)
    assert.match(deno.sha256, /^[0-9a-f]{64}$/)
    assert.match(deno.binarySha256, /^[0-9a-f]{64}$/)
    assert.notEqual(deno.sha256, deno.binarySha256)
  })

  test('is MIT: its licence text and the notices of what is built into it are committed, and there is no source to attach', async () => {
    const deno = await pinned()
    assert.equal(deno.license, 'MIT')
    // THIRD-PARTY-NOTICES.txt: V8, TypeScript, the Rust crates and the rest (deno-notices.mjs, ADR-0029).
    assert.deepEqual(deno.licenseFiles, [
      'licenses/deno/LICENSE.md',
      'licenses/deno/THIRD-PARTY-NOTICES.txt'
    ])
    const text = readFileSync(join(HERE, 'licenses', 'deno', 'LICENSE.md'), 'utf8')
    assert.match(text, /^MIT License\n\nCopyright 2018-\d{4} the Deno authors\n/)
    const notices = readFileSync(join(HERE, 'licenses', 'deno', 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    assert.match(
      notices,
      new RegExp(`^THIRD-PARTY NOTICES FOR DENO ${deno.version.replaceAll('.', '\\.')}\n`)
    )
    // sources.mjs downloads the source of every tool with a sourceSha256 for each release; an MIT
    // program needs none (ADR-0027).
    assert.equal(deno.sourceSha256, undefined)
    assert.ok(deno.sourceUrl.startsWith('https://github.com/denoland/deno/'), deno.sourceUrl)
  })

  test('installs from a zip that holds the program at its top level, as Deno’s does', async () => {
    const entry = tool({
      name: 'deno',
      url: `${base}/deno.zip`,
      sha256: hashOf(bodies.denoZip),
      archive: 'zip',
      archivePath: 'deno',
      binarySha256: hashOf(bodies.deno)
    })
    const outDir = freshOut()
    assert.equal(await fetchTool(entry, { outDir, manifestDir }), 'installed')
    assert.equal(await sha256File(join(outDir, 'deno')), hashOf(bodies.deno))
    assert.equal(mode(join(outDir, 'deno')), 0o755)
    assert.deepEqual(readdirSync(join(outDir, 'licenses')), ['deno'])
    // Checked on the program's own hash from then on, not downloaded again.
    const before = hits['/deno.zip']
    assert.equal(await fetchTool(entry, { outDir, manifestDir }), 'up-to-date')
    assert.equal(hits['/deno.zip'], before)

    // A zip that matches its pin but holds another program is refused, and nothing is installed.
    const elsewhere = freshOut()
    await assert.rejects(
      fetchTool(
        { ...entry, binarySha256: hashOf('another deno') },
        { outDir: elsewhere, manifestDir }
      ),
      /deno: SHA-256 mismatch for deno in the archive/
    )
    assert.deepEqual(readdirSync(elsewhere), [])
    // And a zip that doesn't match its pin isn't even opened.
    await assert.rejects(
      fetchTool({ ...entry, sha256: hashOf('another zip') }, { outDir: freshOut(), manifestDir }),
      /deno: SHA-256 mismatch for http:\/\/127\.0\.0\.1:\d+\/deno\.zip/
    )
  })
})

describe('manifest validation', () => {
  test('a valid tool has no problems', () => {
    assert.deepEqual(validateManifest({ tools: [tool()] }), [])
  })

  test('every missing field is reported', () => {
    const problems = validateManifest({ tools: [{}] })
    for (const field of REQUIRED_FIELDS) {
      assert.ok(problems.includes(`tools[0]: missing "${field}"`), `${field}: ${problems}`)
    }
  })

  test('an empty or missing tools list and non-object tools are rejected', () => {
    assert.deepEqual(validateManifest(undefined), ['the manifest has no "tools" list'])
    assert.deepEqual(validateManifest({ tools: [] }), ['the manifest has no "tools" list'])
    assert.deepEqual(validateManifest({ tools: [null, []] }), [
      'tools[0] is not an object',
      'tools[1] is not an object'
    ])
  })

  test('bad values are reported with the tool name', () => {
    const problems = validateManifest({
      tools: [
        tool({ name: 'Bad/Name' }),
        tool({ sha256: 'ABC', binarySha256: 'xyz' }),
        tool({ url: 'http://example.com/tool' }),
        tool({ name: 'ftp', url: 'ftp://example.com/tool' }),
        tool({ name: 'nourl', url: 'not a url' }),
        tool({ name: 'fmt', archive: 'rar' }),
        tool({ name: 'zip', archive: 'zip' }),
        tool({ name: 'tar', archive: 'tar', archivePath: '../ffmpeg', binarySha256: hashOf('x') }),
        tool({
          name: 'abs',
          archive: 'zip',
          archivePath: '/usr/bin/true',
          binarySha256: hashOf('x')
        }),
        tool({ name: 'raw', binarySha256: hashOf('other') }),
        tool({ name: 'nolic', licenseFiles: [] }),
        tool({ name: 'badlic', licenseFiles: ['../LICENSE', 7] })
      ]
    })
    const expected = [
      'Bad/Name: "name" must be lowercase letters, digits, ".", "_" or "-"',
      'tiny: "sha256" must be 64 lowercase hex characters',
      'tiny: "binarySha256" must be 64 lowercase hex characters',
      'tiny: the name is used twice',
      'tiny: only https URLs are allowed: http://example.com/tool',
      'ftp: only https URLs are allowed: ftp://example.com/tool',
      'nourl: not a valid URL: "not a url"',
      'fmt: "archive" must be one of: none, zip, tar',
      `zip: missing "archivePath" (the executable's path inside the zip archive)`,
      'zip: missing "binarySha256" (the SHA-256 of the extracted executable)',
      'tar: "archivePath" must be a relative path inside the archive',
      'abs: "archivePath" must be a relative path inside the archive',
      'raw: "binarySha256" must equal "sha256" when there is no archive',
      'nolic: "licenseFiles" must be a non-empty list',
      'badlic: licence file "../LICENSE" must be a path relative to the manifest',
      'badlic: licence file 7 must be a path relative to the manifest'
    ]
    for (const problem of expected)
      assert.ok(problems.includes(problem), `${problem}\nin: ${problems.join('\n')}`)
  })

  test('a folder and a build each need their own fields, and nothing of the others', () => {
    assert.deepEqual(INSTALL_KINDS, ['file', 'folder', 'build'])
    assert.deepEqual(validateManifest({ tools: [folderTool(), buildTool({ name: 'built' })] }), [])
    const problems = validateManifest({
      tools: [
        tool({ name: 'kind', install: 'copy' }),
        tool({ name: 'nofile', url: undefined, sha256: undefined, archive: undefined }),
        folderTool({ name: 'noexe', executable: undefined }),
        folderTool({ name: 'flat', archive: 'none' }),
        folderTool({ name: 'escape', executable: '../prog' }),
        folderTool({ name: 'extra', archivePath: 'prog', binarySha256: hashOf('x') }),
        buildTool({ name: 'nobuild', buildScript: undefined, sourceSha256: undefined }),
        buildTool({ name: 'download', url: `${base}/arm64`, sha256: hashOf('x') }),
        buildTool({ name: 'path', buildScript: '../build.sh' }),
        buildTool({ name: 'hash', sourceSha256: 'XYZ' }),
        buildTool({ name: 'plain', sourceUrl: 'http://example.com/tiny.tar.gz' })
      ]
    })
    const expected = [
      'kind: "install" must be one of: file, folder, build',
      'nofile: missing "url" (needed when "install" is "file")',
      'nofile: missing "sha256" (needed when "install" is "file")',
      'nofile: missing "archive" (needed when "install" is "file")',
      'noexe: missing "executable" (needed when "install" is "folder")',
      'flat: "archive" must be zip or tar when "install" is "folder"',
      'escape: "executable" must be a relative path inside the folder',
      'extra: "archivePath" is not used when "install" is "folder"',
      'extra: "binarySha256" is not used when "install" is "folder"',
      'nobuild: missing "sourceSha256" (needed when "install" is "build")',
      'nobuild: missing "buildScript" (needed when "install" is "build")',
      'download: "url" is not used when "install" is "build"',
      'download: "sha256" is not used when "install" is "build"',
      'path: "buildScript" must be the name of a file next to the manifest',
      'hash: "sourceSha256" must be 64 lowercase hex characters',
      'plain: only https URLs are allowed: http://example.com/tiny.tar.gz'
    ]
    for (const problem of expected)
      assert.ok(problems.includes(problem), `${problem}\nin: ${problems.join('\n')}`)
    assert.equal(problems.length, expected.length, problems.join('\n'))
  })

  test('urls: https anywhere, plain http only on loopback', () => {
    assert.equal(urlProblem('https://github.com/x'), null)
    assert.equal(urlProblem('http://127.0.0.1:9/x'), null)
    assert.equal(urlProblem('http://localhost/x'), null)
    assert.equal(urlProblem('http://[::1]/x'), null)
    assert.match(urlProblem('http://10.0.0.1/x'), /only https/)
  })

  test('loadManifest names unreadable and invalid manifests', async () => {
    await assert.rejects(loadManifest(join(root, 'nope.json')), /cannot read the manifest/)
    const broken = join(root, 'broken.json')
    writeFileSync(broken, '{ not json')
    await assert.rejects(loadManifest(broken), /cannot read the manifest/)
    const invalid = join(root, 'invalid.json')
    writeFileSync(invalid, JSON.stringify({ tools: [{ name: 'x' }] }))
    await assert.rejects(loadManifest(invalid), /invalid manifest .*\n {2}- x: missing "version"/)
  })
})

describe('download', () => {
  test('writes the body with mode 0600 and returns its SHA-256', async () => {
    const dest = join(freshOut(), 'file')
    const result = await download(`${base}/arm64`, dest)
    assert.equal(result.sha256, hashOf(bodies.arm64))
    assert.equal(result.bytes, bodies.arm64.length)
    assert.equal(mode(dest), 0o600)
    assert.equal(await sha256File(dest), hashOf(bodies.arm64))
  })

  test('follows relative and absolute redirects', async () => {
    const result = await download(`${base}/hop1`, join(freshOut(), 'file'))
    assert.equal(result.url, `${base}/arm64`)
    assert.equal(result.sha256, hashOf(bodies.arm64))
  })

  test('refuses redirect loops, redirects without a Location, and plain-http hops', async () => {
    await assert.rejects(download(`${base}/loop`, join(freshOut(), 'f')), /more than 10 redirects/)
    await assert.rejects(
      download(`${base}/hop1`, join(freshOut(), 'f'), { maxRedirects: 1 }),
      /more than 1 redirects/
    )
    await assert.rejects(
      download(`${base}/no-location`, join(freshOut(), 'f')),
      /HTTP 302 without a Location/
    )
    await assert.rejects(
      download(`${base}/offsite`, join(freshOut(), 'f')),
      /only https URLs are allowed/
    )
  })

  test('HTTP errors and silent servers fail', async () => {
    await assert.rejects(download(`${base}/missing`, join(freshOut(), 'f')), /HTTP 404 from/)
    await assert.rejects(
      download(`${base}/hang`, join(freshOut(), 'f'), { timeoutMs: 150 }),
      /no data from .* for 0.15s/
    )
    await assert.rejects(download(`${base}/stall`, join(freshOut(), 'f'), { timeoutMs: 150 }))
  })
})

describe('downloadWithRetries', () => {
  test('a cut connection or a server error is tried again, and the file is complete', async () => {
    for (const path of ['/flaky-reset', '/flaky-503']) {
      const lines = []
      const dest = join(freshOut(), 'file')
      const result = await downloadWithRetries(`${base}${path}`, dest, {
        pauseMs: 0,
        log: (line) => lines.push(line)
      })
      assert.equal(result.sha256, hashOf(bodies.arm64))
      assert.equal(await sha256File(dest), hashOf(bodies.arm64))
      assert.equal(hits[path], 2)
      assert.equal(lines.length, 1)
      assert.match(lines[0], new RegExp(`${path}: .*; trying again in 0s \\(attempt 2 of 3\\)$`))
    }
  })

  test('gives up after the last try, waiting longer each time, and leaves no partial file', async () => {
    const waits = []
    const dir = freshOut()
    const before = hits['/always-503'] ?? 0
    await assert.rejects(
      downloadWithRetries(`${base}/always-503`, join(dir, 'file'), {
        sleep: async (ms) => waits.push(ms)
      }),
      /HTTP 503 from/
    )
    assert.equal(hits['/always-503'] - before, 3)
    assert.deepEqual(waits, [5_000, 10_000])
    assert.deepEqual(readdirSync(dir), [])
  })

  test('a silent server is tried again; a missing file and a refused URL are not', async () => {
    const hangs = hits['/hang'] ?? 0
    await assert.rejects(
      downloadWithRetries(`${base}/hang`, join(freshOut(), 'f'), {
        attempts: 2,
        pauseMs: 0,
        timeoutMs: 150
      }),
      /no data from .* for 0.15s/
    )
    assert.equal(hits['/hang'] - hangs, 2)
    const missing = hits['/missing'] ?? 0
    await assert.rejects(downloadWithRetries(`${base}/missing`, join(freshOut(), 'f')), /HTTP 404/)
    assert.equal(hits['/missing'] - missing, 1)
    await assert.rejects(
      downloadWithRetries('http://10.0.0.1/x', join(freshOut(), 'f')),
      /only https URLs are allowed/
    )
  })

  test('isTransient: network failures, 5xx and 429 are; client errors and others are not', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE']) {
      assert.equal(isTransient(Object.assign(new Error('x'), { code })), true, code)
    }
    for (const statusCode of [500, 503, 429]) assert.equal(isTransient({ statusCode }), true)
    for (const statusCode of [404, 403, 400]) assert.equal(isTransient({ statusCode }), false)
    assert.equal(isTransient(Object.assign(new Error('x'), { code: 'ENOENT' })), false)
    assert.equal(isTransient(new Error('more than 10 redirects')), false)
    assert.equal(isTransient(undefined), false)
  })
})

describe('tools', () => {
  test('archsOf reads Mach-O architectures and rejects other files', async () => {
    const dir = freshOut()
    writeFileSync(join(dir, 'x86'), bodies.x86_64)
    writeFileSync(join(dir, 'text'), bodies.text)
    assert.deepEqual(await archsOf(join(dir, 'x86')), ['x86_64'])
    await assert.rejects(archsOf(join(dir, 'text')), /lipo cannot read .* not a Mach-O executable/)
  })

  test('extract refuses unknown formats', async () => {
    await assert.rejects(extract('a.rar', 'rar', freshOut()), /unknown archive format: rar/)
  })
})

describe('fetchTool', () => {
  test('installs a verified arm64 binary with mode 0755 and its licence', async () => {
    const outDir = freshOut()
    const lines = []
    assert.equal(
      await fetchTool(tool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'installed'
    )
    const installed = join(outDir, 'tiny')
    assert.equal(await sha256File(installed), hashOf(bodies.arm64))
    assert.equal(mode(installed), 0o755)
    assert.equal(
      readFileSync(join(outDir, 'licenses', 'tiny', 'LICENSE'), 'utf8'),
      'tiny licence text\n'
    )
    assert.equal(mode(join(outDir, 'licenses', 'tiny', 'LICENSE')), 0o644)
    assert.deepEqual(
      readdirSync(outDir).sort(),
      ['licenses', 'tiny'],
      'no work directory is left behind'
    )
    assert.match(lines.at(-1), /tiny 1\.0\.0: installed .* \(0\.0 MB downloaded; arm64\)/)
  })

  test('a SHA-256 mismatch fails and leaves nothing behind', async () => {
    const outDir = freshOut()
    const wrong = hashOf('something else')
    await assert.rejects(
      fetchTool(tool({ sha256: wrong }), { outDir, manifestDir }),
      new RegExp(
        `tiny: SHA-256 mismatch for ${base}/arm64\\n {2}expected ${wrong}\\n {2}received ${hashOf(bodies.arm64)}`
      )
    )
    assert.deepEqual(readdirSync(outDir), [])
  })

  test('follows redirects to the pinned file', async () => {
    const outDir = freshOut()
    assert.equal(
      await fetchTool(tool({ url: `${base}/hop1` }), { outDir, manifestDir }),
      'installed'
    )
    assert.equal(await sha256File(join(outDir, 'tiny')), hashOf(bodies.arm64))
  })

  test('is idempotent: a matching file is not downloaded again, a modified one is replaced', async () => {
    const outDir = freshOut()
    const installed = join(outDir, 'tiny')
    await fetchTool(tool(), { outDir, manifestDir })
    const before = hits['/arm64']

    chmodSync(installed, 0o644)
    rmSync(join(outDir, 'licenses'), { recursive: true })
    // A text an older pin listed doesn't stay behind.
    mkdirSync(join(outDir, 'licenses', 'tiny'), { recursive: true })
    writeFileSync(join(outDir, 'licenses', 'tiny', 'COPYING.GPLv3'), 'old\n')
    const lines = []
    assert.equal(
      await fetchTool(tool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'up-to-date'
    )
    assert.equal(hits['/arm64'], before, 'no second download')
    assert.equal(mode(installed), 0o755, 'mode restored')
    assert.deepEqual(
      readdirSync(join(outDir, 'licenses', 'tiny')),
      ['LICENSE'],
      'licences refreshed'
    )
    assert.deepEqual(lines, ['tiny 1.0.0: already installed with the pinned hash'])

    writeFileSync(installed, 'tampered')
    assert.equal(await fetchTool(tool(), { outDir, manifestDir }), 'installed')
    assert.equal(hits['/arm64'], before + 1)
    assert.equal(await sha256File(installed), hashOf(bodies.arm64))
  })

  test('a directory where the binary goes is not mistaken for an installed tool', async () => {
    const outDir = freshOut()
    mkdirSync(join(outDir, 'tiny'))
    await assert.rejects(fetchTool(tool(), { outDir, manifestDir }))
  })

  for (const [format, path] of [
    ['zip', '/tool.zip'],
    ['tar', '/tool.tar.gz']
  ]) {
    test(`extracts a ${format} archive and checks the extracted binary`, async () => {
      const archived = {
        url: `${base}${path}`,
        sha256: hashOf(format === 'zip' ? bodies.zip : bodies.tar),
        archive: format,
        archivePath: 'pkg/bin/tool',
        binarySha256: hashOf(bodies.arm64)
      }
      const outDir = freshOut()
      assert.equal(await fetchTool(tool(archived), { outDir, manifestDir }), 'installed')
      assert.equal(await sha256File(join(outDir, 'tiny')), hashOf(bodies.arm64))
      assert.equal(mode(join(outDir, 'tiny')), 0o755)
      assert.deepEqual(readdirSync(outDir).sort(), ['licenses', 'tiny'])

      // Idempotent on the extracted binary's hash.
      const before = hits[path]
      assert.equal(await fetchTool(tool(archived), { outDir, manifestDir }), 'up-to-date')
      assert.equal(hits[path], before)

      const wrong = hashOf('other')
      await assert.rejects(
        fetchTool(tool({ ...archived, binarySha256: wrong }), { outDir: freshOut(), manifestDir }),
        /tiny: SHA-256 mismatch for pkg\/bin\/tool in the archive/
      )
      await assert.rejects(
        fetchTool(tool({ ...archived, archivePath: 'pkg/bin/missing' }), {
          outDir: freshOut(),
          manifestDir
        }),
        /tiny: "pkg\/bin\/missing" is not in the archive/
      )
      await assert.rejects(
        fetchTool(tool({ ...archived, archivePath: 'pkg/bin' }), {
          outDir: freshOut(),
          manifestDir
        }),
        /tiny: "pkg\/bin" is not a file/
      )
    })
  }

  test('refuses an archive path that leads out of the archive through a symlink', async () => {
    const outDir = freshOut()
    const evil = tool({
      url: `${base}/evil.tar.gz`,
      sha256: hashOf(bodies.evil),
      archive: 'tar',
      archivePath: 'evil/link/tool',
      binarySha256: hashOf(bodies.arm64)
    })
    await assert.rejects(
      fetchTool(evil, { outDir, manifestDir }),
      /tiny: "evil\/link\/tool" leads outside the archive/
    )
    assert.ok(existsSync(join(root, 'outside', 'tool')), 'the outside file is untouched')
    assert.deepEqual(readdirSync(outDir), [])
  })

  test('rejects an executable without arm64, and a file that is not Mach-O', async () => {
    const outDir = freshOut()
    await assert.rejects(
      fetchTool(tool({ url: `${base}/x86_64`, sha256: hashOf(bodies.x86_64) }), {
        outDir,
        manifestDir
      }),
      /tiny: not built for Apple silicon: lipo -archs reports "x86_64", expected arm64/
    )
    await assert.rejects(
      fetchTool(tool({ url: `${base}/text`, sha256: hashOf(bodies.text) }), {
        outDir,
        manifestDir
      }),
      /lipo cannot read/
    )
    assert.deepEqual(readdirSync(outDir), [], 'nothing executable is installed')
  })

  test('a missing licence file stops the install before the binary is placed', async () => {
    const outDir = freshOut()
    await assert.rejects(
      fetchTool(tool({ licenseFiles: ['licenses/tiny/NOPE'] }), { outDir, manifestDir }),
      /tiny: cannot copy licence file licenses\/tiny\/NOPE/
    )
    assert.ok(!existsSync(join(outDir, 'tiny')))
  })
})

describe('folder installs (yt-dlp’s unpacked build)', () => {
  test('installs the archive’s contents as <name>/, checked and stamped', async () => {
    const outDir = freshOut()
    const lines = []
    assert.equal(
      await fetchTool(folderTool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'installed'
    )
    const dest = join(outDir, 'tiny')
    assert.deepEqual(readdirSync(dest).sort(), ['_internal', 'prog'])
    assert.deepEqual(readdirSync(join(dest, '_internal')).sort(), ['Python', 'current', 'data.txt'])
    assert.equal(mode(join(dest, 'prog')), 0o755)
    assert.equal(readFileSync(join(dest, '_internal', 'current'), 'utf8'), 'data\n')
    assert.deepEqual(readdirSync(outDir).sort(), ['.stamps', 'licenses', 'tiny'])
    assert.deepEqual(await readJson(stampPath(outDir, 'tiny')), {
      name: 'tiny',
      version: '1.0.0',
      sha256: hashOf(bodies.folderZip),
      executable: 'prog',
      links: {},
      treeSha256: await treeHash(dest)
    })
    assert.match(
      lines.at(-1),
      /tiny 1\.0\.0: installed .*tiny\/ \(0\.0 MB downloaded; prog: arm64\)/
    )
  })

  test('is not downloaded again while the folder matches its stamp; a changed one is replaced', async () => {
    const outDir = freshOut()
    const dest = join(outDir, 'tiny')
    await fetchTool(folderTool(), { outDir, manifestDir })
    const before = hits['/folder.zip']

    rmSync(join(outDir, 'licenses'), { recursive: true })
    const lines = []
    assert.equal(
      await fetchTool(folderTool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'up-to-date'
    )
    assert.equal(hits['/folder.zip'], before)
    assert.ok(existsSync(join(outDir, 'licenses', 'tiny', 'LICENSE')), 'licences refreshed')
    assert.deepEqual(lines, ['tiny 1.0.0: already installed from the pinned archive'])

    // A file inside changed, one added, or the program's mode: installed again from the archive.
    for (const change of [
      () => writeFileSync(join(dest, '_internal', 'data.txt'), 'tampered\n'),
      () => writeFileSync(join(dest, '_internal', 'extra.py'), 'print(1)\n'),
      () => chmodSync(join(dest, 'prog'), 0o644)
    ]) {
      change()
      const count = hits['/folder.zip']
      assert.equal(await fetchTool(folderTool(), { outDir, manifestDir }), 'installed')
      assert.equal(hits['/folder.zip'], count + 1)
      assert.equal(readFileSync(join(dest, '_internal', 'data.txt'), 'utf8'), 'data\n')
      assert.ok(!existsSync(join(dest, '_internal', 'extra.py')))
      assert.equal(mode(join(dest, 'prog')), 0o755)
    }

    // A stamp for another archive, or a broken one, is not trusted either.
    for (const stamp of ['{ broken', 'null', JSON.stringify({ sha256: hashOf('older') })]) {
      writeFileSync(stampPath(outDir, 'tiny'), stamp)
      assert.equal(await fetchTool(folderTool(), { outDir, manifestDir }), 'installed')
    }
  })

  test('replaces the single program an older pin installed under the same name', async () => {
    const outDir = freshOut()
    await fetchTool(tool(), { outDir, manifestDir })
    assert.ok(statSync(join(outDir, 'tiny')).isFile())
    assert.equal(await fetchTool(folderTool(), { outDir, manifestDir }), 'installed')
    assert.ok(statSync(join(outDir, 'tiny')).isDirectory())
    assert.deepEqual(readdirSync(join(outDir, 'tiny')).sort(), ['_internal', 'prog'])
  })

  const refused = [
    [
      'a link that leads out of the folder',
      'folderOut',
      /tiny: "_internal\/out" leads outside the archive/
    ],
    [
      'a link to nothing',
      'folderDangling',
      /tiny: "_internal\/dangling" leads outside the archive/
    ],
    ['a named pipe', 'folderFifo', /tiny: "_internal\/pipe" is not a file or a folder/],
    [
      'a program without arm64',
      'folderX86',
      /tiny: not built for Apple silicon: lipo -archs reports "x86_64", expected arm64/
    ]
  ]
  for (const [what, body, error] of refused) {
    test(`refuses an archive with ${what}, and installs nothing`, async () => {
      const outDir = freshOut()
      const path = `/${body.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.tar.gz`
      const entry = folderTool({
        url: `${base}${path}`,
        sha256: hashOf(bodies[body]),
        archive: 'tar'
      })
      await assert.rejects(fetchTool(entry, { outDir, manifestDir }), error)
      assert.deepEqual(readdirSync(outDir), [])
    })
  }

  test('refuses a missing program, or an archive that does not match its pin', async () => {
    const outDir = freshOut()
    await assert.rejects(
      fetchTool(folderTool({ executable: 'yt-dlp_macos' }), { outDir, manifestDir }),
      /tiny: "yt-dlp_macos" is not in the archive/
    )
    await assert.rejects(
      fetchTool(folderTool({ executable: '_internal' }), { outDir, manifestDir }),
      /tiny: "_internal" is not a file/
    )
    await assert.rejects(
      fetchTool(folderTool({ sha256: hashOf('another zip') }), { outDir, manifestDir }),
      /tiny: SHA-256 mismatch for http:\/\/127\.0\.0\.1:\d+\/folder\.zip/
    )
    assert.deepEqual(readdirSync(outDir), [])
  })

  const FRAMEWORK_LINKS = {
    '_internal/Lib.framework/Versions/Current': '1',
    '_internal/Lib.framework/Lib': 'Versions/Current/Lib',
    '_internal/Lib.framework/Resources': 'Versions/Current/Resources'
  }

  test('turns copies the archive made of a framework’s links back into those links', async () => {
    const outDir = freshOut()
    const entry = folderTool({
      url: `${base}/folder-flat.zip`,
      sha256: hashOf(bodies.folderFlat),
      links: FRAMEWORK_LINKS
    })
    assert.deepEqual(validateManifest({ tools: [entry] }), [])
    assert.equal(await fetchTool(entry, { outDir, manifestDir }), 'installed')
    const fw = join(outDir, 'tiny', '_internal', 'Lib.framework')
    for (const [path, target] of Object.entries(FRAMEWORK_LINKS)) {
      assert.equal(readlinkSync(join(outDir, 'tiny', path)), target, path)
    }
    assert.equal(
      await sha256File(join(fw, 'Lib')),
      await sha256File(join(fw, 'Versions', '1', 'Lib'))
    )
    assert.equal(readFileSync(join(fw, 'Resources', 'Info.plist'), 'utf8'), '<plist/>\n')
    // Stamped with the links, so it is up to date as installed, until the links asked for change.
    assert.equal(await fetchTool(entry, { outDir, manifestDir }), 'up-to-date')
    const fewer = { ...entry, links: { '_internal/Lib.framework/Versions/Current': '1' } }
    assert.equal(await fetchTool(fewer, { outDir, manifestDir }), 'installed')
    assert.ok(statSync(join(fw, 'Lib')).isFile())
    assert.ok(!lstatSync(join(fw, 'Lib')).isSymbolicLink())
  })

  test('leaves links that the archive kept as they are', async () => {
    const outDir = freshOut()
    const entry = folderTool({
      url: `${base}/folder-linked.tar.gz`,
      sha256: hashOf(bodies.folderLinked),
      archive: 'tar',
      links: FRAMEWORK_LINKS
    })
    assert.equal(await fetchTool(entry, { outDir, manifestDir }), 'installed')
    assert.equal(
      readlinkSync(join(outDir, 'tiny', '_internal', 'Lib.framework', 'Lib')),
      'Versions/Current/Lib'
    )
  })

  test('refuses to make a link of something that is not a copy of its target, or is missing', async () => {
    const changed = folderTool({
      url: `${base}/folder-changed.tar.gz`,
      sha256: hashOf(bodies.folderChanged),
      archive: 'tar',
      links: FRAMEWORK_LINKS
    })
    let outDir = freshOut()
    await assert.rejects(
      fetchTool(changed, { outDir, manifestDir }),
      /tiny: "_internal\/Lib\.framework\/Lib" is not a copy of "Versions\/Current\/Lib", so it can't be made a link to it/
    )
    assert.deepEqual(readdirSync(outDir), [])
    outDir = freshOut()
    await assert.rejects(
      fetchTool(folderTool({ links: { '_internal/missing': 'data.txt' } }), {
        outDir,
        manifestDir
      }),
      /tiny: "_internal\/missing" is not in the archive, so it can't be made a link/
    )
    await assert.rejects(
      fetchTool(folderTool({ links: { '_internal/current': 'other.txt' } }), {
        outDir,
        manifestDir
      }),
      /tiny: "_internal\/current" is not a copy of "other\.txt"/
    )
    assert.deepEqual(readdirSync(outDir), [])
  })

  test('links must stay inside the folder', () => {
    const problems = validateManifest({
      tools: [
        folderTool({ name: 'a', links: { '_internal/x': '../../outside' } }),
        folderTool({ name: 'b', links: { '_internal/x': '/etc/passwd' } }),
        folderTool({ name: 'c', links: { '../x': 'y' } }),
        folderTool({ name: 'd', links: { x: 7 } }),
        folderTool({ name: 'e', links: ['x'] }),
        tool({ name: 'f', links: {} })
      ]
    })
    assert.deepEqual(problems, [
      'a: link "_internal/x" -> "../../outside" must stay in the folder',
      'b: link "_internal/x" -> "/etc/passwd" must stay in the folder',
      'c: link "../x" -> "y" must stay in the folder',
      'd: link "x" -> 7 must stay in the folder',
      'e: "links" must map paths in the folder to the link targets they should be',
      'f: "links" is not used when "install" is "file"'
    ])
  })

  test('treeHash covers names, contents, modes and links, and is null for a non-folder', async () => {
    const dir = freshOut()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a'), 'a')
    symlinkSync('sub/a', join(dir, 'link'))
    const first = await treeHash(dir)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(await treeHash(dir), first)
    chmodSync(join(dir, 'sub', 'a'), 0o600)
    assert.notEqual(await treeHash(dir), first)
    assert.equal(await treeHash(join(dir, 'sub', 'a')), null)
    assert.equal(await treeHash(join(dir, 'missing')), null)
  })
})

describe('build installs (FFmpeg from source)', () => {
  test('downloads and checks the source, runs the build script, installs and stamps the result', async () => {
    const outDir = freshOut()
    const lines = []
    const output = []
    const runs = buildRuns().length
    assert.equal(
      await fetchTool(buildTool(), {
        outDir,
        manifestDir,
        log: (l) => lines.push(l),
        onBuildOutput: (chunk) => output.push(chunk.toString())
      }),
      'built'
    )
    assert.deepEqual(buildRuns().slice(runs), ['build-ok.sh'])
    const dest = join(outDir, 'tiny')
    assert.equal(await sha256File(dest), hashOf(bodies.arm64))
    assert.equal(mode(dest), 0o755)
    assert.equal(
      readFileSync(join(outDir, 'licenses', 'tiny', 'LICENSE'), 'utf8'),
      'tiny licence text\n'
    )
    assert.deepEqual(
      readdirSync(outDir).sort(),
      ['.stamps', 'licenses', 'tiny'],
      'no work folder left'
    )
    assert.deepEqual(await readJson(stampPath(outDir, 'tiny')), {
      name: 'tiny',
      version: '1.0.0',
      sourceSha256: hashOf(bodies.tar),
      buildScriptSha256: await sha256File(join(manifestDir, 'build-ok.sh')),
      binarySha256: hashOf(bodies.arm64)
    })
    assert.match(lines[0], /^tiny 1\.0\.0: downloading http:\/\/127\.0\.0\.1:\d+\/tool\.tar\.gz$/)
    assert.equal(lines[1], 'tiny 1.0.0: building with build-ok.sh')
    assert.match(lines.at(-1), /^tiny 1\.0\.0: built .*tiny \(arm64; SHA-256 [0-9a-f]{64}\)$/)

    // Its output was passed on as it came, and its TMPDIR was a folder of its own, now removed.
    const text = output.join('')
    assert.match(text, /compiling/)
    const tempDir = /configuring with TMPDIR=(\S+)/.exec(text)?.[1]
    assert.ok(tempDir && tempDir.includes('mergelane-build-tiny-'), text)
    assert.ok(!existsSync(tempDir), `${tempDir} was left behind`)
  })

  test('reuses the build while the source, the build script and the program match the stamp', async () => {
    const outDir = freshOut()
    const dest = join(outDir, 'tiny')
    await fetchTool(buildTool(), { outDir, manifestDir })
    const runs = buildRuns().length
    const downloads = hits['/tool.tar.gz']

    chmodSync(dest, 0o644)
    rmSync(join(outDir, 'licenses'), { recursive: true })
    const lines = []
    assert.equal(
      await fetchTool(buildTool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'up-to-date'
    )
    assert.deepEqual(lines, [
      'tiny 1.0.0: already built from the pinned source with this build script'
    ])
    assert.equal(buildRuns().length, runs, 'not built again')
    assert.equal(hits['/tool.tar.gz'], downloads, 'not downloaded again')
    assert.equal(mode(dest), 0o755)
    assert.ok(existsSync(join(outDir, 'licenses', 'tiny', 'LICENSE')))

    // A changed program, a broken stamp or a stamp for other source: built again.
    for (const change of [
      () => writeFileSync(dest, 'tampered'),
      () => writeFileSync(stampPath(outDir, 'tiny'), '{ broken'),
      () =>
        writeFileSync(
          stampPath(outDir, 'tiny'),
          JSON.stringify({
            ...JSON.parse(readFileSync(stampPath(outDir, 'tiny'), 'utf8')),
            sourceSha256: hashOf('9.0.1')
          })
        )
    ]) {
      change()
      const before = buildRuns().length
      assert.equal(await fetchTool(buildTool(), { outDir, manifestDir }), 'built')
      assert.equal(buildRuns().length, before + 1)
      assert.equal(await sha256File(dest), hashOf(bodies.arm64))
    }
  })

  test('a changed build script builds again', async () => {
    const outDir = freshOut()
    const otherDir = join(root, 'manifest-changed')
    mkdirSync(join(otherDir, 'licenses', 'tiny'), { recursive: true })
    writeFileSync(join(otherDir, 'licenses', 'tiny', 'LICENSE'), 'tiny licence text\n')
    const script = readFileSync(join(manifestDir, 'build-ok.sh'), 'utf8')
    writeFileSync(join(otherDir, 'build-ok.sh'), script)
    assert.equal(await fetchTool(buildTool(), { outDir, manifestDir: otherDir }), 'built')
    assert.equal(await fetchTool(buildTool(), { outDir, manifestDir: otherDir }), 'up-to-date')
    writeFileSync(join(otherDir, 'build-ok.sh'), `${script}\n# -O3 now\n`)
    assert.equal(await fetchTool(buildTool(), { outDir, manifestDir: otherDir }), 'built')
  })

  test('a source that does not match its pin is never built', async () => {
    const outDir = freshOut()
    const runs = buildRuns().length
    const wrong = hashOf('another tarball')
    await assert.rejects(
      fetchTool(buildTool({ sourceSha256: wrong }), { outDir, manifestDir }),
      new RegExp(`tiny: SHA-256 mismatch for ${base}/tool\\.tar\\.gz\\n {2}expected ${wrong}`)
    )
    assert.equal(buildRuns().length, runs, 'the build script did not run')
    assert.deepEqual(readdirSync(outDir), [])
  })

  test('a failing build installs nothing, keeps what was there, and says why', async () => {
    const outDir = freshOut()
    await fetchTool(buildTool(), { outDir, manifestDir })
    const stamp = readFileSync(stampPath(outDir, 'tiny'), 'utf8')
    const error = await fetchTool(buildTool({ buildScript: 'build-fail.sh' }), {
      outDir,
      manifestDir
    }).catch((failure) => failure)
    assert.match(error.message, /^tiny: the build failed: build-fail\.sh exited with code 3:\n/)
    assert.match(error.message, /error: the compiler gave up$/)
    // Only the end of the output.
    assert.ok(!error.message.includes('line 10\n'), error.message)
    assert.ok(error.message.includes('line 30'), error.message)
    // The earlier build is still there, untouched, and no partial program replaced it.
    assert.equal(await sha256File(join(outDir, 'tiny')), hashOf(bodies.arm64))
    assert.equal(readFileSync(stampPath(outDir, 'tiny'), 'utf8'), stamp)
    assert.deepEqual(readdirSync(outDir).sort(), ['.stamps', 'licenses', 'tiny'])

    // On its own, a failing build leaves nothing at all.
    const fresh = freshOut()
    await assert.rejects(
      fetchTool(buildTool({ buildScript: 'build-fail.sh' }), { outDir: fresh, manifestDir })
    )
    assert.deepEqual(readdirSync(fresh), [])
  })

  test('a build that writes nothing, is killed, or makes an Intel program installs nothing', async () => {
    const cases = [
      [
        { buildScript: 'build-nothing.sh' },
        /tiny: build-nothing\.sh finished but did not write tiny/
      ],
      [
        { buildScript: 'build-killed.sh' },
        /tiny: the build failed: build-killed\.sh was stopped by SIGKILL/
      ],
      [
        { sourceUrl: `${base}/x86src.tar.gz`, sourceSha256: hashOf(bodies.x86src) },
        /tiny: not built for Apple silicon: lipo -archs reports "x86_64", expected arm64/
      ]
    ]
    for (const [overrides, error] of cases) {
      const outDir = freshOut()
      await assert.rejects(fetchTool(buildTool(overrides), { outDir, manifestDir }), error)
      assert.deepEqual(readdirSync(outDir), [])
    }
  })

  test('a missing build script is reported before anything is downloaded', async () => {
    const downloads = hits['/tool.tar.gz']
    await assert.rejects(
      fetchTool(buildTool({ buildScript: 'build-missing.sh' }), {
        outDir: freshOut(),
        manifestDir
      }),
      /tiny: cannot read the build script .*build-missing\.sh/
    )
    assert.equal(hits['/tool.tar.gz'], downloads)
  })

  test('an unknown install kind is refused', async () => {
    for (const install of ['copy', 'constructor', undefined]) {
      await assert.rejects(
        fetchTool(tool({ install }), { outDir: freshOut(), manifestDir }),
        /tiny: unknown install kind/
      )
    }
  })
})

describe('fetchAll and main', () => {
  test('fetchAll installs every tool', async () => {
    const outDir = freshOut()
    const results = await fetchAll(
      { tools: [tool(), tool({ name: 'tiny2', url: `${base}/hop1` })] },
      { outDir, manifestDir }
    )
    assert.deepEqual(results, { tiny: 'installed', tiny2: 'installed' })
  })

  test('fetchAll validates the whole manifest before downloading anything', async () => {
    const before = hits['/arm64']
    await assert.rejects(
      fetchAll({ tools: [tool(), { name: 'broken' }] }, { outDir: freshOut(), manifestDir }),
      /invalid manifest:\n {2}- broken: missing "version"/
    )
    assert.equal(hits['/arm64'], before)
  })

  test('main installs from a manifest into the given directory and exits 0', async () => {
    const manifestPath = join(manifestDir, 'tools.json')
    writeFileSync(manifestPath, JSON.stringify({ tools: [tool()] }))
    const outDir = join(root, 'main-out')
    const lines = []
    assert.equal(
      await main([outDir, '--manifest', manifestPath], {
        log: (l) => lines.push(l),
        error: quiet.error
      }),
      0
    )
    assert.equal(mode(join(outDir, 'tiny')), 0o755)
    assert.equal(lines.at(-1), `media tools ready in ${outDir}`)
  })

  test('main builds a tool from source and passes the build output on', async () => {
    const manifestPath = join(manifestDir, 'tools-build.json')
    writeFileSync(manifestPath, JSON.stringify({ tools: [buildTool()] }))
    const outDir = join(root, 'main-build-out')
    const output = []
    assert.equal(
      await main([outDir, '--manifest', manifestPath], {
        ...quiet,
        buildOutput: (chunk) => output.push(chunk.toString())
      }),
      0
    )
    assert.equal(await sha256File(join(outDir, 'tiny')), hashOf(bodies.arm64))
    assert.match(output.join(''), /compiling/)
  })

  test('main exits 1 with a clear message on bad arguments or manifests', async () => {
    const errors = []
    const error = (l) => errors.push(l)
    assert.equal(await main(['--nope'], { log: quiet.log, error }), 1)
    assert.equal(
      await main(['a', 'b', '--manifest', DEFAULT_MANIFEST], { log: quiet.log, error }),
      1
    )
    assert.equal(
      await main([freshOut(), '--manifest', join(root, 'nope.json')], { log: quiet.log, error }),
      1
    )
    assert.ok(
      errors.every((l) => l.startsWith('fetch-media-tools: ')),
      errors.join('\n')
    )
    assert.match(errors[1], /expected one output directory, got 2/)
    assert.match(errors[2], /cannot read the manifest/)
  })

  test('runs as a script and exits non-zero on failure', () => {
    const result = spawnSync(
      process.execPath,
      [FETCH, freshOut(), '--manifest', join(root, 'nope.json')],
      {
        encoding: 'utf8'
      }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^fetch-media-tools: cannot read the manifest/)
  })
})

describe('Windows tools (W3, ADR-0057)', () => {
  const x64 = { platform: 'win32', arch: 'x64' }

  test('a manifest says what it builds for: macOS arm64 unless it names Windows and a chip', () => {
    assert.deepEqual(targetOf({}), { platform: 'darwin', arch: 'arm64' })
    assert.deepEqual(targetOf({ platform: 'win32', arch: 'arm64' }), {
      platform: 'win32',
      arch: 'arm64'
    })
    assert.equal(programName({ name: 'deno' }, x64), 'deno.exe')
    assert.equal(programName({ name: 'deno' }, targetOf({})), 'deno')
    assert.deepEqual(validateManifest({ platform: 'win32', arch: 'x64', tools: [tool()] }), [])
    assert.deepEqual(validateManifest({ platform: 'linux', tools: [tool()] }), [
      '"platform" must be one of: darwin, win32'
    ])
    assert.deepEqual(validateManifest({ platform: 'win32', arch: 'ia32', tools: [tool()] }), [
      '"arch" must be one of: x64, arm64 for win32'
    ])
    assert.deepEqual(validateManifest({ arch: 'x64', tools: [tool()] }), [
      '"arch" must be one of: arm64 for darwin'
    ])
  })

  test('peMachineOf reads the chip from the PE header, and refuses anything else', async () => {
    const dir = mkdtempSync(join(root, 'pe-'))
    const write = (name, body) => {
      writeFileSync(join(dir, name), body)
      return join(dir, name)
    }
    assert.equal(await peMachineOf(write('x64.exe', bodies.peX64)), 'x64')
    assert.equal(await peMachineOf(write('arm64.exe', bodies.peArm64)), 'arm64')
    assert.equal(await peMachineOf(write('odd.exe', bodies.peOdd)), '0x1c4')
    await assert.rejects(
      peMachineOf(write('mach.o', bodies.arm64)),
      /not a Windows program \(no MZ header\)/
    )
    await assert.rejects(
      peMachineOf(write('mz.exe', bodies.mzOnly)),
      /not a Windows program \(no PE header\)/
    )
  })

  test('installs a Windows program as <name>.exe after checking its chip', async () => {
    const outDir = freshOut()
    const winTool = tool({ url: `${base}/pe-x64`, sha256: hashOf(bodies.peX64) })
    const lines = []
    assert.equal(
      await fetchTool(winTool, { outDir, manifestDir, target: x64, log: (l) => lines.push(l) }),
      'installed'
    )
    assert.equal(await sha256File(join(outDir, 'tiny.exe')), hashOf(bodies.peX64))
    assert.equal(existsSync(join(outDir, 'tiny')), false)
    assert.match(lines.at(-1), /installed .*tiny\.exe .*windows-x64/)
    // The other chip is refused, and nothing is installed.
    const armOut = freshOut()
    await assert.rejects(
      fetchTool(tool({ url: `${base}/pe-x64`, sha256: hashOf(bodies.peX64) }), {
        outDir: armOut,
        manifestDir,
        target: { platform: 'win32', arch: 'arm64' },
        ...quiet
      }),
      /tiny: built for x64, expected Windows arm64/
    )
    assert.equal(existsSync(join(armOut, 'tiny.exe')), false)
  })

  test('a build gets its pinned inputs and arguments, writes <name>.exe, and builds again when they change', async () => {
    const outDir = freshOut()
    const inputs = [
      { name: 'toolchain.tar.xz', url: `${base}/input-a`, sha256: hashOf(bodies.inputA) },
      { name: 'zlib.tar.gz', url: `${base}/input-b`, sha256: hashOf(bodies.inputB) }
    ]
    const winBuild = buildTool({
      buildScript: 'build-win.sh',
      sourceUrl: `${base}/winsrc.tar.gz`,
      sourceSha256: hashOf(bodies.winsrc),
      buildArgs: ['x64'],
      buildInputs: inputs
    })
    assert.deepEqual(validateManifest({ platform: 'win32', arch: 'x64', tools: [winBuild] }), [])
    assert.equal(await fetchTool(winBuild, { outDir, manifestDir, target: x64, ...quiet }), 'built')
    assert.equal(await sha256File(join(outDir, 'tiny.exe')), hashOf(bodies.peX64))
    assert.deepEqual(readFileSync(join(manifestDir, 'win-args.log'), 'utf8').trim().split('\n'), [
      'x64:-',
      'toolchain.tar.xz:cross-compiler',
      'zlib.tar.gz:zlib'
    ])
    const stamp = await readJson(stampPath(outDir, 'tiny'))
    assert.equal(
      stamp.recipe,
      JSON.stringify({ args: ['x64'], inputs: inputs.map((input) => input.sha256) })
    )
    // The same recipe: nothing to do. Another argument: built again.
    assert.equal(
      await fetchTool(winBuild, { outDir, manifestDir, target: x64, ...quiet }),
      'up-to-date'
    )
    assert.equal(
      await fetchTool(
        { ...winBuild, buildArgs: ['x64', 'again'] },
        { outDir, manifestDir, target: x64, ...quiet }
      ),
      'built'
    )
  })

  test('a build input that does not match its pin stops the build before it runs', async () => {
    const outDir = freshOut()
    const runs = buildRuns().length
    const bad = buildTool({
      buildScript: 'build-win.sh',
      sourceUrl: `${base}/winsrc.tar.gz`,
      sourceSha256: hashOf(bodies.winsrc),
      buildInputs: [
        { name: 'toolchain.tar.xz', url: `${base}/input-a`, sha256: hashOf(bodies.inputB) }
      ]
    })
    await assert.rejects(
      fetchTool(bad, { outDir, manifestDir, target: x64, ...quiet }),
      /SHA-256 mismatch/
    )
    assert.equal(buildRuns().length, runs)
  })

  test('build arguments and inputs are checked', () => {
    const problems = (overrides) => validateManifest({ tools: [buildTool(overrides)] })
    assert.deepEqual(problems({ buildArgs: ['x64; rm -rf /'] }), [
      'tiny: "buildArgs" must be a list of plain words (letters, digits, ".", "_", "-")'
    ])
    assert.deepEqual(problems({ buildInputs: [] }), [
      'tiny: "buildInputs" must be a non-empty list of {name, url, sha256}'
    ])
    assert.deepEqual(problems({ buildInputs: [{ name: '../x', url: 'ftp://x', sha256: 'no' }] }), [
      'tiny: build input ../x: "name" must be a plain file name',
      'tiny: build input ../x: "sha256" must be 64 lowercase hex characters',
      'tiny: build input ../x: only https URLs are allowed: ftp://x'
    ])
    assert.deepEqual(problems({ buildInputs: [{}] }), [
      'tiny: build input ?: "name" must be a plain file name',
      'tiny: build input ?: "sha256" must be 64 lowercase hex characters',
      'tiny: build input ?: missing "url"'
    ])
    assert.deepEqual(validateManifest({ tools: [tool({ buildArgs: ['x'] })] }), [
      'tiny: "buildArgs" is not used when "install" is "file"'
    ])
  })
})

describe('the Windows manifests (W3)', () => {
  for (const arch of ['x64', 'arm64']) {
    test(`tools-windows-${arch}.json is valid, for Windows ${arch}, the same versions as tools.json`, async () => {
      const windows = await loadManifest(join(HERE, `tools-windows-${arch}.json`))
      const mac = await loadManifest(DEFAULT_MANIFEST)
      assert.deepEqual(targetOf(windows), { platform: 'win32', arch })
      assert.deepEqual(
        windows.tools.map((t) => `${t.name} ${t.version}`),
        mac.tools
          .map((t) => `${t.name} ${t.version}`)
          .sort(
            (a, b) =>
              ['yt-dlp', 'ffmpeg', 'deno'].indexOf(a.split(' ')[0]) -
              ['yt-dlp', 'ffmpeg', 'deno'].indexOf(b.split(' ')[0])
          )
      )
      for (const t of windows.tools) {
        for (const file of t.licenseFiles)
          assert.ok(existsSync(join(HERE, file)), `${t.name}: ${file}`)
        for (const url of [t.url, t.sourceUrl, ...(t.buildInputs ?? []).map((i) => i.url)].filter(
          Boolean
        )) {
          assert.match(url, /^https:\/\//)
        }
      }
      const ffmpeg = windows.tools.find((t) => t.name === 'ffmpeg')
      assert.equal(ffmpeg.sourceSha256, mac.tools.find((t) => t.name === 'ffmpeg').sourceSha256)
      assert.deepEqual(ffmpeg.buildArgs, [arch])
      assert.equal(ffmpeg.buildScript, 'build-ffmpeg-windows.sh')
    })
  }

  test("the Windows FFmpeg build has the macOS build's components, word for word, and no GPL", () => {
    const lists = (file) =>
      Object.fromEntries(
        readFileSync(join(HERE, file), 'utf8')
          .split('\n')
          .filter((line) => /^(DEMUXERS|MUXERS|PARSERS|DECODERS|BSFS)=/.test(line))
          .map((line) => line.split('='))
      )
    assert.deepEqual(lists('build-ffmpeg-windows.sh'), lists('build-ffmpeg.sh'))
    const script = readFileSync(join(HERE, 'build-ffmpeg-windows.sh'), 'utf8')
    const commands = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(commands, /--enable-(gpl|version3|nonfree)/)
    for (const flag of ['CONFIG_GPL', 'CONFIG_VERSION3', 'CONFIG_NONFREE'])
      assert.match(script, new RegExp(flag))
  })
})
