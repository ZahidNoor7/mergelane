#!/usr/bin/env node
// Builds the Windows test kit on this Mac (ADR-0054, docs/WINDOWS-TESTING.md). Claude can't run Windows code, so
// the owner copies the kit to their Windows laptop, runs it there, and pastes its report back into the chat, where
// scripts/windows/report.mjs reads it.
//
// The kit is a folder, and a zip of it, holding:
//   - test-kit.ps1: the script that runs on the laptop, in Windows PowerShell 5.1 (it comes with Windows);
//   - "Run test kit.cmd": starts that script for this one run with -ExecutionPolicy Bypass, which changes no
//     setting (about_Execution_Policies: a session's policy lives only in that session);
//   - README.txt: the steps, in plain words;
//   - go/<x64|arm64>/<package>/<name>.test.exe: the daemon's Go tests, cross-compiled for Windows with
//     `go test -c -cover` (one program per package that has Windows tests);
//   - app/<x64|arm64>/: Mergelane's installer for each chip (`npm run build:win` in app/), which the script
//     installs into the kit's own folder, opens once with a throwaway profile, and uninstalls again (W4); or, with
//     --unpacked, the unpacked app (`npm run build:win:dir`), which it only opens;
//   - kit.json: what to run, with each program's SHA-256, so the script can tell a damaged copy.
//
// Text files are written with Windows line endings. test-kit.ps1 must stay ASCII: Windows PowerShell reads a
// script without a byte-order mark in the ANSI code page (about_Character_Encoding), so anything else would be
// garbled.
//
// usage: node scripts/windows/kit.mjs [--out <dir>] [--arch x64|arm64]... [--no-zip] [--no-app | --unpacked]
// Exit codes: 0 built; 1 a build failed; 2 wrong usage.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** The kit format. test-kit.ps1 refuses a kit.json with another number. */
export const KIT_VERSION = 1

/** Windows chips, as the kit names them, and Go's names for them. */
export const ARCHES = { x64: 'amd64', arm64: 'arm64' }

/**
 * The daemon's packages whose tests the kit runs on Windows. A package is listed once it builds for Windows.
 * `until` names the milestone that makes its tests pass there: until then a failure is reported as "not yet",
 * and doesn't fail the run. Remove `until` when that milestone lands.
 */
export const GO_PACKAGES = [
  { pkg: 'cmd/mergelane-daemon', until: 'W5' },
  { pkg: 'cmd/mergelane-nmhost' },
  { pkg: 'internal/api', until: 'W5' },
  { pkg: 'internal/control' },
  { pkg: 'internal/engine' },
  { pkg: 'internal/nics' },
  { pkg: 'internal/nmhost' },
  { pkg: 'internal/platform' },
  { pkg: 'internal/rib' },
  { pkg: 'internal/state' },
  { pkg: 'internal/tun' },
  { pkg: 'internal/vpnguard' }
  // Not listed: cmd/fakevpn, internal/launchd and internal/routemark are macOS-only, and internal/logx has no tests.
]

/** Coverage lines the report carries back: the Windows-only files, the ones the Mac can't run. */
export const COVER_INCLUDE = '_windows\\.go:'

export const CMD_NAME = 'Run test kit.cmd'

/** The unpacked apps electron-builder writes to app/dist for each chip (`npm run build:win:dir`). */
export const APP_FOLDERS = { x64: 'win-unpacked', arm64: 'win-arm64-unpacked' }
export const APP_EXE = 'Mergelane.exe'

/** A chip's installer in app/dist (electron-builder.yml nsis.artifactName). */
export function installerName(version, arch) {
  return `Mergelane-${version}-${arch}-setup.exe`
}

export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { out: join(ROOT, 'dist', 'windows-kit'), arches: [], zip: true, apps: 'installer' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-zip') options.zip = false
    else if (arg === '--no-app') options.apps = false
    else if (arg === '--unpacked') options.apps = 'folder'
    else if (arg === '--out' || arg === '--arch') {
      const value = argv[++i]
      if (!value) throw new UsageError(`${arg} needs a value`)
      if (arg === '--out') options.out = resolve(value)
      else if (!(value in ARCHES)) throw new UsageError(`unknown --arch ${value} (x64 or arm64)`)
      else if (!options.arches.includes(value)) options.arches.push(value)
    } else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (options.arches.length === 0) options.arches = Object.keys(ARCHES)
  return options
}

