// Tests for deno-notices.mjs. Run:
//   node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/deno-notices.mjs' \
//     scripts/media-tools/deno-notices.test.mjs
// No network: a local web server serves a fake Deno source release, fake crates (made here with
// /usr/bin/tar) and licence files, so the real download and archive code runs end to end.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  commentBlocks,
  cutBefore,
  DEFAULT_CONFIG,
  generate,
  hasOwnText,
  isLicenseFile,
  licenseMembers,
  main,
  mapLimit,
  normalizeText,
  noticeHeaders,
  parseCargoLock,
  parseCargoToml,
  realIo,
  scriptFiles,
  spdxIds,
  splitPackages,
  TextStore,
  validateConfig
} from './deno-notices.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'mergelane-deno-notices-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let count = 0
const fresh = (name) => {
  const dir = join(scratch, `${name}-${++count}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'

describe('Cargo files', () => {
  test('Cargo.lock: packages, ignoring other tables', () => {
    const lock = [
      'version = 4',
      '',
      '[[package]]',
      'name = "a"',
      'version = "1.0.0"',
      `source = "${REGISTRY}"`,
      `checksum = "${'a'.repeat(64)}"`,
      'dependencies = [',
      ' "b",',
      ']',
      '',
      '[[package]]',
      'name = "deno"',
      'version = "2.9.8"',
      '',
      '[metadata]',
      'name = "ignored"'
    ].join('\n')
    assert.deepEqual(parseCargoLock(lock), [
      { name: 'a', version: '1.0.0', source: REGISTRY, checksum: 'a'.repeat(64) },
      { name: 'deno', version: '2.9.8' }
    ])
    assert.throws(() => parseCargoLock('version = 4\n'), /no packages/)
    assert.throws(() => parseCargoLock('[[package]]\nname = "x"\n'), /without a name or version/)
  })

  test('splits crates.io packages (sorted) from the workspace, and refuses other sources', () => {
    const crate = (name, version) => ({ name, version, source: REGISTRY, checksum: 'b'.repeat(64) })
    const { crates, local } = splitPackages([
      crate('z', '1.0.0'),
      { name: 'mine', version: '1' },
      crate('a', '2.0.0'),
      crate('a', '1.0.0')
    ])
    assert.deepEqual(
      crates.map(({ name, version }) => `${name}@${version}`),
      ['a@1.0.0', 'a@2.0.0', 'z@1.0.0']
    )
    assert.equal(local, 1)
    assert.throws(
      () => splitPackages([{ name: 'g', version: '1', source: 'git+https://x' }]),
      /not supported/
    )
    assert.throws(
      () => splitPackages([{ name: 'n', version: '1', source: REGISTRY }]),
      /no SHA-256/
    )
  })

  test("Cargo.toml: [package]'s license, license-file and repository", () => {
    const toml = [
      '[package]',
      'name = "x"',
      'license = "MIT OR Apache-2.0"',
      'license-file = "docs/LICENSE \\"x\\""',
      'repository = "https://github.com/o/r"',
      '',
      '[dependencies.y]',
      'license = "not this one"'
    ].join('\n')
    assert.deepEqual(parseCargoToml(toml), {
      license: 'MIT OR Apache-2.0',
      licenseFile: 'docs/LICENSE "x"',
      repository: 'https://github.com/o/r'
    })
    assert.deepEqual(parseCargoToml('[package]\nname = "x"\n'), {
      license: null,
      licenseFile: null,
      repository: null
    })
    assert.equal(parseCargoToml('[package]\nlicense = "bad \\q"\n').license, 'bad \\q')
  })
})

describe('choosing licence files', () => {
  test('licence, notice and copying files, outside tests and docs, and not program files', () => {
    for (const path of [
      'LICENSE',
      'LICENSE-MIT',
      'license.txt',
      'COPYING',
      'NOTICE',
      'vendor/zlib/LICENSE',
      'contrib/LICENSE_1_0.txt',
      'UNLICENSE'
    ]) {
      assert.ok(isLicenseFile(path), path)
    }
    for (const path of [
      'src/license.rs',
      'tests/LICENSE',
      'examples/a/LICENSE',
      'docs/COPYING',
      'README.md',
      'license.html'
    ]) {
      assert.ok(!isLicenseFile(path), path)
    }
  })

  test("a crate's members: its licence files, its license-file and LICENSES/", () => {
    const entries = [
      'x-1/',
      'x-1/Cargo.toml',
      'x-1/LICENSE-MIT',
      'x-1/tests/LICENSE',
      'x-1/legal/TERMS',
      'x-1/LICENSES/MIT.txt',
      'x-1/c/zlib/LICENSE',
      'other/LICENSE'
    ]
    assert.deepEqual(
      licenseMembers(entries, 'x-1', './legal/TERMS'),
      ['LICENSES/MIT.txt', 'LICENSE-MIT', 'c/zlib/LICENSE', 'legal/TERMS'].sort()
    )
    assert.deepEqual(
      licenseMembers(entries, 'x-1', null),
      ['LICENSE-MIT', 'LICENSES/MIT.txt', 'c/zlib/LICENSE'].sort()
    )
  })

  test("a crate's own text is at its top level, in LICENSES/, or its license-file", () => {
    assert.equal(hasOwnText(['LICENSE'], null), true)
    assert.equal(hasOwnText(['LICENSES/MIT.txt'], null), true)
    assert.equal(hasOwnText(['legal/TERMS'], 'legal/TERMS'), true)
    assert.equal(hasOwnText(['libffi/LICENSE'], null), false)
    assert.equal(hasOwnText([], null), false)
  })

  test('SPDX expressions give their licence identifiers', () => {
    assert.deepEqual(spdxIds('MIT OR Apache-2.0'), ['Apache-2.0', 'MIT'])
    assert.deepEqual(spdxIds('MIT/Apache-2.0'), ['Apache-2.0', 'MIT'])
    assert.deepEqual(spdxIds('(Apache-2.0 WITH LLVM-exception) AND MIT'), [
      'Apache-2.0',
      'LLVM-exception',
      'MIT'
    ])
    assert.deepEqual(spdxIds(null), [])
  })
})

describe('texts', () => {
  test('normalised: no BOM, \\n endings, no trailing spaces or blank edges', () => {
    assert.equal(normalizeText('\uFEFF\r\n\r\nA  \r\nB\t\r\n\r\n'), 'A\nB')
  })

  test('each distinct text is kept once, labelled in the order first seen', () => {
    const store = new TextStore()
    assert.equal(store.add('MIT\r\n'), 'T1')
    assert.equal(store.add('Apache'), 'T2')
    assert.equal(store.add('MIT  \n\n'), 'T1')
    assert.deepEqual(
      store.entries().map(({ label, text }) => [label, text]),
      [
        ['T1', 'MIT'],
        ['T2', 'Apache']
      ]
    )
    assert.throws(() => store.add(' \n '), /empty licence text/)
  })

  test("a text can be cut before a marker line (Node.js's list of external libraries)", () => {
    assert.equal(
      cutBefore('ours\nThe externally maintained\nrest', 'The externally maintained'),
      'ours\n'
    )
    assert.throws(() => cutBefore('text', 'missing'), /has no line "missing"/)
  })
})

describe('notices in source comments', () => {
  test('comment blocks: block comments and runs of line comments, without their markers', () => {
    const source = [
      '// Copyright 2018-2026 the Deno authors. MIT license.',
      '// Copyright Joyent and Node contributors. All rights reserved. MIT license.',
      'const a = 1 /* inline */',
      '/*! *****',
      ' * Copyright (c) Microsoft Corporation.',
      ' ***** */',
      '/* one line, Copyright Someone */',
      '/**',
      ' * docs',
      ' */',
      'code()'
    ].join('\r\n')
    assert.deepEqual(commentBlocks(source), [
      'Copyright 2018-2026 the Deno authors. MIT license.\nCopyright Joyent and Node contributors. All rights reserved. MIT license.',
      // Markers go; decoration stays (normalizeText trims the spaces later).
      '****\nCopyright (c) Microsoft Corporation.\n**** ',
      ' one line, Copyright Someone ',
      '\ndocs\n '
    ])
  })

  test("third-party notices, grouped by text, without the Deno authors' own lines", () => {
    const deno = '// Copyright 2018-2026 the Deno authors. MIT license.\n'
    const node = '// Copyright Joyent and Node contributors. All rights reserved. MIT license.\n'
    const long = `/*\n${Array.from({ length: 70 }, () => ' * Copyright line').join('\n')}\n */\n`
    const headers = noticeHeaders([
      { path: 'ext/b.ts', text: `${deno}${node}x()` },
      { path: 'ext/a.ts', text: `${deno}${node}` },
      { path: 'ext/c.ts', text: `${deno}y()` },
      { path: 'ext/d.ts', text: long }
    ])
    assert.deepEqual(headers, [
      {
        text: 'Copyright Joyent and Node contributors. All rights reserved. MIT license.',
        files: ['ext/a.ts', 'ext/b.ts']
      }
    ])
  })

  test('script files are found outside test folders, and a missing folder is an error', async () => {
    const root = fresh('scan')
    for (const path of [
      'ext/a.js',
      'ext/b.d.ts',
      'ext/c.mjs',
      'ext/tests/t.js',
      'ext/d.rs',
      'runtime/e.cjs'
    ]) {
      mkdirSync(join(root, dirname(path)), { recursive: true })
      writeFileSync(join(root, path), '')
    }
    assert.deepEqual(await scriptFiles(root, ['ext', 'runtime']), [
      'ext/a.js',
      'ext/b.d.ts',
      'ext/c.mjs',
      'runtime/e.cjs'
    ])
    await assert.rejects(scriptFiles(root, ['nope']), /cannot read nope in the Deno source/)
  })
})

describe('validateConfig', () => {
  test('the committed configuration is valid', () => {
    assert.deepEqual(validateConfig(JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'))), [])
  })

  test('reports every problem', () => {
    assert.deepEqual(validateConfig({}), ['missing "deno"'])
    const problems = validateConfig({
      deno: { version: '', sourceSha256: 'XYZ', licenseFiles: ['../x'], headerScan: 'ext' },
      crateUrl: 'https://x/{name}',
      crateFallbacks: {
        bad: [],
        'ok@1': [{ path: 'p' }, { path: 'q', url: 'u', encoding: 'hex' }]
      },
      spdxTexts: { MIT: {} },
      components: [{ name: 'c', files: [] }, null]
    })
    for (const message of [
      'deno: missing "version"',
      'deno: missing "commit"',
      'deno: "sourceSha256" must be 64 lowercase hex characters',
      'deno: "licenseFiles" must list relative paths inside the source',
      'deno: "headerScan" must be a list',
      '"crateUrl" must contain {name} and {version}',
      'crateFallbacks: "bad" must be name@version',
      'crateFallbacks bad: "files" must be a non-empty list',
      'crateFallbacks ok@1: every file needs "path" and "url"',
      'crateFallbacks ok@1: q: "encoding" can only be base64',
      'spdxTexts MIT: needs "url"',
      'c: missing "license"',
      'c: "files" must be a non-empty list',
      '(a component): missing "name"'
    ]) {
      assert.ok(problems.includes(message), `${message}\n${problems.join('\n')}`)
    }
    assert.ok(
      validateConfig({ deno: {}, crateUrl: '{name}{version}', components: 'x' }).includes(
        '"components" must be a list'
      )
    )
  })
})

describe('mapLimit', () => {
  test('keeps the order of the results and never runs more than the limit at once', async () => {
    let running = 0
    let most = 0
    const results = await mapLimit([30, 10, 20, 0], 2, async (ms, index) => {
      running++
      most = Math.max(most, running)
      await new Promise((resolveWait) => setTimeout(resolveWait, ms))
      running--
      return index
    })
    assert.deepEqual(results, [0, 1, 2, 3])
    assert.equal(most, 2)
    assert.deepEqual(await mapLimit([], 4, async () => 1), [])
  })
})

// ---------------------------------------------------------------------------------------------
// End to end, against a local server.
// ---------------------------------------------------------------------------------------------

const MIT_A = 'MIT License\n\nCopyright (c) A\n\nPermission is hereby granted...'
const APACHE = 'Apache License\nVersion 2.0'
const files = new Map()
let server
let base

/** Makes a tar.gz of `tree` ({ path: content }) under `top`, and serves it at `/name`. */
function serveTar(name, top, tree) {
  const dir = fresh('tree')
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(join(dir, top, dirname(path)), { recursive: true })
    writeFileSync(join(dir, top, path), content)
  }
  const out = join(fresh('tar'), name)
  execFileSync('/usr/bin/tar', ['-czf', out, '-C', dir, top])
  const data = readFileSync(out)
  files.set(`/${name}`, data)
  return sha256(data)
}

before(async () => {
  server = createServer((request, response) => {
    const data = files.get(request.url)
    if (!data) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200)
    response.end(data)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

/** A fake world: three crates, the Deno source, components, a fallback and a standard text. */
function world() {
  const own = serveTar('own-1.0.0.crate', 'own-1.0.0', {
    'Cargo.toml':
      '[package]\nname = "own"\nlicense = "MIT"\nrepository = "https://github.com/o/own"\n',
    'LICENSE-MIT': MIT_A,
    'vendor/zlib/LICENSE': 'zlib licence',
    'tests/LICENSE': 'not this',
    'src/lib.rs': ''
  })
  const fallback = serveTar('fallback-2.0.0.crate', 'fallback-2.0.0', {
    'Cargo.toml': '[package]\nname = "fallback"\nlicense = "Apache-2.0"\n'
  })
  const standard = serveTar('standard-0.1.0.crate', 'standard-0.1.0', {
    'Cargo.toml': '[package]\nname = "standard"\nlicense = "MIT OR Apache-2.0"\n'
  })
  const missing = serveTar('missing-0.0.1.crate', 'missing-0.0.1', {
    'Cargo.toml': '[package]\nname = "missing"\nlicense-file = "TERMS"\n'
  })
  const lock = [
    ['own', '1.0.0', own],
    ['fallback', '2.0.0', fallback],
    ['standard', '0.1.0', standard],
    ['missing', '0.0.1', missing]
  ]
    .map(
      ([name, version, checksum]) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${REGISTRY}"\nchecksum = "${checksum}"\n`
    )
    .join('\n')
  const source = serveTar('deno_src.tar.gz', 'deno', {
    'Cargo.lock': `${lock}\n[[package]]\nname = "deno"\nversion = "2.9.8"\n`,
    'cli/tsc/dts/node/LICENSE': 'node types licence',
    'ext/node/a.ts':
      '// Copyright 2018-2026 the Deno authors. MIT license.\n// Copyright Joyent, Inc. and other Node contributors.\nexport {}\n',
    'ext/node/tests/t.ts': '// Copyright Test Person\n'
  })
  files.set('/component/LICENSE', Buffer.from(APACHE))
  files.set('/component/LICENSE.b64', Buffer.from(Buffer.from('BSD text').toString('base64')))
  files.set(
    '/node/LICENSE',
    Buffer.from(
      'Node.js is licensed\nCopyright Node.js contributors\nThe externally maintained libraries used by Node.js are:\n- many'
    )
  )
  files.set('/fallback/LICENSE', Buffer.from(APACHE))
  files.set('/spdx/MIT.txt', Buffer.from('MIT standard text'))
  files.set('/spdx/Apache-2.0.txt', Buffer.from(APACHE))
  return {
    deno: {
      version: '2.9.8',
      commit: 'c'.repeat(40),
      sourceUrl: `${base}/deno_src.tar.gz`,
      sourceSha256: source,
      sourceRoot: 'deno',
      licenseFiles: ['cli/tsc/dts/node/LICENSE'],
      headerScan: ['ext']
    },
    crateUrl: `${base}/{name}-{version}.crate`,
    crateFallbacks: {
      'fallback@2.0.0': [{ path: 'o/fallback LICENSE', url: `${base}/fallback/LICENSE` }]
    },
    spdxTexts: {
      MIT: { url: `${base}/spdx/MIT.txt` },
      'Apache-2.0': { url: `${base}/spdx/Apache-2.0.txt` }
    },
    components: [
      {
        name: 'V8',
        license: 'BSD-3-Clause',
        repository: 'https://example.invalid/v8',
        commit: 'd'.repeat(40),
        files: [
          { path: 'LICENSE', url: `${base}/component/LICENSE.b64`, encoding: 'base64' },
          { path: 'third_party/x/LICENSE', url: `${base}/component/LICENSE` }
        ]
      },
      {
        name: 'Node.js',
        license: 'MIT',
        repository: 'https://example.invalid/node',
        commit: 'e'.repeat(40),
        files: [
          {
            path: 'LICENSE',
            url: `${base}/node/LICENSE`,
            until: 'The externally maintained libraries used by Node.js are:'
          }
        ]
      }
    ]
  }
}

