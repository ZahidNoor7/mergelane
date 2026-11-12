#!/usr/bin/env node
// Builds the Windows helpers that ship inside the app (electron-builder.yml, win.extraResources):
// mergelane-daemon.exe and mergelane-nmhost.exe for each chip, into daemon/bin/win-<x64|arm64>/. They are
// cross-compiled on the Mac with cgo off, the way the CI package job builds the macOS helpers, with the app's
// version stamped in (-X main.version).
//
// usage: node scripts/windows/build-helpers.mjs [--arch x64|arm64]...
// Exit codes: 0 built; 1 a build failed; 2 wrong usage.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  try {
    const built = await buildHelpers({ ...options, log: (line) => stdout.write(`${line}\n`), ...deps })
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