/** Runs a command; resolves with its exit code and output, never rejects for a non-zero exit. */
export function run(file, args, { cwd, env } = {}) {
  return new Promise((done) => {
    execFile(file, args, { cwd, env, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      done({ code, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')) })
    })
  })
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Windows line endings, for files people open in Notepad or cmd.exe runs. */
export function crlf(text) {
  return text.replace(/\r?\n/g, '\r\n')
}

/** Throws unless every byte is 7-bit ASCII (see the header). */
export function assertAscii(name, text) {
  const index = [...text].findIndex((ch) => ch.charCodeAt(0) > 0x7f)
  if (index !== -1) {
    const line = text.slice(0, index).split('\n').length
    throw new Error(`${name} must be ASCII (Windows PowerShell 5.1 reads it in the ANSI code page): line ${line}`)
  }
}

/** The kit folder may be replaced only when it is missing, empty, or an earlier kit. */
export function prepareOut(out) {
  if (existsSync(out) && readdirSync(out).length > 0) {
    let isKit = false
    try {
      isKit = JSON.parse(readFileSync(join(out, 'kit.json'), 'utf8')).kit !== undefined
    } catch {
      isKit = false
    }
    if (!isKit) throw new UsageError(`${out} exists and isn't a test kit; choose another --out`)
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(out, { recursive: true })
}

/** Builds one Go test program; returns its kit-relative path, or null when the package has no Windows tests. */
export async function buildProgram({ root, out, pkg, arch, runner = run }) {
  const name = `${basename(pkg)}.test.exe`
  const relative = ['go', arch, ...pkg.split('/'), name].join('/')
  const file = join(out, ...relative.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  // -trimpath keeps this Mac's folder names out of the program; CGO is off, so no C toolchain is needed.
  const result = await runner('go', ['test', '-c', '-cover', '-trimpath', '-o', file, `./${pkg}`], {
    cwd: join(root, 'daemon'),
    env: { ...process.env, GOOS: 'windows', GOARCH: ARCHES[arch], CGO_ENABLED: '0' }
  })
  if (result.code !== 0) {
    throw new Error(`go test -c ${pkg} for ${arch} failed:\n${(result.stderr || result.stdout).trim()}`)
  }
  // `go test -c` writes nothing for a package without test files for that platform.
  return existsSync(file) ? relative : null
}

/** Copies a chip's installer into the kit; returns its kit.json entry. */
export function addInstaller({ root, out, arch }) {
  const version = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version
  const name = installerName(version, arch)
  const from = join(root, 'app', 'dist', name)
  if (!existsSync(from)) {
    throw new UsageError(`no ${arch} installer at ${from}: run "npm run build:win" in app/, or pass --unpacked or --no-app`)
  }
  mkdirSync(join(out, 'app', arch), { recursive: true })
  cpSync(from, join(out, 'app', arch, name))
  return { arch, kind: 'installer', version, path: `app/${arch}/${name}`, sha256: sha256(from) }
}

/** Copies a chip's unpacked app into the kit; returns its kit.json entry. */
export function addApp({ root, out, arch }) {
  const from = join(root, 'app', 'dist', APP_FOLDERS[arch])
  const exe = join(from, APP_EXE)
  if (!existsSync(exe)) {
    throw new UsageError(`no ${arch} Windows app in ${from}: run "npm run build:win:dir" in app/, or pass --no-app`)
  }
  cpSync(from, join(out, 'app', arch), { recursive: true })
  const version = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version
  return { arch, kind: 'folder', version, path: `app/${arch}/${APP_EXE}`, sha256: sha256(exe) }
}

async function commitOf(root, runner) {
  const head = await runner('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
  const status = await runner('git', ['status', '--porcelain'], { cwd: root })
  return {
    commit: head.code === 0 ? head.stdout.trim() : 'unknown',
    dirty: status.code === 0 ? status.stdout.trim() !== '' : true
  }
}

export function cmdFile() {
  // %~dp0 is this file's folder. Windows PowerShell is always at this path, also on Arm PCs.
  return crlf(`@echo off
rem Starts Mergelane's Windows test kit. -ExecutionPolicy Bypass applies to this run only and changes no setting.
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-kit.ps1"
echo.
pause
`)
}

export function readme({ commit, built }) {
  return crlf(`Mergelane Windows test kit
==========================

Built from commit ${commit} on ${built.slice(0, 10)}.

What it does
- Reads which Windows, which chip and which Smart App Control setting this PC has.
- Runs Mergelane's own test programs from this folder.
- Installs Mergelane into this folder for a minute (for your user only, no administrator rights), opens it once
  with a test profile kept in this folder, checks its window, its browser bridge and its two helper programs, and
  uninstalls it again. While it is installed, Windows also lists it in Settings > Apps, and the installer adds a
  Start menu entry, a desktop shortcut and "Open with" entries for .torrent and .nzb files (never the default app);
  the uninstaller removes them, and the kit checks that it did. If Mergelane is already installed for you, the kit
  leaves it alone and skips this step.
- Looks at the names of the files in your Downloads folder before and after, to prove the tests never write
  there. It doesn't open them.
- Writes report.txt in this folder and copies the report to the clipboard.

It needs no administrator rights and changes no settings. Everything it writes stays in this folder, except the
Start menu entry, desktop shortcut, Apps list entry and Open with entries that Mergelane's installer adds while it
is installed, which its uninstaller takes away again.

How to run it
1. Double-click "${CMD_NAME}" (not "Run as administrator").
   If Windows warns about the file first, choose to run it: "Run", or "More info" and then "Run anyway".
   The kit isn't signed, so Windows doesn't know it yet.
2. Wait for "Done". It takes a minute or two.
3. Paste the report into the chat (it is already on the clipboard; it is also in report.txt).
4. Press a key to close the window.

To remove the kit afterwards, delete this folder.
`)
}

export async function buildKit({
  root = ROOT,
  out,
  arches = Object.keys(ARCHES),
  zip = true,
  apps = false,
  packages = GO_PACKAGES,
  runner = run,
  now = () => new Date(),
  log = () => {}
}) {
  const script = readFileSync(join(root, 'scripts', 'windows', 'test-kit.ps1'), 'utf8')
  assertAscii('test-kit.ps1', script)
  prepareOut(out)

  const programs = []
  const noTests = []
  for (const arch of arches) {
    for (const { pkg, until } of packages) {
      log(`building ${arch} ${pkg}`)
      const path = await buildProgram({ root, out, pkg, arch, runner })
      if (!path) {
        noTests.push(`${arch}/${pkg}`)
        continue
      }
      const entry = { id: `${arch}/${pkg}`, arch, package: pkg, path, sha256: sha256(join(out, path)) }
      if (until) entry.until = until
      programs.push(entry)
    }
  }

  const appEntries = []
  if (apps) {
    for (const arch of arches) {
      log(`adding the ${arch} ${apps === 'folder' ? 'app' : 'installer'}`)
      appEntries.push(apps === 'folder' ? addApp({ root, out, arch }) : addInstaller({ root, out, arch }))
    }
  }

  const { commit, dirty } = await commitOf(root, runner)
  const built = now().toISOString()
  const kit = { kit: KIT_VERSION, commit, dirty, built, coverInclude: COVER_INCLUDE, programs, apps: appEntries }
  writeFileSync(join(out, 'kit.json'), `${JSON.stringify(kit, null, 2)}\n`)
  writeFileSync(join(out, 'test-kit.ps1'), crlf(script))
  writeFileSync(join(out, CMD_NAME), cmdFile())
  writeFileSync(join(out, 'README.txt'), readme({ commit, built }))

  let zipFile = null
  if (zip) {
    zipFile = join(dirname(out), `mergelane-${basename(out)}.zip`)
    rmSync(zipFile, { force: true })
    // -X leaves out macOS file attributes, so Windows' Extract All sees only the kit's files.
    const result = await runner('zip', ['-r', '-X', '-q', zipFile, basename(out)], { cwd: dirname(out) })
    if (result.code !== 0) throw new Error(`zip failed:\n${(result.stderr || result.stdout).trim()}`)
  }
  return { kit, noTests, zipFile }
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, ...deps } = {}
) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr.write(
      `kit: ${error.message}\nusage: node scripts/windows/kit.mjs [--out <dir>] [--arch x64|arm64]... [--no-zip] [--no-app | --unpacked]\n`
    )
    return 2
  }
  try {
    const { kit, noTests, zipFile } = await buildKit({ ...options, log: (line) => stdout.write(`${line}\n`), ...deps })
    for (const program of kit.programs) stdout.write(`  ${program.path}\n`)
    for (const app of kit.apps) stdout.write(`  ${app.path}\n`)
    for (const id of noTests) stdout.write(`  ${id}: no Windows tests, nothing to run\n`)
    if (kit.dirty) stdout.write('Note: the checkout has uncommitted changes; kit.json says so.\n')
    stdout.write(`Kit: ${options.out}\n`)
    if (zipFile) stdout.write(`Zip: ${zipFile}\n`)
    return 0
  } catch (error) {
    stderr.write(`kit: ${error.message}\n`)
    return error instanceof UsageError ? 2 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
