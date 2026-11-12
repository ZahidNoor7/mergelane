// Tests for sources.mjs against a local HTTP server: no network.
// Run: node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/sources.mjs' \
//        scripts/media-tools/sources.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  archiveExtension,
  collectSources,
  DEFAULT_MANIFEST,
  isCopyleft,
  main,
  releaseSourceNames,
  sourceProblems
} from './sources.mjs'

const hashOf = (data) => createHash('sha256').update(data).digest('hex')
const quiet = { log: () => {}, error: () => {} }
const LGPL_SOURCE = Buffer.from('pretend ffmpeg source tarball')
const GPL_SOURCE = Buffer.from('pretend yt-dlp source tarball')

let root // everything the tests create lives here and is removed in after()
let manifestDir
let base // http://127.0.0.1:<port>; fetch.mjs allows plain http only for loopback
let server

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'mergelane-sources-test-'))
  manifestDir = join(root, 'manifest')
  mkdirSync(manifestDir)
  writeFileSync(join(manifestDir, 'build-tiny.sh'), '#!/bin/sh\necho build\n')
  let flakyHits = 0
  server = createServer((request, response) => {
    // Cut the first try off, as ffmpeg.org sometimes does; serve the source on the next.
    if (request.url === '/flaky.tar.xz' && ++flakyHits === 1) return request.socket.destroy()
    const body = {
      '/lgpl.tar.xz': LGPL_SOURCE,
      '/flaky.tar.xz': LGPL_SOURCE,
      '/gpl.tar.gz': GPL_SOURCE
    }[request.url]
    response.writeHead(body ? 200 : 404, body ? { 'content-length': body.length } : {})
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

/** An LGPL tool with a build script, a GPL tool, and an MIT tool, with per-tool overrides. */
function manifest(overrides = []) {
  return {
    tools: [
      {
        name: 'ffmpeg',
        version: '9.0.2',
        license: 'LGPL-2.1-or-later',
        sourceUrl: `${base}/lgpl.tar.xz`,
        sourceSha256: hashOf(LGPL_SOURCE),
        buildScript: 'build-tiny.sh',
        ...overrides[0]
      },
      {
        name: 'yt-dlp',
        version: '2026.10.26',
        license: 'GPL-3.0-or-later for this PyInstaller-bundled executable as a whole',
        sourceUrl: `${base}/gpl.tar.gz`,
        sourceSha256: hashOf(GPL_SOURCE),
        ...overrides[1]
      },
      { name: 'deno', version: '2.5.0', license: 'MIT', ...overrides[2] }
    ]
  }
}

const collect = (m, outDir, lines = []) =>
  collectSources(m, { outDir, manifestDir, log: (line) => lines.push(line) })

describe('isCopyleft', () => {
  test('GPL-family licences need source; permissive ones do not', () => {
    for (const licence of ['GPL-3.0-or-later', 'LGPL-2.1-or-later', 'GPL version 3', 'AGPL-3.0']) {
      assert.equal(isCopyleft(licence), true, licence)
    }
    for (const licence of ['MIT', 'Unlicense', 'Apache-2.0', '', undefined]) {
      assert.equal(isCopyleft(licence), false, String(licence))
    }
  })
})

describe('archiveExtension', () => {
  test('keeps double extensions and drops unknown ones', () => {
    assert.equal(archiveExtension('https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'), '.tar.xz')
    assert.equal(archiveExtension('https://example.org/a/yt-dlp.tar.gz?x=1'), '.tar.gz')
    assert.equal(archiveExtension('https://example.org/a.tgz'), '.tgz')
    assert.equal(archiveExtension('https://example.org/a.zip'), '.zip')
    assert.equal(archiveExtension('https://example.org/a.tar.bz2'), '.tar.bz2')
    assert.equal(archiveExtension('https://git.example.org/repo'), '')
  })
})

describe('releaseSourceNames', () => {
  test('names the source archive and the build script as collectSources writes them', () => {
    const [ffmpeg, ytdlp, deno] = manifest().tools
    assert.deepEqual(releaseSourceNames(ffmpeg), {
      source: 'ffmpeg-9.0.2-source.tar.xz',
      buildScript: 'ffmpeg-9.0.2-build-tiny.sh',
      inputs: []
    })
    assert.deepEqual(releaseSourceNames(ytdlp), {
      source: 'yt-dlp-2026.10.26-source.tar.gz',
      buildScript: null,
      inputs: []
    })
    // A build input whose source ships (Windows FFmpeg's zlib), and one that doesn't (the compiler).
    const windows = {
      ...ffmpeg,
      buildInputs: [
        { name: 'toolchain.tar.xz', url: 'https://example.invalid/t', sha256: hashOf('t') },
        {
          name: 'zlib-1.3.2.tar.gz',
          url: 'https://example.invalid/z',
          sha256: hashOf('z'),
          source: true
        }
      ]
    }
    assert.deepEqual(releaseSourceNames(windows).inputs, ['zlib-1.3.2.tar.gz'])
    assert.equal(releaseSourceNames(deno), null)
    assert.equal(releaseSourceNames(undefined), null)
  })
})

describe('sourceProblems', () => {
  test('a complete manifest has none', () => {
    assert.deepEqual(sourceProblems(manifest()), [])
  })

  test('a GPL-family tool without a pinned source is a problem; an MIT one is not', () => {
    assert.deepEqual(sourceProblems(manifest([{ sourceSha256: undefined }])), [
      'ffmpeg: LGPL-2.1-or-later needs a pinned sourceSha256'
    ])
  })

  test('bad hashes, non-https URLs, unsafe names and build-script paths are problems', () => {
    const problems = sourceProblems(
      manifest([
        { sourceSha256: 'ABC', buildScript: '../escape.sh' },
        { sourceUrl: 'http://example.org/gpl.tar.gz' },
        { name: '../deno' }
      ])
    )
    assert.deepEqual(problems, [
      'ffmpeg: sourceSha256 must be 64 lowercase hex characters',
      'ffmpeg: buildScript must be a file name next to the manifest',
      'yt-dlp: sourceUrl must be an https URL',
      '../deno: name and version must be plain file-name parts'
    ])
    assert.deepEqual(sourceProblems(manifest([{}, { sourceUrl: undefined }])), [
      'yt-dlp: sourceUrl must be an https URL'
    ])
  })

  test('a manifest without tools, or a tool without a name, is a problem', () => {
    assert.deepEqual(sourceProblems({}), ['the manifest has no "tools" list'])
    assert.deepEqual(sourceProblems(null), ['the manifest has no "tools" list'])
    assert.deepEqual(sourceProblems({ tools: [{}] }), [
      '(unnamed): name and version must be plain file-name parts'
    ])
  })

  test('the real tools.json pins the source of every GPL-family program', async () => {
    const real = JSON.parse(await readFile(DEFAULT_MANIFEST, 'utf8'))
    assert.deepEqual(sourceProblems(real), [])
    assert.ok(real.tools.some((tool) => isCopyleft(tool.license)))
  })
})

describe('collectSources', () => {
  test('downloads, checks and names each source, copies the build script, and skips MIT tools', async () => {
    const outDir = join(root, 'out-ok')
    const lines = []
    const written = await collect(manifest(), outDir, lines)
    assert.deepEqual(
      written.map((path) => path.slice(outDir.length + 1)),
      [
        'ffmpeg-9.0.2-source.tar.xz',
        'ffmpeg-9.0.2-build-tiny.sh',
        'yt-dlp-2026.10.26-source.tar.gz'
      ]
    )
    assert.deepEqual(readFileSync(join(outDir, 'ffmpeg-9.0.2-source.tar.xz')), LGPL_SOURCE)
    assert.deepEqual(readFileSync(join(outDir, 'yt-dlp-2026.10.26-source.tar.gz')), GPL_SOURCE)
    assert.equal(
      readFileSync(join(outDir, 'ffmpeg-9.0.2-build-tiny.sh'), 'utf8'),
      '#!/bin/sh\necho build\n'
    )
    assert.ok(lines.includes('deno: MIT, no source to attach'))
    assert.ok(lines.some((line) => line.startsWith('ffmpeg: ffmpeg-9.0.2-source.tar.xz (SHA-256 ')))
  })

  test('downloads a build input whose source ships, and keeps a source already there with the pinned hash', async () => {
    const outDir = join(root, 'out-inputs')
    const lines = []
    const windows = manifest([
      {
        buildInputs: [
          { name: 'toolchain.tar.xz', url: `${base}/gpl.tar.gz`, sha256: hashOf(GPL_SOURCE) },
          {
            name: 'zlib-1.3.2.tar.gz',
            url: `${base}/gpl.tar.gz`,
            sha256: hashOf(GPL_SOURCE),
            source: true
          }
        ]
      }
    ])
    const written = await collect(windows, outDir, lines)
    assert.ok(written.some((path) => path.endsWith('zlib-1.3.2.tar.gz')))
    assert.equal(existsSync(join(outDir, 'toolchain.tar.xz')), false)
    assert.ok(lines.some((line) => line.startsWith('ffmpeg: zlib-1.3.2.tar.gz (SHA-256 ')))
    // Again into the same folder (the other Windows manifest): nothing is downloaded twice.
    const before = statSync(join(outDir, 'ffmpeg-9.0.2-source.tar.xz')).mtimeMs
    const again = []
    await collect(windows, outDir, again)
    assert.equal(statSync(join(outDir, 'ffmpeg-9.0.2-source.tar.xz')).mtimeMs, before)
    assert.equal(again.filter((line) => line.includes('downloading')).length, 0)
  })

  test('a build input that does not match its pin fails', async () => {
    const outDir = join(root, 'out-input-mismatch')
    const bad = manifest([
      {
        buildInputs: [
          { name: 'zlib.tar.gz', url: `${base}/gpl.tar.gz`, sha256: hashOf('other'), source: true }
        ]
      }
    ])
    await assert.rejects(
      collect(bad, outDir),
      /ffmpeg zlib\.tar\.gz: source SHA-256 is [0-9a-f]{64}, expected/
    )
    assert.equal(existsSync(join(outDir, 'zlib.tar.gz')), false)
  })

  test('refuses a bad manifest before downloading anything', async () => {
    const outDir = join(root, 'out-refused')
    await assert.rejects(
      collect(manifest([{ sourceSha256: undefined }]), outDir),
      /cannot collect sources/
    )
    assert.equal(existsSync(outDir), false)
  })

  test('a hash mismatch fails and leaves no partial file', async () => {
    const outDir = join(root, 'out-mismatch')
    await assert.rejects(
      collect(manifest([{ sourceSha256: hashOf('something else') }]), outDir),
      /ffmpeg: source SHA-256 is [0-9a-f]{64}, expected/
    )
    assert.deepEqual(readdirSync(outDir), [])
  })

  test('a cut connection is tried again, and the source still arrives whole', async () => {
    const outDir = join(root, 'out-flaky')
    const lines = []
    await collectSources(manifest([{ sourceUrl: `${base}/flaky.tar.xz` }]), {
      outDir,
      manifestDir,
      log: (line) => lines.push(line),
      pauseMs: 0
    })
    assert.deepEqual(readFileSync(join(outDir, 'ffmpeg-9.0.2-source.tar.xz')), LGPL_SOURCE)
    assert.ok(
      lines.some((line) => /flaky\.tar\.xz: .*trying again in 0s \(attempt 2 of 3\)/.test(line))
    )
    assert.equal(
      readdirSync(outDir).some((name) => name.endsWith('.part')),
      false
    )
  })

  test('a missing file fails and leaves no partial file', async () => {
    const outDir = join(root, 'out-404')
    await assert.rejects(
      collect(manifest([{}, { sourceUrl: `${base}/missing.tar.gz` }]), outDir),
      /HTTP 404/
    )
    assert.deepEqual(readdirSync(outDir).sort(), [
      'ffmpeg-9.0.2-build-tiny.sh',
      'ffmpeg-9.0.2-source.tar.xz'
    ])
  })
})

describe('main', () => {
  test('writes the sources and reports where', async () => {
    const path = join(manifestDir, 'tools.json')
    writeFileSync(path, JSON.stringify(manifest()))
    const lines = []
    const outDir = join(root, 'out-main')
    assert.equal(
      await main([outDir, '--manifest', path], { ...quiet, log: (line) => lines.push(line) }),
      0
    )
    assert.equal(readdirSync(outDir).length, 3)
    assert.equal(lines.at(-1), `sources ready in ${outDir}`)
  })

  test('needs exactly one output directory', async () => {
    const errors = []
    assert.equal(await main([], { ...quiet, error: (line) => errors.push(line) }), 1)
    assert.match(errors[0], /expected one output directory, got 0/)
  })

  test('reports an unreadable manifest', async () => {
    const errors = []
    const code = await main([join(root, 'x'), '--manifest', join(root, 'nope.json')], {
      ...quiet,
      error: (line) => errors.push(line)
    })
    assert.equal(code, 1)
    assert.match(errors[0], /^media-tools sources: cannot read the manifest/)
  })
})
