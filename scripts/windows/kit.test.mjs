// Tests for the Windows test kit's builder, with a stand-in for go, git and zip, plus static checks of the
// PowerShell script the kit carries (it can't run on the Mac). Run: node --test --experimental-test-coverage
// --test-coverage-include='scripts/windows/kit.mjs' scripts/windows/kit.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  APP_EXE,
  APP_FOLDERS,
  ARCHES,
  CMD_NAME,
  COVER_INCLUDE,
  GO_PACKAGES,
  KIT_VERSION,
  UsageError,
  addApp,
  ADMIN_CMD_NAME,
  HARDWARE_CMD_NAME,
  addHelper,
  addInstaller,
  adminCmdFile,
  hardwareCmdFile,
  installerName,
  assertAscii,
  buildKit,
  buildProgram,
  cmdFile,
  crlf,
  main,
  parseArgs,
  prepareOut,
  readme,
  run,
  sha256
} from './kit.mjs'
import { BEGIN, END } from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = readFileSync(join(HERE, 'test-kit.ps1'), 'utf8')
const ADMIN_SCRIPT = readFileSync(join(HERE, 'system-merge-test.ps1'), 'utf8')
const HARDWARE_SCRIPT = readFileSync(join(HERE, 'hardware-test.ps1'), 'utf8')

