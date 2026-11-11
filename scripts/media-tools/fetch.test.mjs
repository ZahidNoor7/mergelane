// Tests for fetch.mjs against a local HTTP server, with tiny Mach-O fixtures built by clang: no network.
// Run: node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/fetch.mjs' \
//        scripts/media-tools/fetch.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
  extract,
  fetchAll,
  fetchTool,
  loadManifest,
  main,
  REQUIRED_FIELDS,
  sha256File,
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

const freshOut = () => mkdtempSync(join(root, 'out-'))
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

  // An archive whose "executable" sits behind a symlink that leads out of the archive.
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'tool'), bodies.arm64)
  mkdirSync(join(build, 'evil'))
  symlinkSync(outside, join(build, 'evil', 'link'))
  execFileSync('/usr/bin/tar', ['-czf', join(build, 'evil.tar.gz'), '-C', build, 'evil'])
  bodies.evil = readFileSync(join(build, 'evil.tar.gz'))

  manifestDir = join(root, 'manifest')
  mkdirSync(join(manifestDir, 'licenses', 'tiny'), { recursive: true })
  writeFileSync(join(manifestDir, 'licenses', 'tiny', 'LICENSE'), 'tiny licence text\n')

  const routes = {
    '/arm64': (res) => res.end(bodies.arm64),
    '/x86_64': (res) => res.end(bodies.x86_64),
    '/text': (res) => res.end(bodies.text),
    '/tool.zip': (res) => res.end(bodies.zip),
    '/tool.tar.gz': (res) => res.end(bodies.tar),
    '/evil.tar.gz': (res) => res.end(bodies.evil),
    // A relative redirect, then an absolute one, as GitHub's release downloads do.
    '/hop1': (res) => res.writeHead(302, { location: '/hop2' }).end(),
    '/hop2': (res) => res.writeHead(301, { location: `${base}/arm64` }).end(),
    '/loop': (res) => res.writeHead(302, { location: '/loop' }).end(),
    '/no-location': (res) => res.writeHead(302).end(),
    '/offsite': (res) => res.writeHead(307, { location: 'http://example.invalid/tool' }).end(),
    '/hang': () => {},
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
      ['yt-dlp', 'ffmpeg']
    )
    for (const t of manifest.tools) {
      assert.ok(t.url.startsWith('https://'), t.url)
      for (const file of t.licenseFiles) {
        assert.ok(existsSync(join(HERE, file)), `${t.name}: ${file} is not committed`)
      }
    }
  })

  test('installs into app/resources/bin by default', () => {
    assert.ok(DEFAULT_OUT_DIR.endsWith(join('app', 'resources', 'bin')), DEFAULT_OUT_DIR)
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
    const lines = []
    assert.equal(
      await fetchTool(tool(), { outDir, manifestDir, log: (l) => lines.push(l) }),
      'up-to-date'
    )
    assert.equal(hits['/arm64'], before, 'no second download')
    assert.equal(mode(installed), 0o755, 'mode restored')
    assert.ok(existsSync(join(outDir, 'licenses', 'tiny', 'LICENSE')), 'licences refreshed')
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
