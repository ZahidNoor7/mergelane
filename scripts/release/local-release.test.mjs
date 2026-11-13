// Tests for local-release.mjs. Run:
//   node --test --experimental-test-coverage --test-coverage-include='scripts/release/local-release.mjs' \
//     scripts/release/local-release.test.mjs
// Nothing is built or uploaded: every command goes to a fake runner that records it and plays the
// part of the real one (writing the files electron-builder, sources.mjs and notes.mjs would).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../ci/local.mjs'
import {
  branchProblems,
  checksums,
  commandEnv,
  main,
  makeRunner,
  MIRRORS,
  parseCli,
  release,
  releaseArgs,
  repoFromBuilderConfig,
  ROOT,
  stepKey,
  tagProblems,
  treeProblems,
  openAppProblems,
  OPEN_APP,
  UsageError
} from './local-release.mjs'
import { parseChecksums } from './notes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'mergelane-local-release-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let count = 0
const fresh = (name) => {
  const dir = join(scratch, `${name}-${++count}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('parseCli', () => {
  test('needs a plain version, and defaults to a dry run without branch skips', () => {
    const options = parseCli(['--version', '0.1.0'])
    assert.equal(options.tag, 'v0.1.0')
    assert.equal(options.upload, false)
    assert.equal(options.skipBranchChecks, false)
    assert.equal(options.changelog, null)
    assert.equal(options.root, ROOT)
    assert.equal(options.logs, join(ROOT, 'local-ci-logs'))
    assert.equal(options.windows, true)
    assert.equal(parseCli(['--version', '1.2.3-beta.1', '--upload']).upload, true)
    assert.equal(parseCli(['--version', '0.1.0', '--mac-only']).windows, false)
  })

  for (const [args, message] of [
    [[], /--version is required/],
    [['--version', 'v1.2.3'], /not a version/],
    [['--version', '1.2.3', '--nope'], /Unknown option/],
    [['--version', '1.2.3', '--upload', '--skip-branch-checks'], /dry run only/],
    [['--version', '1.2.3', '--upload', '--changelog', 'x.md'], /dry run only/],
    [['--version', '1.2.3', '--upload', '--mac-only'], /dry run only; a release carries the Windows/]
  ]) {
    test(`refuses ${args.join(' ') || 'no arguments'}`, () => {
      assert.throws(
        () => parseCli(args),
        (error) => error instanceof UsageError && message.test(error.message)
      )
    })
  }
})

describe('the checks', () => {
  test("the repository comes from electron-builder.yml's publish section", () => {
    assert.equal(
      repoFromBuilderConfig(readFileSync(join(ROOT, 'app/electron-builder.yml'), 'utf8')),
      'ZahidNoor7/mergelane'
    )
    assert.equal(
      repoFromBuilderConfig('publish:\n  provider: github\n  owner: \'me\'\n  repo: "app"\n'),
      'me/app'
    )
    assert.throws(() => repoFromBuilderConfig('appId: x\n'), /no publish owner/)
  })

  test('HEAD must be main and equal origin/main', () => {
    assert.deepEqual(branchProblems({ branch: 'main', head: 'a', originHead: 'a' }), [])
    assert.match(
      branchProblems({ branch: 'topic', head: 'a', originHead: 'a' })[0],
      /HEAD is topic, not main/
    )
    assert.match(branchProblems({ branch: '', head: 'a', originHead: 'a' })[0], /HEAD is detached/)
    assert.match(
      branchProblems({ branch: 'main', head: 'a', originHead: '' })[0],
      /origin has no main/
    )
    assert.match(
      branchProblems({ branch: 'main', head: 'a', originHead: 'b' })[0],
      /origin\/main is b: pull or push/
    )
  })

  test('the working tree must be clean', () => {
    assert.deepEqual(openAppProblems(''), [])
    assert.deepEqual(openAppProblems('\n'), [])
    assert.match(openAppProblems('123\n')[0], /Mergelane is open/)
    assert.equal(OPEN_APP, '/Mergelane.app/Contents/MacOS/Mergelane')
    assert.deepEqual(treeProblems(''), [])
    const many = Array.from({ length: 12 }, (_, i) => ` M file${i}`).join('\n')
    const [problem] = treeProblems(many)
    assert.match(problem, /12 uncommitted change/)
    assert.match(problem, /file9\n {4}\.\.\. and 2 more$/)
  })

  test('neither the tag nor a release may exist', () => {
    assert.deepEqual(
      tagProblems({ tag: 'v1.0.0', localTag: '', remoteTags: '', releases: 'v0.9.0\n' }),
      []
    )
    const all = tagProblems({
      tag: 'v1.0.0',
      localTag: 'abc',
      remoteTags: 'abc\trefs/tags/v1.0.0\n',
      releases: 'v1.0.0\n'
    })
    assert.equal(all.length, 3)
    assert.match(all[0], /exists here \(at abc\)/)
    assert.match(all[1], /exists on origin/)
    assert.match(all[2], /already has a release for v1\.0\.0/)
  })
})

describe('the release files', () => {
  test('SHA256SUMS lists the DMG, the zip, the installers and the sources as shasum does, and notes.mjs reads it', async () => {
    const dist = fresh('dist')
    mkdirSync(join(dist, 'sources'))
    writeFileSync(join(dist, 'Mergelane-1.0.0-arm64.dmg'), 'dmg')
    writeFileSync(join(dist, 'Mergelane-1.0.0-arm64-mac.zip'), 'zip')
    writeFileSync(join(dist, 'Mergelane-1.0.0-x64-setup.exe'), 'x64')
    writeFileSync(join(dist, 'Mergelane-1.0.0-arm64-setup.exe'), 'arm64')
    writeFileSync(join(dist, 'sources', 'b-source.tar.gz'), 'b')
    writeFileSync(join(dist, 'sources', 'a-build.sh'), 'a')
    writeFileSync(join(dist, 'sources', '.DS_Store'), '')
    const { text, sources } = await checksums(dist, '1.0.0')
    assert.deepEqual(sources, ['a-build.sh', 'b-source.tar.gz'])
    const files = parseChecksums(text).map(({ file }) => file)
    assert.deepEqual(files, [
      'Mergelane-1.0.0-arm64.dmg',
      'Mergelane-1.0.0-arm64-mac.zip',
      'Mergelane-1.0.0-x64-setup.exe',
      'Mergelane-1.0.0-arm64-setup.exe',
      'a-build.sh',
      'b-source.tar.gz'
    ])
    // A --mac-only dry run lists no installers.
    const macOnly = parseChecksums((await checksums(dist, '1.0.0', { windows: false })).text)
    assert.deepEqual(
      macOnly.map(({ file }) => file).filter((file) => file.endsWith('.exe')),
      []
    )
    const shasum = spawnSync('shasum', ['-a', '256', 'Mergelane-1.0.0-arm64.dmg'], {
      cwd: dist,
      encoding: 'utf8'
    })
    assert.equal(text.split('\n')[0], shasum.stdout.trim())
  })

  test("gh's arguments make a draft, a pre-release for a pre-release version, and attach every file", () => {
    const args = releaseArgs({
      version: '1.0.0',
      sha: 'abc',
      notes: '/n.md',
      dist: '/d',
      sources: ['s1']
    })
    assert.deepEqual(args, [
      'release',
      'create',
      'v1.0.0',
      '--draft',
      '--target',
      'abc',
      '--title',
      'Mergelane 1.0.0',
      '--notes-file',
      '/n.md',
      '/d/Mergelane-1.0.0-arm64.dmg',
      '/d/Mergelane-1.0.0-arm64-mac.zip',
      '/d/Mergelane-1.0.0-x64-setup.exe',
      '/d/Mergelane-1.0.0-arm64-setup.exe',
      '/d/SHA256SUMS',
      '/d/sources/s1'
    ])
    const macOnly = releaseArgs({
      version: '1.0.0',
      sha: 'abc',
      notes: '/n.md',
      dist: '/d',
      sources: [],
      windows: false
    })
    assert.ok(!macOnly.some((arg) => arg.endsWith('-setup.exe')))
    assert.ok(
      releaseArgs({
        version: '1.0.0-beta.1',
        sha: 'a',
        notes: 'n',
        dist: 'd',
        sources: []
      }).includes('--prerelease')
    )
  })

  test('commands run without ELECTRON_RUN_AS_NODE or NODE_TEST_CONTEXT', () => {
    assert.deepEqual(
      commandEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_TEST_CONTEXT: 'x', PATH: '/bin' }),
      { PATH: '/bin' }
    )
  })
})

describe('in step with release.yml', () => {
  test('every step of release.yml has its counterpart here, and nothing else', () => {
    const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'))
    const keys = workflow.jobs.release.steps.map(stepKey)
    assert.deepEqual([...keys].sort(), Object.keys(MIRRORS).sort())
    assert.equal(stepKey({ run: '  npm ci\n' }), 'npm ci')
    assert.equal(stepKey({ uses: 'actions/setup-go@abc' }), 'actions/setup-go')
  })
})

/**
 * A fake runner over a fake repository: it records each command and answers like the real one.
 * `answers` overrides the output of commands by their first two words.
 */
function fakeRepo({ version = '1.0.0', answers = {}, zipVersion = version, fail = null } = {}) {
  const root = fresh('repo')
  mkdirSync(join(root, 'app'), { recursive: true })
  mkdirSync(join(root, 'daemon'), { recursive: true })
  writeFileSync(
    join(root, 'app/electron-builder.yml'),
    'publish:\n  provider: github\n  owner: o\n  repo: r\n'
  )
  const dist = join(root, 'app/dist')
  mkdirSync(join(dist, 'stale'), { recursive: true })
  const calls = []
  const defaults = {
    'git symbolic-ref': 'main\n',
    'git rev-parse': 'abc123\n',
    'git ls-remote': '',
    'git status': '',
    'gh api': 'v0.9.0\n',
    plutil: `${zipVersion}\n`
  }
  async function run(command, args, options = {}) {
    calls.push({ command, args, options })
    const key = `${command} ${args[0]}`
    if (fail && key === fail) throw new Error(`${command} ${args.join(' ')} exited with 1`)
    if (command === 'npx' && args[0] === 'electron-builder') {
      mkdirSync(dist, { recursive: true })
      if (args.includes('--win')) {
        const arch = args.includes('--arm64') ? 'arm64' : 'x64'
        writeFileSync(join(dist, `Mergelane-${version}-${arch}-setup.exe`), `setup ${arch}`)
      } else {
        writeFileSync(join(dist, `Mergelane-${version}-arm64.dmg`), 'dmg')
        writeFileSync(join(dist, `Mergelane-${version}-arm64-mac.zip`), 'zip')
      }
    }
    if (command === 'node' && args[0] === 'scripts/media-tools/sources.mjs') {
      mkdirSync(args[1], { recursive: true })
      writeFileSync(join(args[1], 'ffmpeg-9.0.2-source.tar.xz'), 'src')
    }
    if (command === 'node' && args[0] === 'scripts/release/notes.mjs' && args.includes('--out')) {
      writeFileSync(args[args.indexOf('--out') + 1], '## notes\n')
    }
    if (command === 'git' && args[0] === 'rev-parse' && args.includes('-q')) {
      return { code: 1, stdout: answers['git tag'] ?? '' }
    }
    const answer = answers[key] ?? (command === 'plutil' ? defaults.plutil : defaults[key]) ?? ''
    return { code: 0, stdout: answer }
  }
  return { root, dist, calls, run }
}

const optionsFor = (root, extra = {}) => ({
  ...parseCli(['--version', '1.0.0', '--root', root]),
  ...extra
})

describe('release', () => {
  test('a dry run with the branch checks skipped builds and checks everything, and uploads nothing', async () => {
    const repo = fakeRepo()
    const printed = []
    const code = await release(
      optionsFor(repo.root, { skipBranchChecks: true, changelog: '/c.md' }),
      {
        run: repo.run,
        print: (line) => printed.push(line)
      }
    )
    assert.equal(code, 0)
    const commands = repo.calls.map(({ command, args }) => `${command} ${args.join(' ')}`)
    assert.ok(commands[0].startsWith('node --test --experimental-test-coverage'))
    assert.equal(
      commands[1],
      'node scripts/release/notes.mjs --version 1.0.0 --check --changelog /c.md'
    )
    assert.ok(
      !commands.some((line) => line.startsWith('git fetch') || line.startsWith('git status'))
    )
    assert.ok(
      commands.includes(
        'go build -trimpath -ldflags -X main.version=1.0.0 -o bin/mergelane-daemon ./cmd/mergelane-daemon'
      )
    )
    assert.ok(
      commands.includes(
        'go build -trimpath -ldflags -X main.version=1.0.0 -o bin/mergelane-nmhost ./cmd/mergelane-nmhost'
      )
    )
    assert.ok(commands.includes('node ../scripts/media-tools/fetch.mjs'))
    assert.ok(commands.includes('npx electron-builder --mac --publish never'))
    // The extension is built before the app that bundles it.
    assert.ok(
      commands.indexOf('npm run build:extension') < commands.indexOf('npx electron-vite build')
    )
    assert.ok(commands.includes('npm run build:extension'))
    assert.ok(commands.includes('node ../scripts/ci/audit-fuses.mjs dist/mac-arm64/Mergelane.app'))
    assert.ok(
      commands.includes(
        'bash ../scripts/ci/package-test.sh --local dist/Mergelane-1.0.0-arm64.dmg 1.0.0'
      )
    )
    assert.ok(commands.some((line) => line.startsWith('codesign --verify --deep --strict')))
    assert.ok(commands.at(-1).includes('--changelog /c.md'))
    assert.ok(!commands.some((line) => line.startsWith('gh release')))
    // The Windows installers, after the Mac app's checks and before the sources, in this order.
    const windows = [
      'node scripts/windows/build-helpers.mjs',
      'npm run fetch:media-tools:win',
      'npx electron-builder --win --x64 --config electron-builder.win.yml --publish never',
      'npx electron-builder --win --arm64 --config electron-builder.win.yml --publish never',
      'node scripts/windows/check-build.mjs --version 1.0.0',
      `node scripts/media-tools/sources.mjs ${join(repo.dist, 'sources')}`,
      // uBO Lite, in the browser extension (ADR-0063).
      `node scripts/media-tools/sources.mjs ${join(repo.dist, 'sources')} --manifest scripts/adblock/ubol.json`,
      `node scripts/media-tools/sources.mjs ${join(repo.dist, 'sources')} --manifest scripts/media-tools/tools-windows-x64.json`,
      `node scripts/media-tools/sources.mjs ${join(repo.dist, 'sources')} --manifest scripts/media-tools/tools-windows-arm64.json`
    ].map((line) => commands.indexOf(line))
    assert.ok(windows.every((at) => at > 0), String(windows))
    assert.deepEqual([...windows].sort((a, b) => a - b), windows)
    assert.ok(commands.findIndex((line) => line.startsWith('codesign --verify')) < windows[0])
    assert.match(commands.at(-1), /--windows-manifest scripts\/media-tools\/tools-windows-x64\.json/)
    assert.match(commands.at(-1), /--extension-manifest scripts\/adblock\/ubol\.json/)
    // A fresh app/dist: nothing from an earlier build is left to upload by mistake.
    assert.deepEqual(readdirSync(repo.dist).sort(), [
      'Mergelane-1.0.0-arm64-mac.zip',
      'Mergelane-1.0.0-arm64-setup.exe',
      'Mergelane-1.0.0-arm64.dmg',
      'Mergelane-1.0.0-x64-setup.exe',
      'SHA256SUMS',
      'release-notes.md',
      'sources'
    ])
    assert.match(readFileSync(join(repo.dist, 'SHA256SUMS'), 'utf8'), /  Mergelane-1\.0\.0-arm64-setup\.exe\n/)
    const text = printed.join('\n')
    assert.match(text, /DRY RUN: --skip-branch-checks/)
    assert.match(text, /DRY RUN finished/)
    assert.match(
      text,
      /command: gh release create v1\.0\.0 --draft --target abc123 --title "Mergelane 1\.0\.0"/
    )
    assert.match(
      text,
      /sources\/ffmpeg-9\.0\.2-source\.tar\.xz +3\.0 KB|sources\/ffmpeg-9\.0\.2-source\.tar\.xz +0\.0 KB/
    )
  })

  test('a --mac-only dry run leaves every Windows step and file out', async () => {
    const repo = fakeRepo()
    const printed = []
    const options = optionsFor(repo.root, { windows: false })
    assert.equal(await release(options, { run: repo.run, print: (line) => printed.push(line) }), 0)
    const commands = repo.calls.map(({ command, args }) => `${command} ${args.join(' ')}`)
    for (const windows of ['scripts/windows/', '--win', 'fetch:media-tools:win', 'tools-windows-']) {
      assert.ok(!commands.some((line) => line.includes(windows)), windows)
    }
    assert.ok(!readdirSync(repo.dist).some((name) => name.endsWith('-setup.exe')))
    assert.match(printed.join('\n'), /DRY RUN: --mac-only: the Windows installers are left out/)
  })

  test('a release checks the branch and the tree, then creates a draft with --upload', async () => {
    const repo = fakeRepo()
    const printed = []
    const code = await release(optionsFor(repo.root, { upload: true }), {
      run: repo.run,
      print: (line) => printed.push(line)
    })
    assert.equal(code, 0)
    const commands = repo.calls.map(({ command, args }) => `${command} ${args.join(' ')}`)
    assert.ok(commands.includes('git fetch --quiet origin main'))
    assert.ok(commands.includes('git status --porcelain'))
    const create = repo.calls.at(-1)
    assert.equal(create.command, 'gh')
    assert.deepEqual(create.args.slice(0, 4), ['release', 'create', 'v1.0.0', '--draft'])
    assert.deepEqual(create.options.extraEnv, { GH_REPO: 'o/r' })
    assert.ok(create.args.includes(join(repo.dist, 'Mergelane-1.0.0-x64-setup.exe')))
    assert.ok(create.args.includes(join(repo.dist, 'Mergelane-1.0.0-arm64-setup.exe')))
    assert.match(printed.join('\n'), /created the DRAFT release v1\.0\.0 on o\/r/)
    // Without --upload and without skips, the same checks pass and it stops before gh.
    const again = fakeRepo()
    const out = []
    assert.equal(
      await release(optionsFor(again.root), { run: again.run, print: (line) => out.push(line) }),
      0
    )
    assert.match(out.join('\n'), /nothing was uploaded\. Run again with --upload/)
  })

  test('stops before building when a check fails', async () => {
    const repo = fakeRepo({
      answers: {
        'git symbolic-ref': 'topic\n',
        'git status': ' M CHANGELOG.md\n',
        'pgrep -f': '4242\n',
        'git ls-remote': 'abc\trefs/tags/v1.0.0\n',
        'gh api': 'v1.0.0\n',
        'git tag': 'abc\n'
      }
    })
    const printed = []
    assert.equal(
      await release(optionsFor(repo.root, { upload: true }), {
        run: repo.run,
        print: (line) => printed.push(line)
      }),
      1
    )
    const text = printed.join('\n')
    for (const message of [
      /HEAD is topic/,
      /uncommitted change/,
      /Mergelane is open: quit it/,
      /exists here/,
      /exists on origin/,
      /already has a release/
    ]) {
      assert.match(text, message)
    }
    assert.ok(!repo.calls.some(({ command }) => command === 'go'))
  })

  test("fails when the zip's app has another version", async () => {
    const repo = fakeRepo({ zipVersion: '0.9.9' })
    const printed = []
    assert.equal(
      await release(optionsFor(repo.root), { run: repo.run, print: (line) => printed.push(line) }),
      1
    )
    assert.match(printed.join('\n'), /the zip says version 0\.9\.9, expected 1\.0\.0/)
    assert.ok(!repo.calls.some(({ args }) => args[0] === 'scripts/media-tools/sources.mjs'))
  })
})

describe('makeRunner', () => {
  test('runs a command, prints or captures its output, and logs it', async () => {
    const logged = []
    const printed = []
    const run = makeRunner({
      log: { write: (chunk) => logged.push(String(chunk)) },
      print: (line) => printed.push(line),
      env: process.env
    })
    const shown = await run('bash', ['-c', 'echo out; echo err >&2'], { cwd: scratch })
    assert.equal(shown.stdout, 'out\n')
    assert.deepEqual(printed.sort(), ['err', 'out'])
    const captured = await run('bash', ['-c', 'echo "$X"'], {
      cwd: scratch,
      capture: true,
      extraEnv: { X: 'quiet' }
    })
    assert.equal(captured.stdout, 'quiet\n')
    assert.ok(!printed.includes('quiet'))
    assert.match(logged.join(''), /\$ \(cd .* && bash -c echo out; echo err >&2\)/)
    assert.equal((await run('bash', ['-c', 'exit 3'], { cwd: scratch, allowFail: true })).code, 3)
    await assert.rejects(run('bash', ['-c', 'exit 4'], { cwd: scratch }), /exited with 4/)
    await assert.rejects(run('/no/such/program', [], { cwd: scratch }), /ENOENT/)
  })
})

describe('main', () => {
  test('wrong usage exits 2 with the usage', async () => {
    const err = []
    assert.equal(
      await main(['--version', 'x'], { print: () => {}, error: (line) => err.push(line) }),
      2
    )
    assert.match(err.join('\n'), /usage: node scripts\/release\/local-release\.mjs/)
  })

  test('runs the release with a log file, and a failing step exits 1', async () => {
    const logs = fresh('logs')
    const ok = fakeRepo()
    const printed = []
    const code = await main(
      ['--version', '1.0.0', '--root', ok.root, '--logs', logs, '--skip-branch-checks'],
      {
        print: (line) => printed.push(line),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        makeRun: ({ env }) => {
          assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
          return ok.run
        }
      }
    )
    assert.equal(code, 0)
    const [log] = readdirSync(logs)
    assert.match(log, /^release-1\.0\.0-.*\.log$/)
    assert.match(readFileSync(join(logs, log), 'utf8'), /DRY RUN finished/)

    const broken = fakeRepo({ fail: 'npx electron-vite' })
    const out = []
    const failed = await main(
      ['--version', '1.0.0', '--root', broken.root, '--logs', logs, '--skip-branch-checks'],
      {
        print: (line) => out.push(line),
        makeRun: () => broken.run
      }
    )
    assert.equal(failed, 1)
    assert.match(out.join('\n'), /FAIL: npx electron-vite build exited with 1/)
  })

  test('as a program, it exits with its code', () => {
    const result = spawnSync(process.execPath, [join(HERE, 'local-release.mjs')], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--version is required/)
  })
})
