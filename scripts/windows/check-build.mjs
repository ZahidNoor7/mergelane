#!/usr/bin/env node
// Checks the Windows build that electron-builder wrote into app/dist (W4, ADR-0058), the way the macOS release
// checks the app in the zip. A Windows program can't run on the Mac, so this reads the files instead:
//   - each chip's installer, Mergelane-<version>-<arch>-setup.exe, is there and is a Windows program. NSIS
//     installers are 32-bit x86 programs for both chips (Windows on Arm runs them emulated), so that is what
//     this expects;
//   - in each chip's unpacked app, Mergelane.exe and every program inside it (the two helpers, Wintun's DLL,
//     FFmpeg, Deno and yt-dlp, named by tools-windows-<arch>.json) is built for that chip;
//   - app.asar's package.json says the release version;
//   - Mergelane.exe's Electron fuses are the ones electron-builder.yml asks for (audit-fuses.mjs EXPECTED_FUSES),
//     read with @electron/fuses, which electron-builder itself uses to set them.
// The helpers' version stamp can't be read here: Go leaves -ldflags out of a -trimpath build's information (`go
// version -m`), and the Mac can't run them. The laptop test kit runs them and checks it (test-kit.ps1
// Test-HelperVersions).
//
// usage: node scripts/windows/check-build.mjs --version <x.y.z> [--dist <dir>] [--arch x64|arm64]...
// Exit codes: 0 every check passed; 1 a check failed; 2 wrong usage.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXPECTED_FUSES } from '../ci/audit-fuses.mjs'
import { peMachineOf } from '../media-tools/fetch.mjs'
import { APP_EXE, APP_FOLDERS, ARCHES, UsageError, installerName } from './kit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

export const USAGE = 'usage: node scripts/windows/check-build.mjs --version <x.y.z> [--dist <dir>] [--arch x64|arm64]...'

/** The chip every NSIS installer is built for, whichever chip it installs. */
export const INSTALLER_MACHINE = 'x86'

/** The helpers electron-builder.yml copies into resources. */
export const HELPERS = ['mergelane-daemon.exe', 'mergelane-nmhost.exe']

/** @electron/fuses' fuse states (its FuseState). */
const FUSE_STATES = { 48: 'disabled', 49: 'enabled', 114: 'removed', 144: 'inherit' }

export function parseArgs(argv) {
  const options = { version: null, dist: null, arches: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--version', '--dist', '--arch'].includes(flag)) throw new UsageError(`unknown argument: ${flag}`)
    const value = argv[++i]
    if (!value) throw new UsageError(`${flag} needs a value`)
    if (flag === '--version') options.version = value
    else if (flag === '--dist') options.dist = resolve(value)
    else if (!(value in ARCHES)) throw new UsageError(`unknown --arch ${value} (x64 or arm64)`)
    else if (!options.arches.includes(value)) options.arches.push(value)
  }
  if (!options.version) throw new UsageError('--version is required')
  if (!options.arches.length) options.arches = Object.keys(ARCHES)
  return options
}

/** The programs inside a chip's unpacked app, relative to its folder: Mergelane.exe, the helpers, Wintun's DLL
 * (ADR-0059) and the media tools. */
export function programsOf(manifest) {
  const programs = [APP_EXE, ...HELPERS.map((helper) => `resources/${helper}`), 'resources/wintun.dll']
  for (const tool of manifest.tools) {
    programs.push(
      tool.install === 'folder' ? `resources/${tool.name}/${tool.executable}` : `resources/${tool.name}.exe`
    )
  }
  return programs
}

/** Reads what the checks need from files: the fuses and app.asar's version. Tests replace it. */
export function defaultReaders(root) {
  const require = createRequire(join(root, 'app', 'package.json'))
  return {
    async fuses(exe) {
      const { getCurrentFuseWire } = require('@electron/fuses')
      return getCurrentFuseWire(exe)
    },
    asarVersion(asar) {
      const { extractFile } = require('@electron/asar')
      return JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version
    }
  }
}

/** Problems with the fuse wire @electron/fuses read, against audit-fuses.mjs's EXPECTED_FUSES. */
export function fuseProblems(wire, fuseOptions, expected = EXPECTED_FUSES) {
  const problems = []
  for (const [name, want] of Object.entries(expected)) {
    const state = FUSE_STATES[wire?.[fuseOptions[name]]] ?? 'missing'
    if (state !== want) problems.push(`fuse ${name} is ${state}, expected ${want}`)
  }
  return problems
}

/** Checks one chip; returns its problems, each naming the file. */
async function checkArch({ root, dist, version, arch, readers, fuseOptions }) {
  const problems = []
  const machine = async (file, want) => {
    if (!existsSync(file)) return problems.push(`${file} is missing`)
    try {
      const got = await peMachineOf(file)
      if (got !== want) problems.push(`${file} is built for ${got}, expected ${want}`)
    } catch (failure) {
      problems.push(failure.message)
    }
  }

  await machine(join(dist, installerName(version, arch)), INSTALLER_MACHINE)

  const app = join(dist, APP_FOLDERS[arch])
  const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'media-tools', `tools-windows-${arch}.json`), 'utf8'))
  for (const program of programsOf(manifest)) await machine(join(app, program), arch)

  const asar = join(app, 'resources', 'app.asar')
  try {
    const packaged = readers.asarVersion(asar)
    if (packaged !== version) problems.push(`${asar} says version ${packaged}, expected ${version}`)
  } catch (failure) {
    problems.push(`${asar}: cannot read its package.json: ${failure.message}`)
  }

  const exe = join(app, APP_EXE)
  if (existsSync(exe)) {
    try {
      for (const problem of fuseProblems(await readers.fuses(exe), fuseOptions)) problems.push(`${exe}: ${problem}`)
    } catch (failure) {
      problems.push(`${exe}: cannot read its fuses: ${failure.message}`)
    }
  }
  return problems
}

/** Every check for every chip. Resolves to the problems; none means the build is good. */
export async function checkWindowsBuild({
  root = ROOT,
  dist = join(root, 'app', 'dist'),
  version,
  arches = Object.keys(ARCHES),
  readers = defaultReaders(root),
  fuseOptions = createRequire(join(root, 'app', 'package.json'))('@electron/fuses').FuseV1Options
}) {
  const problems = []
  for (const arch of arches) {
    problems.push(...(await checkArch({ root, dist, version, arch, readers, fuseOptions })))
  }
  return problems
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, ...deps } = {}
) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr.write(`check-build: ${error.message}\n${USAGE}\n`)
    return 2
  }
  const { dist, ...rest } = options
  const problems = await checkWindowsBuild({ ...rest, ...(dist ? { dist } : {}), ...deps })
  if (problems.length) {
    for (const problem of problems) stderr.write(`check-build: FAIL: ${problem}\n`)
    return 1
  }
  stdout.write(
    `check-build: the ${options.arches.join(' and ')} installers and apps are built for their chips, the apps say ` +
      `version ${options.version} and have the expected fuses\n`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