const scratch = mkdtempSync(join(tmpdir(), 'mergelane-kit-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
function freshDir(name = 'dir') {
  const dir = join(scratch, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A repository root holding the real test-kit.ps1 (or `script`) and system-merge-test.ps1, and a daemon folder
 * with each chip's built helper and wintun.dll (stand-ins). */
function fakeRoot(script = SCRIPT) {
  const root = freshDir('root')
  mkdirSync(join(root, 'scripts', 'windows'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'windows', 'test-kit.ps1'), script)
  writeFileSync(join(root, 'scripts', 'windows', 'system-merge-test.ps1'), ADMIN_SCRIPT)
  writeFileSync(join(root, 'scripts', 'windows', 'hardware-test.ps1'), HARDWARE_SCRIPT)
  for (const arch of Object.keys(ARCHES)) {
    mkdirSync(join(root, 'daemon', 'bin', `win-${arch}`), { recursive: true })
    writeFileSync(join(root, 'daemon', 'bin', `win-${arch}`, 'mergelane-daemon.exe'), `daemon ${arch}`)
    writeFileSync(join(root, 'daemon', 'bin', `win-${arch}`, 'wintun.dll'), `wintun ${arch}`)
  }
  return root
}

/**
 * Stands in for go, git and zip. `go test -c` writes a fake program for packages in `withTests`; `failGo` makes it
 * fail; `dirty` makes git report changes; `failZip` makes zip fail.
 */
function fakeRunner({
  withTests = new Set(GO_PACKAGES.map((p) => p.pkg)),
  failGo = false,
  dirty = false,
  failZip = false,
  gitFails = false
} = {}) {
  const calls = []
  const runner = async (file, args, options) => {
    calls.push({ file, args, options })
    if (file === 'go') {
      if (failGo) return { code: 1, stdout: '', stderr: 'build constraints exclude all Go files\n' }
      const out = args[args.indexOf('-o') + 1]
      const pkg = args.at(-1).slice(2)
      if (withTests.has(pkg)) writeFileSync(out, `program ${pkg} ${options.env.GOARCH}`)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (file === 'git') {
      if (gitFails) return { code: 128, stdout: '', stderr: 'not a git repository' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc1234\n', stderr: '' }
      return { code: 0, stdout: dirty ? ' M scripts/windows/kit.mjs\n' : '', stderr: '' }
    }
    if (file === 'zip') {
      if (failZip) return { code: 15, stdout: '', stderr: 'zip error: Nothing to do!' }
      writeFileSync(args[3], 'zip')
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command ${file}`)
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
  it('builds both chips into dist/windows-kit with a zip by default', () => {
    const options = parseArgs([])
    assert.deepEqual(options.arches, ['x64', 'arm64'])
    assert.equal(options.zip, true)
    assert.match(options.out, /dist[/\\]windows-kit$/)
  })

  it('takes --out, --arch (once each) and --no-zip', () => {
    const options = parseArgs(['--out', 'some/where', '--arch', 'arm64', '--arch', 'arm64', '--no-zip'])
    assert.deepEqual(options.arches, ['arm64'])
    assert.equal(options.zip, false)
    assert.match(options.out, /some[/\\]where$/)
  })

  it('refuses unknown chips, missing values and unknown arguments', () => {
    assert.throws(() => parseArgs(['--arch', 'x86']), UsageError)
    assert.throws(() => parseArgs(['--out']), /--out needs a value/)
    assert.throws(() => parseArgs(['--fast']), /unknown argument: --fast/)
  })
})

describe('helpers', () => {
  it('crlf turns every line ending into CRLF, once', () => {
    assert.equal(crlf('a\nb\r\nc\n'), 'a\r\nb\r\nc\r\n')
  })

  it('assertAscii names the first line that is not ASCII', () => {
    assert.doesNotThrow(() => assertAscii('x', 'plain\ntext'))
    assert.throws(() => assertAscii('x.ps1', 'one\ntwo — dash\n'), /x\.ps1 must be ASCII.*line 2/)
  })

  it('sha256 hashes a file', () => {
    const file = join(freshDir(), 'f')
    writeFileSync(file, 'abc')
    assert.equal(sha256(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('run resolves with the exit code and output, and never rejects', async () => {
    const ok = await run(process.execPath, ['-e', 'process.stdout.write("hi")'])
    assert.deepEqual(ok, { code: 0, stdout: 'hi', stderr: '' })
    const failed = await run(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])
    assert.equal(failed.code, 3)
    assert.equal(failed.stderr, 'bad')
    const missing = await run(join(scratch, 'no-such-program'), [])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /ENOENT/)
  })

  it('the cmd file starts Windows PowerShell on test-kit.ps1 for this run only, with CRLF endings', () => {
    const text = cmdFile()
    assert.match(text, /\r\n/)
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/)
    assert.match(
      text,
      /"%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-kit\.ps1"/
    )
    assert.match(text, /\r\npause\r\n$/)
    assertAscii(CMD_NAME, text)
  })

  it('the README names the commit and date, the steps, and no administrator rights', () => {
    const text = readme({ commit: 'abc1234', built: '2026-11-12T10:00:00.000Z' })
    assert.match(text, /Built from commit abc1234 on 2026-11-12\./)
    assert.match(text, /Double-click "Run test kit\.cmd" \(not "Run as administrator"\)/)
    assert.match(text, /needs no administrator rights and changes no settings/)
    assertAscii('README.txt', text)
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/)
  })
})

describe('prepareOut', () => {
  it('creates a missing folder and accepts an empty one', () => {
    const missing = join(freshDir(), 'kit')
    prepareOut(missing)
    assert.ok(existsSync(missing))
    prepareOut(missing)
    assert.ok(existsSync(missing))
  })

  it('replaces an earlier kit', () => {
    const out = freshDir('kit')
    writeFileSync(join(out, 'kit.json'), JSON.stringify({ kit: 1 }))
    writeFileSync(join(out, 'old.txt'), 'old')
    prepareOut(out)
    assert.ok(!existsSync(join(out, 'old.txt')))
  })

  it("never deletes a folder that isn't a kit", () => {
    const out = freshDir('notes')
    writeFileSync(join(out, 'notes.txt'), 'keep me')
    assert.throws(() => prepareOut(out), UsageError)
    assert.equal(readFileSync(join(out, 'notes.txt'), 'utf8'), 'keep me')

    writeFileSync(join(out, 'kit.json'), 'not json')
    assert.throws(() => prepareOut(out), /isn't a test kit/)
    writeFileSync(join(out, 'kit.json'), JSON.stringify({ name: 'something else' }))
    assert.throws(() => prepareOut(out), /isn't a test kit/)
    assert.ok(existsSync(join(out, 'notes.txt')))
  })
})

describe('buildProgram', () => {
  it("cross-compiles a package with go test -c for Windows, without cgo or this Mac's paths", async () => {
    const root = fakeRoot()
    const out = freshDir('kit')
    const { runner, calls } = fakeRunner()
    const path = await buildProgram({ root, out, pkg: 'internal/nmhost', arch: 'arm64', runner })
    assert.equal(path, 'go/arm64/internal/nmhost/nmhost.test.exe')
    assert.equal(readFileSync(join(out, path), 'utf8'), 'program internal/nmhost arm64')
    const [call] = calls
    assert.equal(call.file, 'go')
    assert.deepEqual(call.args, ['test', '-c', '-cover', '-trimpath', '-o', join(out, path), './internal/nmhost'])
    assert.equal(call.options.cwd, join(root, 'daemon'))
    assert.equal(call.options.env.GOOS, 'windows')
    assert.equal(call.options.env.GOARCH, 'arm64')
    assert.equal(call.options.env.CGO_ENABLED, '0')
  })

  it('maps x64 to amd64, and returns null when the package has no Windows tests', async () => {
    const { runner, calls } = fakeRunner({ withTests: new Set() })
    const path = await buildProgram({
      root: fakeRoot(),
      out: freshDir('kit'),
      pkg: 'internal/rib',
      arch: 'x64',
      runner
    })
    assert.equal(path, null)
    assert.equal(calls[0].options.env.GOARCH, ARCHES.x64)
  })

  it('throws with the compiler output when the build fails', async () => {
    const { runner } = fakeRunner({ failGo: true })
    await assert.rejects(
      buildProgram({ root: fakeRoot(), out: freshDir('kit'), pkg: 'internal/nics', arch: 'x64', runner }),
      /go test -c internal\/nics for x64 failed:\nbuild constraints exclude all Go files/
    )
  })
})

describe('buildKit', () => {
  it('builds every listed package for both chips and writes kit.json, the script, the cmd file, the README and a zip', async () => {
    const root = fakeRoot()
    const out = join(freshDir('dist'), 'windows-kit')
    const { runner, calls } = fakeRunner()
    const logged = []
    const { kit, noTests, zipFile } = await buildKit({
      root,
      out,
      runner,
      now: () => new Date('2026-11-12T10:00:00.000Z'),
      log: (line) => logged.push(line)
    })

    assert.deepEqual(noTests, [])
    assert.equal(kit.kit, KIT_VERSION)
    assert.equal(kit.commit, 'abc1234')
    assert.equal(kit.dirty, false)
    assert.equal(kit.built, '2026-11-12T10:00:00.000Z')
    assert.equal(kit.coverInclude, COVER_INCLUDE)
    assert.deepEqual(
      kit.programs.map((p) => p.id),
      ['x64', 'arm64'].flatMap((arch) => GO_PACKAGES.map(({ pkg }) => `${arch}/${pkg}`))
    )
    const until = new Map(GO_PACKAGES.map((p) => [p.pkg, p.until]))
    for (const program of kit.programs) {
      assert.equal(program.sha256, sha256(join(out, program.path)))
      assert.equal(program.until, until.get(program.package))
      assert.equal(program.path, `go/${program.arch}/${program.package}/${program.package.split('/').at(-1)}.test.exe`)
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'kit.json'), 'utf8')), kit)
    assert.equal(readFileSync(join(out, 'test-kit.ps1'), 'utf8'), crlf(SCRIPT))
    assert.equal(readFileSync(join(out, CMD_NAME), 'utf8'), cmdFile())
    assert.match(readFileSync(join(out, 'README.txt'), 'utf8'), /commit abc1234 on 2026-11-12/)
    assert.equal(logged.length, kit.programs.length)

    assert.equal(zipFile, join(dirname(out), 'mergelane-windows-kit.zip'))
    const zip = calls.find((c) => c.file === 'zip')
    assert.deepEqual(zip.args, ['-r', '-X', '-q', zipFile, 'windows-kit'])
    assert.equal(zip.options.cwd, dirname(out))
  })

  it('leaves out packages without Windows tests, keeps "until" only where given, and notes a dirty checkout', async () => {
    const { runner } = fakeRunner({ withTests: new Set(['internal/a']), dirty: true })
    const { kit, noTests, zipFile } = await buildKit({
      root: fakeRoot(),
      out: freshDir('kit'),
      arches: ['x64'],
      zip: false,
      packages: [{ pkg: 'internal/a' }, { pkg: 'internal/b', until: 'W1' }],
      runner
    })
    assert.deepEqual(noTests, ['x64/internal/b'])
    assert.equal(kit.programs.length, 1)
    assert.equal('until' in kit.programs[0], false)
    assert.equal(kit.dirty, true)
    assert.equal(zipFile, null)
  })

  it('says "unknown" and dirty when git has no answer', async () => {
    const { runner } = fakeRunner({ gitFails: true })
    const { kit } = await buildKit({ root: fakeRoot(), out: freshDir('kit'), zip: false, runner })
    assert.equal(kit.commit, 'unknown')
    assert.equal(kit.dirty, true)
  })

  it('refuses a script that is not ASCII before touching the output folder', async () => {
    const out = freshDir('notes')
    writeFileSync(join(out, 'keep.txt'), 'keep')
    await assert.rejects(
      buildKit({ root: fakeRoot('Write-Host "café"\n'), out, runner: fakeRunner().runner }),
      /test-kit\.ps1 must be ASCII/
    )
    assert.ok(existsSync(join(out, 'keep.txt')))
  })

  it('fails when zip fails', async () => {
    const { runner } = fakeRunner({ failZip: true })
    await assert.rejects(buildKit({ root: fakeRoot(), out: freshDir('kit'), runner }), /zip failed:\nzip error/)
  })
})

describe('main', () => {
  it('prints the programs, the kit folder and the zip, and exits 0', async () => {
    const out = join(freshDir('dist'), 'windows-kit')
    const stdout = capture()
    const root = fakeRoot()
    fakeApps(root, ['x64'])
    const code = await main(['--out', out, '--arch', 'x64', '--unpacked'], {
      stdout: stdout.stream,
      root,
      runner: fakeRunner({ dirty: true }).runner
    })
    assert.equal(code, 0)
    assert.match(stdout.text(), /building x64 cmd\/mergelane-nmhost/)
    assert.match(stdout.text(), /  go\/x64\/internal\/nmhost\/nmhost\.test\.exe\n/)
    assert.match(stdout.text(), /  app\/x64\/Mergelane\.exe\n/)
    assert.match(stdout.text(), /uncommitted changes/)
    assert.match(stdout.text(), new RegExp(`Kit: ${out}\\n`))
    assert.match(stdout.text(), /Zip: .*mergelane-windows-kit\.zip\n/)
  })

  it('names packages with no Windows tests', async () => {
    const stdout = capture()
    const code = await main(['--out', freshDir('kit'), '--arch', 'arm64', '--no-zip', '--no-app'], {
      stdout: stdout.stream,
      root: fakeRoot(),
      runner: fakeRunner({ withTests: new Set(['internal/nmhost']) }).runner
    })
    assert.equal(code, 0)
    assert.match(stdout.text(), /arm64\/cmd\/mergelane-nmhost: no Windows tests, nothing to run/)
    assert.doesNotMatch(stdout.text(), /Zip:/)
  })

  it('exits 2 on wrong usage or a folder that is not a kit, and 1 when a build fails', async () => {
    const stderr = capture()
    assert.equal(await main(['--arch', 'mips'], { stderr: stderr.stream }), 2)
    assert.match(stderr.text(), /unknown --arch mips[\s\S]*usage:/)

    const notes = freshDir('notes')
    writeFileSync(join(notes, 'notes.txt'), 'keep')
    const stderr2 = capture()
    assert.equal(
      await main(['--out', notes], { stderr: stderr2.stream, root: fakeRoot(), runner: fakeRunner().runner }),
      2
    )
    assert.match(stderr2.text(), /isn't a test kit/)

    const stderr3 = capture()
    assert.equal(
      await main(['--out', freshDir('kit')], {
        stdout: capture().stream,
        stderr: stderr3.stream,
        root: fakeRoot(),
        runner: fakeRunner({ failGo: true }).runner
      }),
      1
    )
    assert.match(stderr3.text(), /kit: go test -c/)
  })
})

describe('test-kit.ps1 (static checks; it runs only on Windows)', () => {
  it('is ASCII, so Windows PowerShell 5.1 reads it as written', () => {
    assert.doesNotThrow(() => assertAscii('test-kit.ps1', SCRIPT))
  })

  it('uses the same report markers as report.mjs', () => {
    assert.ok(SCRIPT.includes(`$ReportBegin = '${BEGIN}'`))
    assert.ok(SCRIPT.includes(`$ReportEnd = '${END}'`))
  })

  it("needs Windows PowerShell 5.1, stops with administrator rights, and checks each program's SHA-256", () => {
    assert.match(SCRIPT, /^#Requires -Version 5\.1$/m)
    assert.match(SCRIPT, /if \(Test-Elevated\) \{[\s\S]*?exit 2/)
    assert.match(SCRIPT, /Get-FileHash -LiteralPath \$exe -Algorithm SHA256/)
    assert.match(SCRIPT, /\(Get-Value \$Kit 'kit'\) -ne 1/)
  })

  it('reads the kit.json fields kit.mjs writes', () => {
    for (const field of ['programs', 'coverInclude', 'commit', 'dirty', 'built']) {
      assert.match(SCRIPT, new RegExp(`\\$Kit[.']\\s*${field}|Get-Value \\$Kit '${field}'`), field)
    }
    for (const field of ['id', 'arch', 'package', 'path', 'sha256']) {
      assert.match(SCRIPT, new RegExp(`\\$Program\\.${field}\\b`), field)
    }
    assert.match(SCRIPT, /Get-Value \$Program 'until'/)
  })

  it('contains no command that changes the system (CLAUDE.md, laptop safety)', () => {
    const forbidden = [
      /Set-ItemProperty/i,
      /New-ItemProperty/i,
      /Remove-ItemProperty/i,
      /Set-ExecutionPolicy/i,
      /Unblock-File/i,
      /-Verb\s+RunAs/i,
      /\bnetsh\b/i,
      /\broute(\.exe)?\s+(add|delete|change)/i,
      /New-NetRoute|Remove-NetRoute|Set-NetIPInterface|Set-DnsClient/i,
      /New-NetFirewallRule|Set-NetFirewall/i,
      /Set-MpPreference|Add-MpPreference/i,
      /\breg(\.exe)?\s+(add|delete|import|load)/i,
      /New-Service|Set-Service|sc\.exe/i,
      /Install-Module|Install-Package/i,
      /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/i,
      /HKLM:[^']*'\s*-Name/i
    ]
    for (const pattern of forbidden) assert.doesNotMatch(SCRIPT, pattern, String(pattern))
    // Registry access is read-only: Get-ItemProperty and Test-Path only.
    const registryLines = SCRIPT.split('\n').filter((line) => /HK(LM|CU):/.test(line))
    assert.ok(registryLines.length >= 2)
    for (const line of SCRIPT.split('\n').filter((l) => /\$key\b/.test(l) && !/^\s*\$key =/.test(l))) {
      assert.match(line, /Test-Path -LiteralPath \$key|Get-ItemProperty -LiteralPath \$key|Get-ChildItem -LiteralPath \$key/, line)
    }
  })

  it('writes only inside the kit folder', () => {
    const writes = SCRIPT.split('\n').filter((line) =>
      /WriteAllText|New-Item|Move-Item|Remove-Item|Out-File|Set-Content|Add-Content|RedirectStandard/.test(line)
    )
    assert.ok(writes.length > 0)
    for (const line of writes) {
      assert.match(line, /\$ReportFile|\$ResultsDir|\$coverFile|\$outFile|\$errFile/, line)
    }
    assert.match(SCRIPT, /\$ResultsDir = Join-Path \$KitDir 'results'/)
    assert.match(SCRIPT, /\$ReportFile = Join-Path \$KitDir 'report\.txt'/)
  })
})

/** Puts a stand-in unpacked app for each chip where `npm run build:win:dir` writes it. */
function fakeApps(root, arches = Object.keys(ARCHES)) {
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(join(root, 'app', 'package.json'), JSON.stringify({ version: '0.4.0' }))
  for (const arch of arches) {
    const folder = join(root, 'app', 'dist', APP_FOLDERS[arch])
    mkdirSync(join(folder, 'resources'), { recursive: true })
    writeFileSync(join(folder, APP_EXE), `exe ${arch}`)
    writeFileSync(join(folder, 'resources', 'app.asar'), 'asar')
  }
}

describe('the app in the kit', () => {
  it('copies each chip\'s unpacked app and lists it in kit.json with the exe\'s SHA-256', async () => {
    const root = fakeRoot()
    fakeApps(root)
    const out = freshDir('kit')
    const { runner } = fakeRunner()
    const { kit } = await buildKit({ root, out, zip: false, apps: 'folder', runner })
    assert.deepEqual(
      kit.apps.map((a) => a.path),
      ['app/x64/Mergelane.exe', 'app/arm64/Mergelane.exe']
    )
    for (const app of kit.apps) {
      assert.equal(app.kind, 'folder')
      assert.equal(app.version, '0.4.0')
      assert.equal(app.sha256, sha256(join(out, app.path)))
      assert.equal(readFileSync(join(out, 'app', app.arch, 'resources', 'app.asar'), 'utf8'), 'asar')
    }
  })

  it('refuses when an app is missing, and says how to build it', () => {
    const root = fakeRoot()
    fakeApps(root, ['x64'])
    assert.throws(
      () => addApp({ root, out: freshDir('kit'), arch: 'arm64' }),
      (error) => error instanceof UsageError && /npm run build:win:dir/.test(error.message)
    )
  })

  it('leaves the app out with --no-app, and by default when called as a function', async () => {
    assert.equal(parseArgs(['--no-app']).apps, false)
    const { runner } = fakeRunner()
    const { kit } = await buildKit({ root: fakeRoot(), out: freshDir('kit'), zip: false, runner })
    assert.deepEqual(kit.apps, [])
  })

  it('the script opens the app with its own profile, waits for its window, and closes it', () => {
    assert.match(SCRIPT, /--user-data-dir=`"\$ProfileDir`"/)
    assert.match(SCRIPT, /\$profileDir = Join-Path \$ResultsDir /)
    assert.match(SCRIPT, /MainWindowTitle -like 'Mergelane\*'/)
    assert.match(SCRIPT, /CloseMainWindow\(\)/)
    assert.match(SCRIPT, /Get-Value \$Kit 'apps'/)
    // Only processes started from the kit's own app folder are ever stopped.
    for (const line of SCRIPT.split('\n').filter((l) => /Stop-Process/.test(l))) {
      assert.match(line, /\$process\.Id|\$leftover\.Id/, line)
    }
    assert.match(SCRIPT, /\$_\.Path\.StartsWith\(\$appDir/)
  })

  it('the script asks the browser bridge on the pipe the app names (shared/fixtures/browser-pipe.json)', () => {
    // The same recipe as app/src/shared/browserPipe.ts: A-Z lowercased, SHA-256, the first 16 hex digits.
    assert.match(SCRIPT, /\[regex\]::Replace\(\$Folder, '\[A-Z\]'/)
    assert.match(SCRIPT, /SHA256\]::Create\(\)/)
    assert.match(SCRIPT, /'mergelane-browser-' \+ \$hex\.Substring\(0, 16\)/)
    assert.match(SCRIPT, /Get-BridgePipeName \$ProfileDir/)
    assert.match(SCRIPT, /'\{"v":3,"origin":"","message":\{"type":"health"\}\}'/)
    assert.match(SCRIPT, /'"ready":true'/)
  })
})

describe('the installer in the kit (W4)', () => {
  function fakeInstallers(root, version = '0.4.0', arches = Object.keys(ARCHES)) {
    mkdirSync(join(root, 'app', 'dist'), { recursive: true })
    writeFileSync(join(root, 'app', 'package.json'), JSON.stringify({ version }))
    for (const arch of arches) writeFileSync(join(root, 'app', 'dist', installerName(version, arch)), `setup ${arch}`)
  }

  it('is the default: each chip\'s installer, with its SHA-256', async () => {
    assert.equal(parseArgs([]).apps, 'installer')
    assert.equal(parseArgs(['--unpacked']).apps, 'folder')
    const root = fakeRoot()
    fakeInstallers(root)
    const out = freshDir('kit')
    const { runner } = fakeRunner()
    const { kit } = await buildKit({ root, out, zip: false, apps: 'installer', runner })
    assert.deepEqual(
      kit.apps.map((a) => [a.kind, a.path]),
      [
        ['installer', 'app/x64/Mergelane-0.4.0-x64-setup.exe'],
        ['installer', 'app/arm64/Mergelane-0.4.0-arm64-setup.exe']
      ]
    )
    for (const app of kit.apps) {
      assert.equal(app.sha256, sha256(join(out, app.path)))
      assert.equal(app.version, '0.4.0')
    }
  })

  it('the script checks that both helpers inside the app say its version, as package-test.sh does', () => {
    assert.match(SCRIPT, /@\('mergelane-daemon', 'version'\), @\('mergelane-nmhost', '--version'\)/)
    assert.match(SCRIPT, /\$expected = "\$\(\$helper\[0\]\) \$Version"/)
    // Both the unpacked app and the installed one, before the uninstaller runs.
    assert.match(SCRIPT, /Test-HelperVersions \$result \(Split-Path -Parent \$file\) \(Get-Value \$App 'version'\)/)
    const installed = SCRIPT.indexOf("Test-HelperVersions $result $installDir (Get-Value $App 'version')")
    assert.ok(installed > 0 && installed < SCRIPT.indexOf("'Uninstall Mergelane.exe'"))
  })

  it('the script checks the installer\'s Open with entries for .torrent and .nzb, and that the uninstall removes them', () => {
    assert.ok(SCRIPT.includes('"HKCU:\\Software\\Classes\\$progId\\shell\\open\\command"'))
    assert.ok(SCRIPT.includes('"HKCU:\\Software\\Classes\\.$Ext\\OpenWithProgids" -Name $progId'))
    assert.ok(SCRIPT.includes('the installer did not add Mergelane to Open with for'))
    assert.ok(SCRIPT.includes('Open with still lists Mergelane for .$ext'))
    // The same names as build/installer.nsh writes and removes.
    const nsh = readFileSync(join(HERE, '..', '..', 'app', 'build', 'installer.nsh'), 'utf8')
    assert.ok(nsh.includes('"Software\\Classes\\Mergelane.${EXT}\\shell\\open\\command" "" \'"$appExe" "%1"\''))
    assert.ok(nsh.includes('"Software\\Classes\\.${EXT}\\OpenWithProgids" "Mergelane.${EXT}" ""'))
    for (const ext of ['torrent', 'nzb']) {
      assert.ok(nsh.includes(`DeleteRegValue HKCU "Software\\Classes\\.${ext}\\OpenWithProgids" "Mergelane.${ext}"`), ext)
      assert.ok(nsh.includes(`DeleteRegKey HKCU "Software\\Classes\\Mergelane.${ext}"`), ext)
    }
  })

  it('refuses when an installer is missing, and says how to build one', () => {
    const root = fakeRoot()
    fakeInstallers(root, '0.4.0', ['x64'])
    assert.throws(
      () => addInstaller({ root, out: freshDir('kit'), arch: 'arm64' }),
      (error) => error instanceof UsageError && /npm run build:win/.test(error.message)
    )
  })

  it('the script installs into the results folder, never over an installed Mergelane, and checks the uninstall', () => {
    assert.match(SCRIPT, /\$installDir = Join-Path \$ResultsDir "install-/)
    assert.match(SCRIPT, /-ArgumentList '\/S', "\/D=\$installDir"/)
    assert.match(SCRIPT, /if \(Get-InstalledMergelane\) \{\s+\$result\.status = 'skipped'/)
    assert.match(SCRIPT, /'Uninstall Mergelane\.exe'/)
    assert.match(SCRIPT, /\$uninstaller -ArgumentList '\/S'/)
    for (const leftover of ['still in its folder', 'Settings > Apps', 'a shortcut is left in']) {
      assert.ok(SCRIPT.includes(leftover), leftover)
    }
  })
})

describe('the System merge test (W5)', () => {
  it('carries each chip\'s helper and wintun.dll with their SHA-256s, the script and its starter', async () => {
    const root = fakeRoot()
    const out = freshDir('kit')
    const { runner } = fakeRunner()
    const { kit } = await buildKit({ root, out, zip: false, helper: true, runner })
    assert.deepEqual(
      kit.helpers.map((h) => h.path),
      ['helper/x64/mergelane-daemon.exe', 'helper/arm64/mergelane-daemon.exe']
    )
    for (const h of kit.helpers) {
      assert.equal(h.sha256, sha256(join(out, h.path)))
      assert.equal(h.wintunSha256, sha256(join(out, 'helper', h.arch, 'wintun.dll')))
    }
    assert.equal(readFileSync(join(out, 'system-merge-test.ps1'), 'utf8'), crlf(ADMIN_SCRIPT))
    assert.equal(readFileSync(join(out, ADMIN_CMD_NAME), 'utf8'), adminCmdFile())
    assert.match(readFileSync(join(out, 'README.txt'), 'utf8'), /Run as administrator/)
  })

  it('is left out with --no-helper, and asks for the helpers when they aren\'t built', async () => {
    assert.equal(parseArgs(['--no-helper']).helper, false)
    assert.equal(parseArgs([]).helper, true)
    const out = freshDir('kit')
    const { runner } = fakeRunner()
    const { kit } = await buildKit({ root: fakeRoot(), out, zip: false, runner })
    assert.deepEqual(kit.helpers, [])
    assert.equal(existsSync(join(out, ADMIN_CMD_NAME)), false)
    assert.doesNotMatch(readFileSync(join(out, 'README.txt'), 'utf8'), /Only if you want to test System merge/)
    const bare = fakeRoot()
    rmSync(join(bare, 'daemon', 'bin', 'win-arm64', 'wintun.dll'))
    assert.throws(
      () => addHelper({ root: bare, out: freshDir('kit'), arch: 'arm64' }),
      (error) => error instanceof UsageError && /build-helpers\.mjs/.test(error.message)
    )
  })

  it('the starter runs the script as it is meant to: as administrator, for this run only', () => {
    const cmd = adminCmdFile()
    assert.match(cmd, /-ExecutionPolicy Bypass -File "%~dp0system-merge-test\.ps1"/)
    assert.match(cmd, /Run as administrator/)
    assert.match(cmd, /\r\n/)
  })

  it('the script changes nothing before YES, refuses next to an installed helper, and always removes it again', () => {
    const at = (text) => {
      const i = ADMIN_SCRIPT.indexOf(text)
      assert.ok(i >= 0, text)
      return i
    }
    const yes = at("if ($answer -cne 'YES') {")
    const install = at("@('install', '--user-sid', $sid, '--source', $helper)")
    assert.ok(at('if (-not (Test-Elevated)) {') < yes)
    assert.ok(at('if (Get-HelperService) {') < yes)
    assert.ok(at('if (-not (Test-Internet)) {') < install)
    assert.ok(yes < install)
    // The removal is in the last finally block, after the install, and checks what must be gone.
    const final = ADMIN_SCRIPT.lastIndexOf('} finally {')
    assert.ok(install < final)
    assert.ok(final < at("Invoke-Helper $helper @('uninstall')"))
    for (const check of ['no service left', 'no program left in Program Files', 'no capture routes left',
      'no mergelane adapter left', "every adapter''s settings as before", 'internet after the test']) {
      assert.ok(at(`Step '${check}'`) > final, check)
    }
    // Each file is checked against the kit before it runs.
    assert.match(ADMIN_SCRIPT, /Get-FileHash -LiteralPath \$file\.path -Algorithm SHA256/)
  })

  it('the script changes only what the test is about: the helper\'s service, its routes and the process it kills', () => {
    for (const pattern of [
      /Set-ItemProperty|New-ItemProperty|Remove-ItemProperty/i,
      /Set-ExecutionPolicy|Unblock-File/i,
      /\bnetsh\b|\broute(\.exe)?\s+(add|delete|change)/i,
      /New-NetRoute|Remove-NetRoute|Set-NetIPInterface|Set-DnsClient/i,
      /New-NetFirewallRule|Set-NetFirewall|Set-MpPreference|Add-MpPreference/i,
      /\breg(\.exe)?\s+(add|delete|import|load)/i,
      /New-Service|Set-Service|sc\.exe|Remove-Service/i,
      /Install-Module|Install-Package|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/i,
      /-Verb\s+RunAs/i
    ]) {
      assert.doesNotMatch(ADMIN_SCRIPT, pattern, String(pattern))
    }
    // The only process it stops is the helper's own, by the id the service reports.
    const stops = ADMIN_SCRIPT.split('\n').filter((line) => /Stop-Process/.test(line))
    assert.deepEqual(stops.map((line) => line.trim()), ['Stop-Process -Id $firstPid -Force'])
    assertAscii('system-merge-test.ps1', ADMIN_SCRIPT)
  })
})

describe('the hardware run (W6)', () => {
  it('ships with its starter whenever the helper does', async () => {
    const out = freshDir('kit')
    const { runner } = fakeRunner()
    await buildKit({ root: fakeRoot(), out, zip: false, helper: true, runner })
    assert.equal(readFileSync(join(out, 'hardware-test.ps1'), 'utf8'), crlf(HARDWARE_SCRIPT))
    assert.equal(readFileSync(join(out, HARDWARE_CMD_NAME), 'utf8'), hardwareCmdFile())
    assert.match(readFileSync(join(out, 'README.txt'), 'utf8'), /Run hardware test\.cmd/)
    assert.match(hardwareCmdFile(), /-ExecutionPolicy Bypass -File "%~dp0hardware-test\.ps1"/)
  })

  it('needs no administrator rights and changes nothing outside the helper\'s own settings, which it puts back', () => {
    for (const pattern of [
      /Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-ExecutionPolicy|Unblock-File/i,
      /\bnetsh\b|\broute(\.exe)?\s+(add|delete|change)/i,
      /New-NetRoute|Remove-NetRoute|Set-NetIPInterface|Set-DnsClient|New-NetFirewallRule|Set-NetFirewall/i,
      /\breg(\.exe)?\s+(add|delete|import|load)/i,
      /New-Service|Set-Service|Remove-Service|sc\.exe|-Verb\s+RunAs/i,
      /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Out-File|WriteAllBytes/i,
      /Stop-Process(?! -Id \$\(\$before\.ProcessId\) -Force" -ForegroundColor Cyan)/
    ]) {
      assert.doesNotMatch(HARDWARE_SCRIPT, pattern, String(pattern))
    }
    // Downloads stay in memory; the one file it writes is its report, in the kit folder.
    const writes = HARDWARE_SCRIPT.split('\n').filter((l) => /Set-Content|Add-Content|New-Item/.test(l))
    assert.deepEqual(writes.map((l) => l.trim()), ['Set-Content -LiteralPath $ReportFile -Value $report -Encoding ASCII'])
    // Everything it changes through the helper is put back in the finally block.
    const final = HARDWARE_SCRIPT.lastIndexOf('} finally {')
    for (const restore of ["Invoke-Helper 'disable'", "Invoke-Helper 'setStickySites' @{ enabled = $stickyBefore }",
      "Invoke-Helper 'setLimit' @{ link = $name; mbps = $limitsBefore[$name] }"]) {
      assert.ok(HARDWARE_SCRIPT.indexOf(restore, final) > final, restore)
    }
    // Every optional step asks first.
    for (const ask of ["Ask \"Test unplugging", "Ask 'Test sleep and wake?", "Ask 'Test a VPN?", "Ask 'Test a helper crash?"]) {
      assert.ok(HARDWARE_SCRIPT.includes(ask), ask)
    }
    assertAscii('hardware-test.ps1', HARDWARE_SCRIPT)
  })
})
