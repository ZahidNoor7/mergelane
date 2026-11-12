// Tests for check-build.mjs: node --test scripts/windows/check-build.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HELPERS,
  INSTALLER_MACHINE,
  checkWindowsBuild,
  defaultReaders,
  fuseProblems,
  main,
  parseArgs,
  programsOf,
  isIco,
  TRAY_ICON
} from './check-build.mjs'
import { APP_EXE, APP_FOLDERS, UsageError, installerName } from './kit.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const appRequire = createRequire(join(ROOT, 'app', 'package.json'))
const { FuseV1Options } = appRequire('@electron/fuses')
const { SENTINEL } = appRequire('@electron/fuses/dist/constants')
const MANIFEST = {
  x64: appRequire(join(ROOT, 'scripts', 'media-tools', 'tools-windows-x64.json')),
  arm64: appRequire(join(ROOT, 'scripts', 'media-tools', 'tools-windows-arm64.json'))
}

const TEMP = mkdtempSync(join(tmpdir(), 'mergelane-check-build-test-'))
after(() => rmSync(TEMP, { recursive: true, force: true }))
let fresh = 0
const freshDir = (name) => {
  const dir = join(TEMP, `${name}-${fresh++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const MACHINES = { x64: 0x8664, arm64: 0xaa64, x86: 0x14c }

/** A stand-in Windows program: an MZ header pointing at a PE header with the chip's machine type. */
function fakePe(file, chip) {
  mkdirSync(dirname(file), { recursive: true })
  const bytes = Buffer.alloc(96)
  bytes.write('MZ', 0, 'latin1')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64, 'latin1')
  bytes.writeUInt16LE(MACHINES[chip], 68)
  writeFileSync(file, bytes)
}

/** What electron-builder.yml's electronFuses sets, as a wire @electron/fuses reads (48 off, 49 on). */
const GOOD_WIRE = { version: '1', 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 49, 8: 49 }

/** A build of every chip as electron-builder writes it, with each program built for `chips[arch]`. */
function fakeDist({ version = '0.4.0', chips = { x64: 'x64', arm64: 'arm64' } } = {}) {
  const dist = freshDir('dist')
  for (const arch of Object.keys(chips)) {
    fakePe(join(dist, installerName(version, arch)), INSTALLER_MACHINE)
    for (const program of programsOf(MANIFEST[arch])) fakePe(join(dist, APP_FOLDERS[arch], program), chips[arch])
    const icon = join(dist, APP_FOLDERS[arch], TRAY_ICON)
    mkdirSync(dirname(icon), { recursive: true })
    writeFileSync(icon, readFileSync(join(ROOT, 'app', 'resources', 'tray.ico')))
  }
  return dist
}

function fakeReaders({ version = '0.4.0', wire = GOOD_WIRE } = {}) {
  return { fuses: async () => wire, asarVersion: () => version }
}

describe('parseArgs', () => {
  it('needs the version, and checks both chips unless told which', () => {
    assert.deepEqual(parseArgs(['--version', '0.4.0']), { version: '0.4.0', dist: null, arches: ['x64', 'arm64'] })
    assert.deepEqual(parseArgs(['--version', '0.4.0', '--arch', 'arm64', '--arch', 'arm64', '--dist', 'out']), {
      version: '0.4.0',
      dist: resolve('out'),
      arches: ['arm64']
    })
  })

  it('refuses what it does not know', () => {
    for (const argv of [[], ['--version'], ['--version', '1.0.0', '--arch', 'x86'], ['--version', '1.0.0', '--fast']]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(' '))
    }
  })
})

describe('programsOf', () => {
  it('lists Mergelane.exe, both helpers and each media tool, by the name the manifest installs', () => {
    assert.deepEqual(programsOf(MANIFEST.x64), [
      APP_EXE,
      ...HELPERS.map((helper) => `resources/${helper}`),
      'resources/wintun.dll',
      'resources/yt-dlp/yt-dlp.exe',
      'resources/ffmpeg.exe',
      'resources/deno.exe'
    ])
    assert.ok(programsOf(MANIFEST.arm64).includes('resources/yt-dlp/yt-dlp_arm64.exe'))
  })
})

describe('fuseProblems', () => {
  it('passes the fuses electron-builder.yml sets, and names any that differ', () => {
    assert.deepEqual(fuseProblems(GOOD_WIRE, FuseV1Options), [])
    assert.deepEqual(fuseProblems({ ...GOOD_WIRE, 0: 49 }, FuseV1Options), ['fuse RunAsNode is enabled, expected disabled'])
    assert.deepEqual(fuseProblems({ ...GOOD_WIRE, 5: 144 }, FuseV1Options), [
      'fuse OnlyLoadAppFromAsar is inherit, expected enabled'
    ])
    const short = { version: '1', 0: 48, 1: 49, 2: 48, 3: 48 }
    assert.deepEqual(fuseProblems(short, FuseV1Options), [
      'fuse EnableEmbeddedAsarIntegrityValidation is missing, expected enabled',
      'fuse OnlyLoadAppFromAsar is missing, expected enabled'
    ])
  })
})

describe('checkWindowsBuild', () => {
  it('passes a build where every program is built for its chip, with the version and the fuses', async () => {
    assert.deepEqual(
      await checkWindowsBuild({ root: ROOT, dist: fakeDist(), version: '0.4.0', readers: fakeReaders() }),
      []
    )
  })

  it('finds a program built for the other chip, and a missing installer', async () => {
    const dist = fakeDist({ chips: { x64: 'x64', arm64: 'x64' } })
    rmSync(join(dist, installerName('0.4.0', 'x64')))
    const problems = await checkWindowsBuild({ root: ROOT, dist, version: '0.4.0', readers: fakeReaders() })
    assert.equal(problems[0], `${join(dist, installerName('0.4.0', 'x64'))} is missing`)
    assert.ok(problems.includes(`${join(dist, APP_FOLDERS.arm64, APP_EXE)} is built for x64, expected arm64`))
    assert.ok(
      problems.includes(`${join(dist, APP_FOLDERS.arm64, 'resources/yt-dlp/yt-dlp_arm64.exe')} is built for x64, expected arm64`)
    )
    assert.equal(problems.length, 1 + programsOf(MANIFEST.arm64).length)
  })

  it('finds a notification-area icon that is missing or is not an ICO', async () => {
    const dist = fakeDist({ chips: { x64: 'x64', arm64: 'arm64' } })
    const x64 = join(dist, APP_FOLDERS.x64, TRAY_ICON)
    const arm64 = join(dist, APP_FOLDERS.arm64, TRAY_ICON)
    rmSync(x64)
    writeFileSync(arm64, Buffer.from('\x89PNG\r\n', 'latin1'))
    const problems = await checkWindowsBuild({ root: ROOT, dist, version: '0.4.0', readers: fakeReaders() })
    assert.deepEqual(problems, [`${x64} is missing`, `${arm64} is not an icon (no ICO header)`])
  })

  it('reads an ICO header', () => {
    assert.equal(isIco(readFileSync(join(ROOT, 'app', 'resources', 'tray.ico'))), true)
    assert.equal(isIco(Buffer.from([0, 0, 1, 0, 0, 0])), false, 'no images')
    assert.equal(isIco(Buffer.from([0, 0, 2, 0, 1, 0])), false, 'a cursor')
    assert.equal(isIco(Buffer.from([0, 0])), false, 'too short')
  })

  it('finds an installer that is not a Windows program', async () => {
    const dist = fakeDist({ chips: { x64: 'x64' } })
    writeFileSync(join(dist, installerName('0.4.0', 'x64')), 'not a program')
    const problems = await checkWindowsBuild({ root: ROOT, dist, version: '0.4.0', arches: ['x64'], readers: fakeReaders() })
    assert.deepEqual(problems, [`${join(dist, installerName('0.4.0', 'x64'))} is not a Windows program (no MZ header)`])
  })

  it('finds an app of another version, and fuses that differ', async () => {
    const dist = fakeDist({ chips: { x64: 'x64' } })
    const app = join(dist, APP_FOLDERS.x64)
    const problems = await checkWindowsBuild({
      root: ROOT,
      dist,
      version: '0.4.0',
      arches: ['x64'],
      readers: fakeReaders({ version: '0.3.5', wire: { ...GOOD_WIRE, 0: 49 } })
    })
    assert.deepEqual(problems, [
      `${join(app, 'resources', 'app.asar')} says version 0.3.5, expected 0.4.0`,
      `${join(app, APP_EXE)}: fuse RunAsNode is enabled, expected disabled`
    ])
  })

  it('says when the version or the fuses cannot be read', async () => {
    const dist = fakeDist({ chips: { x64: 'x64' } })
    const app = join(dist, APP_FOLDERS.x64)
    const readers = {
      fuses: async () => {
        throw new Error('no sentinel')
      },
      asarVersion: () => {
        throw new Error('no package.json')
      }
    }
    const problems = await checkWindowsBuild({ root: ROOT, dist, version: '0.4.0', arches: ['x64'], readers })
    assert.deepEqual(problems, [
      `${join(app, 'resources', 'app.asar')}: cannot read its package.json: no package.json`,
      `${join(app, APP_EXE)}: cannot read its fuses: no sentinel`
    ])
  })

  it('skips the fuses of a missing Mergelane.exe, which is already reported', async () => {
    const dist = fakeDist({ chips: { x64: 'x64' } })
    rmSync(join(dist, APP_FOLDERS.x64, APP_EXE))
    const problems = await checkWindowsBuild({ root: ROOT, dist, version: '0.4.0', arches: ['x64'], readers: fakeReaders() })
    assert.deepEqual(problems, [`${join(dist, APP_FOLDERS.x64, APP_EXE)} is missing`])
  })
})

describe('defaultReaders', () => {
  const readers = defaultReaders(ROOT)

  it('reads the fuse wire after the sentinel, as electron-builder wrote it', async () => {
    const exe = join(freshDir('fuses'), 'Mergelane.exe')
    const wire = [1, 9, 48, 49, 48, 48, 49, 49, 48, 49, 49]
    writeFileSync(exe, Buffer.concat([Buffer.alloc(32), Buffer.from(SENTINEL, 'latin1'), Buffer.from(wire)]))
    assert.deepEqual(fuseProblems(await readers.fuses(exe), FuseV1Options), [])
  })

  it('reads the version from app.asar\'s package.json', async () => {
    const source = freshDir('asar-source')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'mergelane', version: '0.4.0' }))
    const asar = join(freshDir('asar'), 'app.asar')
    await appRequire('@electron/asar').createPackage(source, asar)
    assert.equal(readers.asarVersion(asar), '0.4.0')
  })
})

describe('main', () => {
  function output() {
    const text = { out: '', err: '' }
    return {
      text,
      stdout: { write: (chunk) => (text.out += chunk) },
      stderr: { write: (chunk) => (text.err += chunk) }
    }
  }

  it('exits 2 with the usage on a wrong command line', async () => {
    const { text, ...io } = output()
    assert.equal(await main(['--arch', 'x64'], io), 2)
    assert.match(text.err, /--version is required\nusage: node scripts\/windows\/check-build\.mjs/)
  })

  it('exits 0 and says what it checked', async () => {
    const { text, ...io } = output()
    const dist = fakeDist()
    assert.equal(await main(['--version', '0.4.0', '--dist', dist], { ...io, root: ROOT, readers: fakeReaders() }), 0)
    assert.match(text.out, /the x64 and arm64 installers and apps are built for their chips, the apps say version 0\.4\.0/)
  })

  it('exits 1 and lists every problem', async () => {
    const { text, ...io } = output()
    const dist = fakeDist({ chips: { arm64: 'arm64' } })
    const code = await main(['--version', '0.4.0', '--dist', dist, '--arch', 'arm64'], {
      ...io,
      root: ROOT,
      readers: fakeReaders({ version: '0.3.0' })
    })
    assert.equal(code, 1)
    assert.match(text.err, /^check-build: FAIL: .*app\.asar says version 0\.3\.0, expected 0\.4\.0\n$/)
  })
})