describe('generate', () => {
  test('builds the notices from the source release, the crates and the components', async () => {
    const config = world()
    const work = fresh('work')
    const logged = []
    const text = await generate(config, {
      io: realIo(work),
      work,
      jobs: 2,
      log: (line) => logged.push(line)
    })
    assert.match(text, /^THIRD-PARTY NOTICES FOR DENO 2\.9\.8\n/)
    assert.match(text, /Deno's own 1 workspace crates/)
    assert.match(
      text,
      /own 1\.0\.0\n {2}licence: MIT\n {2}repository: https:\/\/github\.com\/o\/own\n {2}texts: \[T\d+\] LICENSE-MIT, \[T\d+\] vendor\/zlib\/LICENSE/
    )
    assert.ok(!text.includes('not this'))
    assert.match(
      text,
      /fallback 2\.0\.0\n {2}licence: Apache-2\.0\n {2}texts \(from the repository\): \[T\d+\] o\/fallback LICENSE \(http:/
    )
    assert.match(
      text,
      /standard 0\.1\.0\n {2}licence: MIT OR Apache-2\.0\n {2}texts \(standard text\): \[T\d+\] Apache-2\.0 \(standard text\), \[T\d+\] MIT \(standard text\)/
    )
    assert.match(text, /missing 0\.0\.1\n {2}licence: see TERMS\n {2}texts: none published/)
    assert.match(
      text,
      /1 crate\(s\) publish no licence text, and no standard text is pinned for their licence:\n {4}missing 0\.0\.1 \(no licence declared\)/
    )
    assert.match(text, /1 crate\(s\) publish no licence file of their own/)
    assert.match(text, /1 crate\(s\) publish no licence file, and their repository has none/)
    assert.match(
      text,
      /V8\n {2}licence: BSD-3-Clause\n {2}source: https:\/\/example\.invalid\/v8 at d{40}\n {2}texts: \[T\d+\] LICENSE, \[T\d+\] third_party\/x\/LICENSE/
    )
    assert.match(text, /BSD text/)
    assert.match(text, /Node.js is licensed\nCopyright Node.js contributors\n/)
    assert.ok(!text.includes('- many'))
    assert.match(text, /cli\/tsc\/dts\/node\/LICENSE: \[T\d+\]/)
    assert.match(
      text,
      /Notice 1, in 1 file\(s\): ext\/node\/a\.ts\n\n {4}Copyright Joyent, Inc\. and other Node contributors\./
    )
    assert.ok(!text.includes('Test Person'))
    // The Apache text is used by a crate fallback, a standard text and a component: kept once.
    assert.equal(text.split(APACHE).length - 1, 1)
    assert.ok(logged.some((line) => /4 crates from crates\.io/.test(line)))
    // The same inputs give the same file, whatever order the downloads finish in.
    const again = await generate(config, {
      io: realIo(fresh('work')),
      work: fresh('work2'),
      jobs: 4
    })
    assert.equal(again, text)
  })

  test('keeps crates in a cache, and uses a cached crate only while its SHA-256 matches', async () => {
    const config = world()
    const cache = fresh('cache')
    const work = fresh('work')
    await generate(config, { io: realIo(work), work, cache, jobs: 1 })
    const cached = join(cache, 'own-1.0.0.crate')
    assert.deepEqual(readFileSync(cached), files.get('/own-1.0.0.crate'))
    writeFileSync(cached, 'tampered')
    const work2 = fresh('work')
    await generate(config, { io: realIo(work2), work: work2, cache, jobs: 1 })
    assert.deepEqual(readFileSync(cached), files.get('/own-1.0.0.crate'))
  })

  test('refuses a download whose SHA-256 differs, an invalid configuration, and a crate without Cargo.toml', async () => {
    const config = world()
    config.deno.sourceSha256 = '0'.repeat(64)
    const work = fresh('work')
    await assert.rejects(
      generate(config, { io: realIo(work), work }),
      /SHA-256 is [0-9a-f]{64}, expected 0{64}/
    )
    await assert.rejects(
      generate({}, { io: realIo(work), work }),
      /invalid configuration:\n {2}- missing "deno"/
    )

    const broken = world()
    const bad = serveTar('bad-1.0.0.crate', 'bad-1.0.0', { 'README.md': 'x' })
    const source = serveTar('deno_src.tar.gz', 'deno', {
      'Cargo.lock': `[[package]]\nname = "bad"\nversion = "1.0.0"\nsource = "${REGISTRY}"\nchecksum = "${bad}"\n`,
      'cli/tsc/dts/node/LICENSE': 'x',
      'ext/a.ts': ''
    })
    broken.deno.sourceSha256 = source
    const work2 = fresh('work')
    await assert.rejects(
      generate(broken, { io: realIo(work2), work: work2 }),
      /bad-1\.0\.0\.crate has no bad-1\.0\.0\/Cargo\.toml/
    )
  })

  test('a missing file on the server is an error', async () => {
    const io = realIo(fresh('io'))
    await assert.rejects(io.fetchText(`${base}/nothing-here`), /HTTP 404/)
  })
})

describe('main', () => {
  test('writes the notices where --out says', async () => {
    const config = world()
    const dir = fresh('main')
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify(config))
    const out = join(dir, 'nested', 'NOTICES.txt')
    const logged = []
    const code = await main(
      ['--config', configPath, '--out', out, '--jobs', '3', '--cache', join(dir, 'cache')],
      {
        log: (line) => logged.push(line),
        error: (line) => logged.push(line)
      }
    )
    assert.equal(code, 0, logged.join('\n'))
    assert.match(readFileSync(out, 'utf8'), /^THIRD-PARTY NOTICES FOR DENO 2\.9\.8/)
    assert.match(logged.at(-1), /deno-notices: wrote .*NOTICES\.txt \(\d+ bytes\)/)
  })

  test('wrong usage exits 2; an unreadable configuration or a failure exits 1', async () => {
    const err = []
    const quiet = { log: () => {}, error: (line) => err.push(line) }
    assert.equal(await main(['--nope'], quiet), 2)
    assert.equal(await main(['--jobs', '0'], quiet), 2)
    assert.equal(await main(['--config', join(scratch, 'missing.json')], quiet), 1)
    assert.match(err.join('\n'), /cannot read .*missing\.json/)
    const dir = fresh('bad')
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, '{}')
    assert.equal(await main(['--config', configPath, '--out', join(dir, 'x.txt')], quiet), 1)
    assert.match(err.at(-1), /invalid configuration/)
  })

  test('as a program, it exits with its code', () => {
    const result = spawnSync(process.execPath, [join(HERE, 'deno-notices.mjs'), '--jobs', 'x'], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--jobs must be a whole number/)
  })
})

