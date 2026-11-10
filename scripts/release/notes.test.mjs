// Tests for notes.mjs. Run:
//   node --test --experimental-test-coverage --test-coverage-include='scripts/release/notes.mjs' \
//     scripts/release/notes.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assetNames,
  buildNotes,
  bundledPrograms,
  changelogSection,
  checkRelease,
  checksumTable,
  DEFAULTS,
  findSection,
  honestLimits,
  installSection,
  main,
  missingAssets,
  parseChecksums,
  sections,
  sourceAssets,
  VERSION
} from './notes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'notes.mjs')
const FIXTURES = join(HERE, 'fixtures')
const fixture = (name) => join(FIXTURES, name)
const read = (path) => readFileSync(path, 'utf8')
const CHANGELOG = read(fixture('CHANGELOG.md'))
const README = read(fixture('README.md'))
const MANIFEST = JSON.parse(read(fixture('tools.json')))
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

// Scratch files for the CLI tests, removed when the tests finish.
const scratch = mkdtempSync(join(tmpdir(), 'mergelane-release-notes-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let scratchCount = 0
function scratchFile(contents) {
  const path = join(scratch, `file-${++scratchCount}`)
  writeFileSync(path, contents)
  return path
}

/** Runs main with the fixture files, capturing output. Returns { code, out, err }. */
function run(args) {
  const out = []
  const err = []
  const code = main(
    [
      '--changelog',
      fixture('CHANGELOG.md'),
      '--readme',
      fixture('README.md'),
      '--manifest',
      fixture('tools.json'),
      '--package',
      fixture('package.json'),
      ...args
    ],
    { log: (line) => out.push(line), error: (line) => err.push(line) }
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('CHANGELOG.md sections', () => {
  test('a section in the middle: its text up to the next version, with subheadings and code', () => {
    const section = changelogSection(CHANGELOG, '0.2.0')
    assert.match(section, /^### Added\n\n- Video downloads\./)
    assert.match(section, /### Fixed\n\n- A crash on wake\.$/)
    // A "## [x]" line inside a fenced code block is text, not the next section.
    assert.ok(section.includes('## [9.9.9] inside a code block is not a heading'))
    assert.ok(!section.includes('The first release'))
  })

  test('a missing version gives null', () => {
    assert.equal(changelogSection(CHANGELOG, '0.4.0'), null)
    assert.equal(changelogSection(CHANGELOG, '9.9.9'), null, 'the fenced "## [9.9.9]" does not count')
    assert.equal(changelogSection('', '0.1.0'), null)
  })

  test('the last section stops before the link definitions at the end of the file', () => {
    assert.equal(changelogSection(CHANGELOG, '0.1.0'), '### Added\n\n- The first release.')
  })

  test('only an exact version matches, and [Unreleased] is never a version', () => {
    assert.equal(changelogSection(CHANGELOG, '0.2'), null)
    assert.equal(changelogSection(CHANGELOG, '0.2.0-beta.1'), null)
    assert.equal(changelogSection(CHANGELOG, 'Unreleased'), '### Added\n\n- Something not released yet.')
  })

  test('an empty section is an empty string, not null', () => {
    assert.equal(changelogSection(CHANGELOG, '0.3.0'), '')
  })

  test('a level-1 heading ends a section, CRLF line ends and ~~~ fences are understood', () => {
    const markdown = [
      '## [1.0.0]',
      '~~~',
      '# not a heading',
      '~~~',
      'text',
      '# Appendix',
      'not part of 1.0.0',
      '## Closed ##'
    ].join('\r\n')
    assert.equal(changelogSection(markdown, '1.0.0'), '~~~\n# not a heading\n~~~\ntext')
    assert.deepEqual(
      sections(markdown).map(({ heading }) => heading),
      ['[1.0.0]', 'Closed']
    )
  })

  test('a longer fence is closed only by a fence at least as long, of the same kind', () => {
    const markdown = ['## A', '````', '```', '## inside', '~~~', '````', '## B'].join('\n')
    assert.deepEqual(
      sections(markdown).map(({ heading }) => heading),
      ['A', 'B']
    )
  })

  test('findSection returns the first matching heading', () => {
    assert.equal(findSection('## One\nfirst\n## One\nsecond', (h) => h === 'One'), 'first')
    assert.equal(findSection('## One\nfirst', () => false), null)
  })
})

describe('README.md honest limits', () => {
  test('the fixture README section, up to the next heading', () => {
    const limits = honestLimits(README)
    assert.match(limits, /^- \*\*One connection always uses one link\.\*\*/)
    assert.ok(limits.includes('## not a heading'), 'the fenced line stays in the text')
    assert.ok(!limits.includes('Download the DMG'))
  })

  test("the repository's own README has the section the workflow copies", () => {
    const limits = honestLimits(read(DEFAULTS.readme))
    assert.ok(limits, 'README.md must keep a "## ... (honest limits)" section')
    assert.match(limits, /One connection always uses one link/)
  })

  test('a README without the section gives null', () => {
    assert.equal(honestLimits('# Mergelane\n\n## Requirements\n\n- macOS 27'), null)
  })
})

describe('checkRelease', () => {
  const ready = { version: '0.2.0', packageVersion: '0.2.0', changelog: CHANGELOG }

  test('a matching version with a changelog section is ready', () => {
    assert.deepEqual(checkRelease(ready), [])
  })

  test('a malformed version is the only problem reported', () => {
    assert.deepEqual(checkRelease({ ...ready, version: '0.2' }), [
      '"0.2" is not a version like 1.2.3'
    ])
    assert.deepEqual(checkRelease({ ...ready, version: 'v0.2.0' }), [
      '"v0.2.0" is not a version like 1.2.3: leave out the leading "v"'
    ])
  })

  test('a different package version and a missing section are both reported', () => {
    assert.deepEqual(checkRelease({ ...ready, version: '0.4.0' }), [
      'app/package.json has version "0.2.0", not "0.4.0": bump it first',
      'CHANGELOG.md has no "## [0.4.0]" section: add one with this release\'s changes'
    ])
  })

  test('a missing package version is reported', () => {
    assert.match(checkRelease({ ...ready, packageVersion: undefined })[0], /has version undefined/)
  })

  test('an empty section is reported', () => {
    assert.deepEqual(checkRelease({ ...ready, version: '0.3.0', packageVersion: '0.3.0' }), [
      'CHANGELOG.md\'s "## [0.3.0]" section is empty'
    ])
  })

  test('the version pattern', () => {
    for (const good of ['0.1.0', '1.20.300', '1.0.0-beta.1', '2.0.0-rc-1']) {
      assert.ok(VERSION.test(good), good)
    }
    for (const bad of ['', '1', '1.2', '01.2.3', '1.2.3.4', 'v1.2.3', '1.2.3+build', '1.2.3-', '1.2.3 ', '1.2.3;rm']) {
      assert.ok(!VERSION.test(bad), JSON.stringify(bad))
    }
  })
})

describe('checksums', () => {
  test('shasum output in text and binary mode, ignoring blank lines', () => {
    const text = `${SHA_A}  Mergelane-0.2.0-arm64.dmg\n\n${SHA_B} *Mergelane-0.2.0-arm64-mac.zip\r\n`
    assert.deepEqual(parseChecksums(text), [
      { file: 'Mergelane-0.2.0-arm64.dmg', sha256: SHA_A },
      { file: 'Mergelane-0.2.0-arm64-mac.zip', sha256: SHA_B }
    ])
  })

  test('a malformed line is refused with its line number', () => {
    assert.throws(
      () => parseChecksums(`${SHA_A}  ok.dmg\nnot a checksum`),
      /checksum line 2 is not "<sha256>  <file>": "not a checksum"/
    )
    assert.throws(() => parseChecksums(`${SHA_A.toUpperCase()}  x.dmg`), /line 1/)
    assert.throws(() => parseChecksums(`${SHA_A.slice(1)}  x.dmg`), /line 1/)
  })

  test('a path instead of a bare file name is refused', () => {
    assert.throws(
      () => parseChecksums(`${SHA_A}  dist/Mergelane-0.2.0-arm64.dmg`),
      /names a path, dist\/Mergelane-0\.2\.0-arm64\.dmg: run shasum next to the files/
    )
  })

  test('an empty checksum file is refused', () => {
    assert.throws(() => parseChecksums('\n\n'), /lists no files/)
  })

  test('the table lists every file with its hash', () => {
    assert.equal(
      checksumTable([
        { file: 'a.dmg', sha256: SHA_A },
        { file: 'b.zip', sha256: SHA_B }
      ]),
      `| File | SHA-256 |\n| --- | --- |\n| \`a.dmg\` | \`${SHA_A}\` |\n| \`b.zip\` | \`${SHA_B}\` |`
    )
  })

  test("the DMG and the zip must both be listed, by electron-builder's names", () => {
    assert.deepEqual(assetNames('1.2.3'), {
      dmg: 'Mergelane-1.2.3-arm64.dmg',
      zip: 'Mergelane-1.2.3-arm64-mac.zip'
    })
    const entries = parseChecksums(read(fixture('SHA256SUMS')))
    assert.deepEqual(missingAssets(entries, '0.2.0'), [])
    assert.deepEqual(missingAssets(entries.slice(0, 1), '0.2.0'), ['Mergelane-0.2.0-arm64-mac.zip'])
    assert.deepEqual(missingAssets(entries, '0.3.0'), [
      'Mergelane-0.3.0-arm64.dmg',
      'Mergelane-0.3.0-arm64-mac.zip'
    ])
  })

  test('with the manifest, every source archive and build script the notes name must be listed', () => {
    const entries = parseChecksums(read(fixture('SHA256SUMS')))
    assert.deepEqual(missingAssets(entries, '0.2.0', MANIFEST), [])
    assert.deepEqual(missingAssets(entries.slice(0, 3), '0.2.0', MANIFEST), [
      'ffmpeg-9.0.2-source.tar.xz',
      'ffmpeg-9.0.2-build-ffmpeg.sh'
    ])
  })
})

describe('the programs inside the app, and their source', () => {
  test('one entry per tool: its licence, the attached source and build script, and upstream', () => {
    assert.equal(
      bundledPrograms(MANIFEST),
      [
        '- **yt-dlp 2026.10.26**: GPL-3.0-or-later for this bundled executable',
        '  - Source code: `yt-dlp-2026.10.26-source.tar.gz`, attached to this release (SHA-256 `21f942d258d25cc4e60b4982a25c423460f0bebb835f38e6dfd1fcb140087f95`)',
        '  - Upstream: <https://example.org/yt-dlp/yt-dlp.tar.gz>',
        '- **FFmpeg 9.0.2**: LGPL-2.1-or-later',
        '  - Source code: `ffmpeg-9.0.2-source.tar.xz`, attached to this release (SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`)',
        "  - Build script: `ffmpeg-9.0.2-build-ffmpeg.sh`, attached to this release (`scripts/media-tools/build-ffmpeg.sh` in this version's source code)",
        '  - Upstream: <https://example.org/ffmpeg/ffmpeg-9.0.2.tar.xz>',
        '- **Deno 2.9.8**: MIT',
        '  - Source code: <https://example.org/deno/deno_src.tar.gz> (not attached: its licence does not ask for it)'
      ].join('\n')
    )
    assert.deepEqual(sourceAssets(MANIFEST), [
      'yt-dlp-2026.10.26-source.tar.gz',
      'ffmpeg-9.0.2-source.tar.xz',
      'ffmpeg-9.0.2-build-ffmpeg.sh'
    ])
  })

  test("the repository's own tools.json: yt-dlp GPL, FFmpeg LGPL, Deno MIT, sources attached", () => {
    const manifest = JSON.parse(read(DEFAULTS.manifest))
    const text = bundledPrograms(manifest)
    for (const tool of manifest.tools) assert.ok(text.includes(`<${tool.sourceUrl}>`), tool.name)
    assert.match(text, /^- \*\*yt-dlp [\d.]+\*\*: GPL-3\.0-or-later\b/m)
    assert.match(text, /^- \*\*FFmpeg [\d.]+\*\*: LGPL-2\.1-or-later\b/m)
    assert.match(text, /^- \*\*Deno [\d.]+\*\*: MIT$/m)
    // ADR-0027: yt-dlp's and FFmpeg's source, and FFmpeg's build script, travel with the release.
    const ffmpeg = manifest.tools.find((tool) => tool.name === 'ffmpeg')
    const ytdlp = manifest.tools.find((tool) => tool.name === 'yt-dlp')
    assert.deepEqual(sourceAssets(manifest), [
      `yt-dlp-${ytdlp.version}-source.tar.gz`,
      `ffmpeg-${ffmpeg.version}-source.tar.xz`,
      `ffmpeg-${ffmpeg.version}-build-ffmpeg.sh`
    ])
  })

  test('a tool without an https source link stops the notes', () => {
    const [ytdlp, ffmpeg] = MANIFEST.tools
    const without = { tools: [ytdlp, { ...ffmpeg, sourceUrl: undefined }] }
    assert.throws(() => bundledPrograms(without), /ffmpeg has no https sourceUrl/)
    const plainHttp = { tools: [{ ...ytdlp, sourceUrl: 'http://example.org/src.tar.gz' }] }
    assert.throws(() => bundledPrograms(plainHttp), /yt-dlp has no https sourceUrl/)
    assert.throws(() => bundledPrograms({ tools: [null] }), /a tool has no https sourceUrl/)
  })

  test('a GPL or LGPL program whose source is not pinned stops the notes', () => {
    const [ytdlp, ffmpeg] = MANIFEST.tools
    assert.throws(
      () => bundledPrograms({ tools: [ytdlp, { ...ffmpeg, sourceSha256: undefined }] }),
      /ffmpeg is LGPL-2\.1-or-later, but the media-tools manifest pins no sourceSha256/
    )
  })

  test('a manifest without tools stops the notes', () => {
    for (const manifest of [undefined, {}, { tools: [] }, { tools: 'yt-dlp' }]) {
      assert.throws(() => bundledPrograms(manifest), /has no "tools" list/)
      assert.throws(() => sourceAssets(manifest), /has no "tools" list/)
    }
  })
})

describe('the notes', () => {
  test('the install section names the version, the steps and the requirements', () => {
    const text = installSection('1.2.3')
    for (const expected of [
      'macOS 27 or later, Apple silicon only',
      'Download `Mergelane-1.2.3-arm64.dmg`',
      'drag **Mergelane** to **Applications**',
      '**System Settings › Privacy & Security**',
      '**Open Anyway**',
      'xattr -dr com.apple.quarantine /Applications/Mergelane.app',
      '`Mergelane-1.2.3-arm64-mac.zip` holds the same app'
    ]) {
      assert.ok(text.includes(expected), expected)
    }
  })

  test('the sections come in order: changes, install, limits, checksums, programs', () => {
    const notes = buildNotes({
      version: '0.2.0',
      changes: changelogSection(CHANGELOG, '0.2.0'),
      limits: honestLimits(README),
      checksums: parseChecksums(read(fixture('SHA256SUMS'))),
      manifest: MANIFEST
    })
    assert.ok(notes.startsWith("## What's new\n\n### Added\n"))
    const order = [
      '### Added',
      '## Requirements',
      '## Install',
      '## What to expect (honest limits)',
      '**One connection always uses one link.**',
      '## Checksums',
      `| \`Mergelane-0.2.0-arm64.dmg\` | \`${SHA_A}\` |`,
      '| `ffmpeg-9.0.2-build-ffmpeg.sh` |',
      '## Open-source programs inside the app',
      'each shipped as\na separate executable under its own licence',
      '- **yt-dlp 2026.10.26**',
      '- **FFmpeg 9.0.2**: LGPL-2.1-or-later',
      '<https://example.org/ffmpeg/ffmpeg-9.0.2.tar.xz>',
      '- **Deno 2.9.8**: MIT'
    ].map((marker) => {
      const at = notes.indexOf(marker)
      assert.ok(at >= 0, `missing: ${marker}`)
      return at
    })
    assert.deepEqual(order, [...order].sort((a, b) => a - b))
    assert.ok(notes.includes('The source code of each program under the GPL or the LGPL is attached'))
    assert.ok(!notes.includes('GNU General Public License. Their'), 'no longer says every program is GPL')
    assert.ok(notes.endsWith('(not attached: its licence does not ask for it)\n'))
  })
})

describe('command line (exit codes)', () => {
  test('--check passes for a ready version: exit 0', () => {
    const { code, out, err } = run(['--version', '0.2.0', '--check'])
    assert.equal(code, 0, err)
    assert.equal(out, 'release-notes: 0.2.0 is ready: app/package.json and CHANGELOG.md agree')
  })

  test('--check fails with every problem for a version that is not ready: exit 1', () => {
    const { code, err } = run(['--version', '0.1.0', '--check'])
    assert.equal(code, 1)
    assert.equal(err, 'release-notes: app/package.json has version "0.2.0", not "0.1.0": bump it first')
    const missing = run(['--version', '0.4.0', '--check'])
    assert.equal(missing.code, 1)
    assert.equal(missing.err.split('\n').length, 2)
  })

  test('the notes go to --out: exit 0', () => {
    const out = join(scratch, 'notes.md')
    const result = run(['--version', '0.2.0', '--checksums', fixture('SHA256SUMS'), '--out', out])
    assert.equal(result.code, 0, result.err)
    assert.equal(result.out, `release-notes: wrote ${out}`)
    const notes = read(out)
    assert.ok(notes.startsWith("## What's new\n\n### Added\n\n- Video downloads."))
    assert.ok(notes.includes(`| \`Mergelane-0.2.0-arm64-mac.zip\` | \`${SHA_B}\` |`))
  })

  test('without --out the notes are printed: exit 0', () => {
    const { code, out } = run(['--version', '0.2.0', '--checksums', fixture('SHA256SUMS')])
    assert.equal(code, 0)
    assert.ok(out.includes('## Install'))
  })

  test('wrong usage: exit 2, with the usage text', () => {
    for (const args of [
      [],
      ['--check'],
      ['--version', '0.2.0'],
      ['--version', '0.2.0', '--check', '--checksums', fixture('SHA256SUMS')],
      ['--version', '0.2.0', '--check', '--out', join(scratch, 'x.md')],
      ['--version', '0.2.0', '--check', '--unknown'],
      ['--version', '0.2.0', '--check', 'stray-argument'],
      ['--version']
    ]) {
      const { code, err } = run(args)
      assert.equal(code, 2, `${args.join(' ')}: ${err}`)
      assert.match(err, /usage: node scripts\/release\/notes\.mjs/)
    }
  })

  test("a checksum file without this version's zip: exit 1", () => {
    const sums = scratchFile(
      read(fixture('SHA256SUMS'))
        .split('\n')
        .filter((line) => !line.endsWith('-mac.zip'))
        .join('\n')
    )
    const { code, err } = run(['--version', '0.2.0', '--checksums', sums])
    assert.equal(code, 1)
    assert.equal(err, 'release-notes: the checksum file does not list Mergelane-0.2.0-arm64-mac.zip')
  })

  test('a malformed checksum file: exit 1', () => {
    const { code, err } = run(['--version', '0.2.0', '--checksums', scratchFile('garbage\n')])
    assert.equal(code, 1)
    assert.match(err, /checksum line 1/)
  })

  test('a README without honest limits: exit 1', () => {
    const readme = scratchFile('# Mergelane\n\n## Installing\n')
    const { code, err } = run([
      '--version',
      '0.2.0',
      '--checksums',
      fixture('SHA256SUMS'),
      '--readme',
      readme
    ])
    assert.equal(code, 1)
    assert.match(err, /README\.md has no "## \.\.\. \(honest limits\)" section/)
  })

  test('a checksum file without the attached sources: exit 1', () => {
    const sums = scratchFile(read(fixture('SHA256SUMS')).split('\n').slice(0, 2).join('\n'))
    const { code, err } = run(['--version', '0.2.0', '--checksums', sums])
    assert.equal(code, 1)
    assert.equal(
      err,
      'release-notes: the checksum file does not list yt-dlp-2026.10.26-source.tar.gz or ffmpeg-9.0.2-source.tar.xz or ffmpeg-9.0.2-build-ffmpeg.sh'
    )
  })

  test('a manifest without a source link: exit 1', () => {
    const manifest = scratchFile(JSON.stringify({ tools: [{ name: 'ffmpeg', version: '1' }] }))
    const { code, err } = run([
      '--version',
      '0.2.0',
      '--checksums',
      fixture('SHA256SUMS'),
      '--manifest',
      manifest
    ])
    assert.equal(code, 1)
    assert.match(err, /ffmpeg has no https sourceUrl/)
  })

  test('unreadable or invalid input files: exit 1, naming the file', () => {
    const missing = join(scratch, 'does-not-exist')
    const cases = [
      [['--changelog', missing], /cannot read the changelog .*does-not-exist/],
      [['--package', scratchFile('{ not json')], /the app package file .* is not valid JSON/],
      [['--checksums', missing], /cannot read the checksum file/]
    ]
    for (const [extra, pattern] of cases) {
      const args = ['--version', '0.2.0', ...extra]
      if (!extra.includes('--checksums')) args.push('--check')
      const { code, err } = run(args)
      assert.equal(code, 1, err)
      assert.match(err, pattern)
    }
  })

  test('run as a program, the exit code reaches the shell', () => {
    const files = [
      '--changelog',
      fixture('CHANGELOG.md'),
      '--package',
      fixture('package.json')
    ]
    const node = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    const ready = node(['--version', '0.2.0', '--check', ...files])
    assert.equal(ready.status, 0, ready.stderr)
    assert.match(ready.stdout, /0\.2\.0 is ready/)
    assert.equal(node(['--version', '0.1.0', '--check', ...files]).status, 1)
    assert.equal(node(['--check', ...files]).status, 2)
  })
})
