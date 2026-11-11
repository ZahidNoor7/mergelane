// Collects the source code that the bundled programs' licences ask us to offer, for attaching to a
// GitHub release (ADR-0027, docs/RELEASING.md).
//
// usage: node scripts/media-tools/sources.mjs <output-dir> [--manifest <tools.json>]
//
// For each tool in tools.json:
//   - a tool under a GPL-family licence (GPL or LGPL) must have an https sourceUrl and a pinned
//     sourceSha256, or this fails: we promise that source on every release;
//   - a tool with a sourceSha256 has its source downloaded, checked against that hash, and saved as
//     <name>-<version>-source<ext> (e.g. ffmpeg-9.0.2-source.tar.xz);
//   - a tool with a buildScript (a path next to the manifest) has it copied as
//     <name>-<version>-<script name>, so the exact build recipe travels with the source.
// Tools under other licences (Deno: MIT) need no source and are skipped.
// A dropped or stalled connection, or a server error, is tried again twice, after 5 and 10 seconds.
// Any failure exits 1 and leaves no partial file behind. Node.js built-ins only.
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { downloadWithRetries, urlProblem } from './fetch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MANIFEST = join(HERE, 'tools.json')

const SHA256 = /^[0-9a-f]{64}$/
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ARCHIVE_EXT = /\.(tar\.(?:gz|xz|bz2)|tgz|zip)$/

/** Whether a licence string is GPL-family (GPL, LGPL, AGPL), which obliges us to offer source. */
export function isCopyleft(license) {
  return /\b(?:A|L)?GPL\b|GPL-|LGPL-/.test(String(license ?? ''))
}

/** The archive extension of a source URL (".tar.xz"), or "" when it has none we know. */
export function archiveExtension(url) {
  const match = ARCHIVE_EXT.exec(new URL(url).pathname)
  return match ? `.${match[1]}` : ''
}

/**
 * The file names a tool's source archive and build script get on the release, or null when tools.json
 * pins no source for it (nothing is attached). The release notes name the same files.
 */
export function releaseSourceNames(tool) {
  if (tool?.sourceSha256 === undefined) return null
  return {
    source: `${tool.name}-${tool.version}-source${archiveExtension(tool.sourceUrl)}`,
    buildScript:
      tool.buildScript === undefined ? null : `${tool.name}-${tool.version}-${tool.buildScript}`
  }
}

/** Problems that stop a release from carrying the source it promises; empty when there are none. */
export function sourceProblems(manifest) {
  const problems = []
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : null
  if (!tools) return ['the manifest has no "tools" list']
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : '(unnamed)'
    if (!SAFE_PART.test(name) || !SAFE_PART.test(String(tool?.version ?? ''))) {
      problems.push(`${name}: name and version must be plain file-name parts`)
      continue
    }
    const needsSource = isCopyleft(tool.license)
    if (tool.sourceSha256 === undefined) {
      if (needsSource) problems.push(`${name}: ${tool.license} needs a pinned sourceSha256`)
      continue
    }
    if (!SHA256.test(String(tool.sourceSha256))) {
      problems.push(`${name}: sourceSha256 must be 64 lowercase hex characters`)
    }
    // https only (plain http is allowed for loopback, which only the tests use): fetch.mjs's rule.
    const urlIssue = typeof tool.sourceUrl === 'string' ? urlProblem(tool.sourceUrl) : 'no URL'
    if (urlIssue) problems.push(`${name}: sourceUrl must be an https URL`)
    if (tool.buildScript !== undefined && !SAFE_PART.test(String(tool.buildScript))) {
      problems.push(`${name}: buildScript must be a file name next to the manifest`)
    }
  }
  return problems
}

/**
 * Downloads and checks every pinned source archive into outDir, and copies build scripts.
 * Returns the paths written, in manifest order. `network` passes options through to
 * downloadWithRetries() (attempts, pauses) and download().
 */
export async function collectSources(manifest, { outDir, manifestDir, log = () => {}, ...network }) {
  const problems = sourceProblems(manifest)
  if (problems.length > 0) throw new Error(`cannot collect sources:\n  - ${problems.join('\n  - ')}`)
  await mkdir(outDir, { recursive: true })
  const written = []
  for (const tool of manifest.tools) {
    if (tool.sourceSha256 === undefined) {
      log(`${tool.name}: ${tool.license}, no source to attach`)
      continue
    }
    const names = releaseSourceNames(tool)
    const file = join(outDir, names.source)
    const part = `${file}.part`
    await rm(part, { force: true })
    try {
      const { sha256 } = await downloadWithRetries(tool.sourceUrl, part, { log, ...network })
      if (sha256 !== tool.sourceSha256) {
        throw new Error(
          `${tool.name}: source SHA-256 is ${sha256}, expected ${tool.sourceSha256} (${tool.sourceUrl})`
        )
      }
      await rename(part, file)
    } catch (failure) {
      await rm(part, { force: true })
      throw failure
    }
    written.push(file)
    log(`${tool.name}: ${basename(file)} (SHA-256 ${tool.sourceSha256})`)
    if (names.buildScript !== null) {
      const script = join(outDir, names.buildScript)
      await copyFile(join(manifestDir, tool.buildScript), script)
      written.push(script)
      log(`${tool.name}: ${basename(script)}`)
    }
  }
  return written
}

/** CLI entry point. Returns the exit code. */
export async function main(
  argv = process.argv.slice(2),
  { log = console.log, error = console.error } = {}
) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { manifest: { type: 'string' } },
      allowPositionals: true,
      strict: true
    })
    if (positionals.length !== 1) {
      throw new Error(`expected one output directory, got ${positionals.length}`)
    }
    const manifestPath = resolve(values.manifest ?? DEFAULT_MANIFEST)
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (failure) {
      throw new Error(`cannot read the manifest ${manifestPath}: ${failure.message}`)
    }
    const outDir = resolve(positionals[0])
    await collectSources(manifest, { outDir, manifestDir: dirname(manifestPath), log })
    log(`sources ready in ${outDir}`)
    return 0
  } catch (failure) {
    error(`media-tools sources: ${failure.message}`)
    return 1
  }
}

/** True when this file is the script Node was started with (Node runs the main module by real path). */
function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.exitCode = await main()
}