describe('the committed notices', () => {
  test('ship with Deno: tools.json lists them, and they name this version', () => {
    const tools = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8')).tools
    const deno = tools.find((tool) => tool.name === 'deno')
    assert.ok(deno.licenseFiles.includes('licenses/deno/THIRD-PARTY-NOTICES.txt'))
    const notices = readFileSync(join(HERE, 'licenses/deno/THIRD-PARTY-NOTICES.txt'), 'utf8')
    assert.match(
      notices,
      new RegExp(`^THIRD-PARTY NOTICES FOR DENO ${deno.version.replaceAll('.', '\\.')}\\n`)
    )
    const config = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'))
    assert.equal(config.deno.version, deno.version)
    assert.match(notices, /- Every crate above has a licence text\./)
  })

  test('an unreadable cache file is downloaded again', async () => {
    const config = world()
    const cache = fresh('cache')
    const blocked = join(cache, 'own-1.0.0.crate')
    writeFileSync(blocked, 'x')
    chmodSync(blocked, 0o000)
    const work = fresh('work')
    try {
      await generate(config, { io: realIo(work), work, cache, jobs: 1 })
      assert.deepEqual(readFileSync(blocked), files.get('/own-1.0.0.crate'))
    } finally {
      chmodSync(blocked, 0o644)
    }
  })
})
