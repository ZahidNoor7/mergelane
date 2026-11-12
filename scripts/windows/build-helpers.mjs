#!/usr/bin/env node
// Builds the Windows helpers that ship inside the app (electron-builder.yml, win.extraResources):
// mergelane-daemon.exe and mergelane-nmhost.exe for each chip, into daemon/bin/win-<x64|arm64>/. They are
// cross-compiled on the Mac with cgo off, the way the CI package job builds the macOS helpers, with the app's
// version stamped in (-X main.version). Beside them goes wintun.dll, the adapter driver's DLL the system-wide
// helper loads from its own folder (ADR-0059), from wintun.net's zip pinned by SHA-256, with its licence.
//
// usage: node scripts/windows/build-helpers.mjs [--arch x64|arm64]...
// Exit codes: 0 built; 1 a build failed; 2 wrong usage.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { downloadWithRetries, extract, peMachineOf, sha256File } from '../media-tools/fetch.mjs'
import { ARCHES, UsageError, run } from './kit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** The helpers, by their Go command folder under daemon/cmd. */
export const HELPERS = ['mergelane-daemon', 'mergelane-nmhost']

export function parseArgs(argv) {
  const arches = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--arch') throw new UsageError(`unknown argument: ${argv[i]}`)
    const value = argv[++i]
    if (!value) throw new UsageError('--arch needs a value')
    if (!(value in ARCHES)) throw new UsageError(`unknown --arch ${value} (x64 or arm64)`)
    if (!arches.includes(value)) arches.push(value)
  }
  return { arches: arches.length ? arches : Object.keys(ARCHES) }
}

/** The folder electron-builder takes a chip's helpers from (`../daemon/bin/win-${arch}`). */
export function binDir(root, arch) {
  return join(root, 'daemon', 'bin', `win-${arch}`)
}

export function appVersion(root) {
  return JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version
}

/**
 * Wintun 0.14.1, the official signed DLLs (https://www.wintun.net). The SHA-256 is the one wintun.net
 * publishes beside the download, checked against the downloaded zip. Its licence ("Prebuilt Binaries
 * License", LICENSE.txt in the zip) lets the unmodified DLL ship alongside software that uses it only
 * through wintun.h's API, which the helper does (golang.zx2c4.com/wintun).
 */
export const WINTUN = {
  version: '0.14.1',
  url: 'https://www.wintun.net/builds/wintun-0.14.1.zip',
  sha256: '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51',
  dll: { x64: 'wintun/bin/amd64/wintun.dll', arm64: 'wintun/bin/arm64/wintun.dll' },
  license: 'wintun/LICENSE.txt'
}

/**
 * Puts wintun.dll and its licence (wintun-LICENSE.txt) in each chip's helper folder. The zip is kept in
 * daemon/bin and downloaded again only when it is missing or its SHA-256 isn't the pinned one; a download
 * that doesn't match is deleted and refused. Each DLL must be built for its chip. Returns the files written.
 */
export async function fetchWintun({
  root = ROOT,
  arches,
  pin = WINTUN,
  download = downloadWithRetries,
  unzip = (zip, dir) => extract(zip, 'zip', dir),
  log = () => {}
}) {
  const zip = join(root, 'daemon', 'bin', `wintun-${pin.version}.zip`)
  mkdirSync(dirname(zip), { recursive: true })
  if (!existsSync(zip) || (await sha256File(zip)) !== pin.sha256) {
    rmSync(zip, { force: true })
    log(`downloading Wintun ${pin.version}`)
    await download(pin.url, zip, { log })
    const got = await sha256File(zip)
    if (got !== pin.sha256) {
      rmSync(zip, { force: true })
      throw new Error(`${pin.url} has SHA-256 ${got}, not the pinned ${pin.sha256}`)
    }
  }
  const unpacked = mkdtempSync(join(tmpdir(), 'mergelane-wintun-'))
  try {
    await unzip(zip, unpacked)
    const written = []
    for (const arch of arches) {
      const dll = join(unpacked, pin.dll[arch])
      const chip = await peMachineOf(dll)
      if (chip !== arch) throw new Error(`${pin.dll[arch]} is built for ${chip}, not ${arch}`)
      const dir = binDir(root, arch)
      mkdirSync(dir, { recursive: true })
      copyFileSync(dll, join(dir, 'wintun.dll'))
      copyFileSync(join(unpacked, pin.license), join(dir, 'wintun-LICENSE.txt'))
      written.push(join(dir, 'wintun.dll'), join(dir, 'wintun-LICENSE.txt'))
    }
    return written
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
}

/** Builds every helper for every chip; returns the files written. Throws with the compiler's output. */
export async function buildHelpers({ root = ROOT, arches, version = appVersion(root), runner = run, log = () => {} }) {
  const built = []
  for (const arch of arches) {
    for (const helper of HELPERS) {
      const file = join(binDir(root, arch), `${helper}.exe`)
      log(`building ${arch} ${helper}.exe`)
      const env = { ...process.env, GOOS: 'windows', GOARCH: ARCHES[arch], CGO_ENABLED: '0' }
      const args = ['build', '-trimpath', '-ldflags', `-X main.version=${version}`, '-o', file, `./cmd/${helper}`]
      const result = await runner('go', args, { cwd: join(root, 'daemon'), env })
      if (result.code !== 0) {
        throw new Error(`go build ${helper} for ${arch} failed:\n${(result.stderr || result.stdout).trim()}`)
      }
      built.push(file)
    }
  }
  return built
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, ...deps } = {}
) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr.write(`build-helpers: ${error.message}\nusage: node scripts/windows/build-helpers.mjs [--arch x64|arm64]...\n`)
    return 2
  }
  const { fetch = fetchWintun, ...buildDeps } = deps
  try {
    const log = (line) => stdout.write(`${line}\n`)
    const built = await buildHelpers({ ...options, log, ...buildDeps })
    built.push(...(await fetch({ ...options, log, ...(buildDeps.root ? { root: buildDeps.root } : {}) })))
    for (const file of built) stdout.write(`  ${file}\n`)
    return 0
  } catch (error) {
    stderr.write(`build-helpers: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
