// Writes the notices of the third-party code built into the Deno program Mergelane ships
// (ADR-0029): scripts/media-tools/licenses/deno/THIRD-PARTY-NOTICES.txt. fetch.mjs copies it into
// the app with Deno's own licence (tools.json's licenseFiles), and package-test.sh checks it is there.
//
// usage: node scripts/media-tools/deno-notices.mjs [--config <deno-notices.json>] [--out <file>]
//        [--cache <dir>] [--jobs <n>]
//
// Deno's release publishes no such list, so it is built from official sources only, every one
// pinned (deno-notices.json says which):
//   1. Rust crates: Deno's source release (deno_src.tar.gz, checked against its pinned SHA-256)
//      gives Cargo.lock. Every crates.io package in it is downloaded from crates.io and checked
//      against Cargo.lock's SHA-256; its licence, notice and copying files are read from the package
//      as published (the crate's own and those of code it bundles, outside its tests, examples and
//      docs). A crate whose package has no licence file of its own gets the files deno-notices.json
//      pins from the crate's repository at the commit it was published from (crateFallbacks), or
//      the standard text of its declared licence (spdxTexts), and is listed as such.
//   2. V8 and the C and C++ libraries built into it, and the JavaScript projects Deno carries
//      (TypeScript, Node.js's code): licence files at pinned commits (components).
//   3. The licence files inside Deno's source (deno.licenseFiles) and the copyright notices in the
//      comments of Deno's own JavaScript and TypeScript (deno.headerScan), which Deno builds into
//      the program.
// Each distinct text is written once and labelled [T1], [T2], ... The output has no dates, so the
// same inputs always give the same file. --cache keeps the downloaded crates between runs.
// Needs /usr/bin/tar. Node.js built-ins only, and fetch.mjs's download().
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { download, sha256File } from './fetch.mjs'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CONFIG = join(HERE, 'deno-notices.json')
export const DEFAULT_OUT = join(HERE, 'licenses/deno/THIRD-PARTY-NOTICES.txt')
export const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'
const SHA256 = /^[0-9a-f]{64}$/
const TAR = '/usr/bin/tar'

export const USAGE =
  'usage: node scripts/media-tools/deno-notices.mjs [--config <deno-notices.json>] [--out <file>] [--cache <dir>] [--jobs <n>]'

// ---------------------------------------------------------------------------------------------
// Reading Cargo files.
// ---------------------------------------------------------------------------------------------

/** The [[package]] entries of a Cargo.lock: [{ name, version, source?, checksum? }]. */
export function parseCargoLock(text) {
  const packages = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '[[package]]') {
      current = {}
      packages.push(current)
    } else if (line.startsWith('[')) {
      current = null
    } else if (current !== null) {
      const match = /^(name|version|source|checksum) = "([^"]*)"$/.exec(line)
      if (match) current[match[1]] = match[2]
    }
  }
  if (packages.length === 0) throw new Error('Cargo.lock lists no packages')
  for (const pkg of packages) {
    if (!pkg.name || !pkg.version)
      throw new Error(`Cargo.lock has a package without a name or version`)
  }
  return packages
}

/** The crates.io packages, sorted, and the count of the workspace's own (unpublished) crates.
 * Throws on a package from anywhere else (a git dependency), which this script can't fetch. */
export function splitPackages(packages) {
  const crates = []
  let local = 0
  for (const pkg of packages) {
    if (pkg.source === undefined) {
      local++
    } else if (pkg.source === CRATES_IO) {
      if (!SHA256.test(pkg.checksum ?? '')) {
        throw new Error(`Cargo.lock gives ${pkg.name} ${pkg.version} no SHA-256 checksum`)
      }
      crates.push({ name: pkg.name, version: pkg.version, checksum: pkg.checksum })
    } else {
      throw new Error(`${pkg.name} ${pkg.version} comes from ${pkg.source}, which is not supported`)
    }
  }
  crates.sort((a, b) =>
    a.name === b.name ? compareText(a.version, b.version) : compareText(a.name, b.name)
  )
  return { crates, local }
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** license, license-file and repository from a published crate's (normalised) Cargo.toml. */
export function parseCargoToml(text) {
  const found = {}
  let inPackage = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inPackage = line === '[package]'
      continue
    }
    if (!inPackage) continue
    const match = /^(license|license-file|repository)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (match) found[match[1]] = unescapeToml(match[2])
  }
  return {
    license: found.license ?? null,
    licenseFile: found['license-file'] ?? null,
    repository: found.repository ?? null
  }
}

function unescapeToml(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------------------------
// Choosing and keeping licence texts.
// ---------------------------------------------------------------------------------------------

/** A licence, notice or copying file's name (LICENSE, LICENSE-MIT, COPYING, NOTICE.txt, ...). */
export const LICENSE_NAME =
  /^(licen[cs]e|copying|notice|copyright|unlicense|patents)([-._][^/]*)?$/i
/** Program files that happen to share those names (license.rs, notice.h). */
const CODE_FILE =
  /\.(rs|c|cc|cpp|h|hpp|m|mm|js|mjs|cjs|ts|py|go|java|toml|json|ya?ml|sh|html?|css|in|xml|svg|png)$/i
/** Folders whose files are not in the program. */
export const SKIP_DIRS =
  /(^|\/)(tests?|testdata|test[-_]data|fixtures?|benches|benchmarks?|examples?|docs?)(\/|$)/i

export function isLicenseFile(path) {
  const name = posix.basename(path)
  return LICENSE_NAME.test(name) && !CODE_FILE.test(name) && !SKIP_DIRS.test(posix.dirname(path))
}

/**
 * The archive members to read for a crate: its license-file, every licence-named file outside
 * tests, examples and docs, and a REUSE-style LICENSES/ folder. `entries` are the archive's paths;
 * `prefix` the crate's folder in it ("name-version"). Returns paths relative to the folder, sorted.
 */
export function licenseMembers(entries, prefix, licenseFile) {
  const wanted = licenseFile === null ? null : posix.normalize(licenseFile)
  const picked = new Set()
  for (const entry of entries) {
    if (!entry.startsWith(`${prefix}/`) || entry.endsWith('/')) continue
    const path = entry.slice(prefix.length + 1)
    if (path === wanted || path.startsWith('LICENSES/') || isLicenseFile(path)) picked.add(path)
  }
  return [...picked].sort(compareText)
}

/** True when a crate's own licence text is among its files (at its top level, or its license-file). */
export function hasOwnText(paths, licenseFile) {
  return paths.some(
    (path) => !path.includes('/') || path.startsWith('LICENSES/') || path === licenseFile
  )
}

/** Line endings to \n, trailing spaces and surrounding blank lines removed. */
export function normalizeText(text) {
  const lines = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  return lines.slice(start, end).join('\n')
}

/** Keeps each distinct text once, labelled [T1], [T2], ... in the order first seen. */
export class TextStore {
  #byHash = new Map()

  add(text) {
    const normal = normalizeText(text)
    if (normal === '') throw new Error('an empty licence text')
    const hash = createHash('sha256').update(normal).digest('hex')
    let entry = this.#byHash.get(hash)
    if (!entry) {
      entry = { label: `T${this.#byHash.size + 1}`, text: normal, sha256: hash }
      this.#byHash.set(hash, entry)
    }
    return entry.label
  }

  entries() {
    return [...this.#byHash.values()]
  }
}

/** The text before the line `marker`; throws when the marker isn't there. */
export function cutBefore(text, marker) {
  const at = text.indexOf(marker)
  if (at === -1) throw new Error(`the text has no line "${marker}"`)
  return text.slice(0, at)
}

// ---------------------------------------------------------------------------------------------
// Notices in source comments.
// ---------------------------------------------------------------------------------------------

/** The comments of a JavaScript or TypeScript file, without their markers: each block comment,
 * and each run of line comments, as one text. */
export function commentBlocks(source) {
  const blocks = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let run = []
  const flush = () => {
    if (run.length > 0) blocks.push(run.join('\n'))
    run = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('//')) {
      run.push(line.replace(/^\/\/\/?\s?/, ''))
      continue
    }
    flush()
    if (!line.startsWith('/*')) continue
    const body = []
    let j = i
    for (; j < lines.length; j++) {
      body.push(lines[j])
      if (lines[j].includes('*/') && (j > i || lines[j].indexOf('*/') > lines[j].indexOf('/*')))
        break
    }
    i = j
    blocks.push(
      body
        .join('\n')
        .replace(/^\s*\/\*+!?/, '')
        .replace(/\*+\/[\s\S]*$/, '')
        .split('\n')
        .map((part) => part.replace(/^\s*\* ?/, ''))
        .join('\n')
    )
  }
  flush()
  return blocks
}

const DENO_COPYRIGHT = /copyright[^\n]*the deno authors/i

/** The third-party notices in some files' comments: comment blocks with a copyright line that is
 * not the Deno authors' own (their lines are dropped), grouped by text. Long comments (over
 * `maxLines`) are documentation, not notices, and are skipped. */
export function noticeHeaders(files, { maxLines = 60 } = {}) {
  const byText = new Map()
  for (const { path, text } of files) {
    for (const block of commentBlocks(text)) {
      const kept = block
        .split('\n')
        .filter((line) => !DENO_COPYRIGHT.test(line))
        .join('\n')
      if (!/copyright/i.test(kept)) continue
      const notice = normalizeText(kept)
      if (notice.split('\n').length > maxLines) continue
      const paths = byText.get(notice) ?? new Set()
      paths.add(path)
      byText.set(notice, paths)
    }
  }
  return [...byText.entries()]
    .map(([text, paths]) => ({ text, files: [...paths].sort(compareText) }))
    .sort((a, b) => compareText(a.files[0], b.files[0]) || compareText(a.text, b.text))
}

/** Every .js, .mjs, .cjs and .ts file under `dirs` (relative to `root`), outside test folders. */
export async function scriptFiles(root, dirs) {
  const found = []
  async function walk(rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch (error) {
      throw new Error(`cannot read ${rel} in the Deno source: ${error.message}`)
    }
    for (const entry of entries) {
      const path = posix.join(rel, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.test(entry.name)) await walk(path)
      } else if (entry.isFile() && /\.(m|c)?[jt]s$/.test(entry.name)) {
        found.push(path)
      }
    }
  }
  for (const dir of dirs) await walk(dir)
  return found.sort(compareText)
}

// ---------------------------------------------------------------------------------------------
// The inputs, fetched and checked.
// ---------------------------------------------------------------------------------------------

/** Problems with deno-notices.json; empty when it can be used. */
export function validateConfig(config) {
  const problems = []
  const deno = config?.deno
  if (!deno || typeof deno !== 'object') return ['missing "deno"']
  for (const field of ['version', 'commit', 'sourceUrl', 'sourceSha256', 'sourceRoot']) {
    if (typeof deno[field] !== 'string' || deno[field] === '')
      problems.push(`deno: missing "${field}"`)
  }
  if (deno.sourceSha256 !== undefined && !SHA256.test(deno.sourceSha256)) {
    problems.push('deno: "sourceSha256" must be 64 lowercase hex characters')
  }
  for (const field of ['licenseFiles', 'headerScan']) {
    if (!Array.isArray(deno[field])) problems.push(`deno: "${field}" must be a list`)
    else if (deno[field].some((path) => typeof path !== 'string' || !isInside(path))) {
      problems.push(`deno: "${field}" must list relative paths inside the source`)
    }
  }
  if (
    typeof config.crateUrl !== 'string' ||
    !config.crateUrl.includes('{name}') ||
    !config.crateUrl.includes('{version}')
  ) {
    problems.push('"crateUrl" must contain {name} and {version}')
  }
  const fileProblems = (label, files) => {
    if (!Array.isArray(files) || files.length === 0)
      return problems.push(`${label}: "files" must be a non-empty list`)
    for (const file of files) {
      if (typeof file?.path !== 'string' || typeof file?.url !== 'string') {
        problems.push(`${label}: every file needs "path" and "url"`)
      } else if (file.encoding !== undefined && file.encoding !== 'base64') {
        problems.push(`${label}: ${file.path}: "encoding" can only be base64`)
      }
    }
  }
  for (const [key, files] of Object.entries(config.crateFallbacks ?? {})) {
    if (!/^[^@\s]+@[^@\s]+$/.test(key))
      problems.push(`crateFallbacks: "${key}" must be name@version`)
    fileProblems(`crateFallbacks ${key}`, files)
  }
  for (const [id, file] of Object.entries(config.spdxTexts ?? {})) {
    if (typeof file?.url !== 'string') problems.push(`spdxTexts ${id}: needs "url"`)
  }
  if (!Array.isArray(config.components)) problems.push('"components" must be a list')
  else {
    for (const component of config.components) {
      const label = component?.name ?? '(a component)'
      for (const field of ['name', 'license', 'repository', 'commit']) {
        if (typeof component?.[field] !== 'string' || component[field] === '') {
          problems.push(`${label}: missing "${field}"`)
        }
      }
      fileProblems(label, component?.files)
    }
  }
  return problems
}

function isInside(path) {
  const normal = normalize(path)
  return path !== '' && !normal.startsWith('..') && !normal.startsWith('/') && normal !== '.'
}

/** The real input/output: downloads (https only, as fetch.mjs allows), and /usr/bin/tar. */
export function realIo(work) {
  let count = 0
  const scratch = () => join(work, `download-${++count}`)
  return {
    async downloadChecked(url, sha256, dest) {
      const part = `${dest}.part`
      await rm(part, { force: true })
      const got = await download(url, part)
      if (got.sha256 !== sha256) {
        await rm(part, { force: true })
        throw new Error(`${url}: SHA-256 is ${got.sha256}, expected ${sha256}`)
      }
      await rename(part, dest)
    },
    async fetchText(url, encoding) {
      const file = scratch()
      try {
        await download(url, file)
        const text = await readFile(file, 'utf8')
        return encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text
      } finally {
        await rm(file, { force: true })
      }
    },
    async listTar(file) {
      const { stdout } = await execFileAsync(TAR, ['-tzf', file], { maxBuffer: 256 * 1024 * 1024 })
      return stdout.split('\n').filter(Boolean)
    },
    async extractTar(file, members, dir) {
      await mkdir(dir, { recursive: true })
      if (members.length === 0) return
      await execFileAsync(TAR, ['-xzf', file, '-C', dir, ...members], {
        maxBuffer: 64 * 1024 * 1024
      })
    }
  }
}

/** Runs `worker` over `items`, `jobs` at a time, keeping the order of the results. */
export async function mapLimit(items, jobs, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, lane))
  return results
}

/** Reads one crate: downloaded (or taken from the cache when its SHA-256 still matches), checked
 * against Cargo.lock, then its Cargo.toml and licence files. Its texts come back as
 * [{ path, text }], labelled later in a fixed order. */
export async function readCrate(crate, { config, io, work, cache, standardTexts }) {
  const fileName = `${crate.name}-${crate.version}.crate`
  const archive = join(cache ?? join(work, 'crates'), fileName)
  await mkdir(dirname(archive), { recursive: true })
  let cached = false
  try {
    cached = (await stat(archive)).isFile() && (await sha256File(archive)) === crate.checksum
  } catch {
    cached = false
  }
  if (!cached) {
    await rm(archive, { force: true })
    const url = config.crateUrl
      .replaceAll('{name}', crate.name)
      .replaceAll('{version}', crate.version)
    await io.downloadChecked(url, crate.checksum, archive)
  }
  const prefix = `${crate.name}-${crate.version}`
  const entries = await io.listTar(archive)
  if (!entries.includes(`${prefix}/Cargo.toml`)) {
    throw new Error(`${prefix}.crate has no ${prefix}/Cargo.toml`)
  }
  const out = join(work, 'x', prefix)
  await io.extractTar(archive, [`${prefix}/Cargo.toml`], out)
  const manifest = parseCargoToml(await readFile(join(out, prefix, 'Cargo.toml'), 'utf8'))
  const paths = licenseMembers(entries, prefix, manifest.licenseFile)
  await io.extractTar(
    archive,
    paths.map((path) => `${prefix}/${path}`),
    out
  )
  const texts = []
  for (const path of paths) {
    const text = await readFile(join(out, prefix, path), 'utf8')
    if (normalizeText(text) !== '') texts.push({ path, text })
  }
  await rm(out, { recursive: true, force: true })
  if (!cache) await rm(archive, { force: true })

  const record = { ...crate, ...manifest, texts, source: 'package' }
  if (hasOwnText(paths, manifest.licenseFile)) return record
  const key = `${crate.name}@${crate.version}`
  const fallback = config.crateFallbacks?.[key]
  if (fallback) {
    for (const file of fallback) {
      record.texts.push({
        path: `${file.path} (${file.url})`,
        text: await fetchConfigured(io, file)
      })
    }
    record.source = 'repository'
    return record
  }
  const ids = spdxIds(manifest.license)
  if (ids.length > 0 && ids.every((id) => standardTexts.has(id))) {
    for (const id of ids)
      record.texts.push({ path: `${id} (standard text)`, text: standardTexts.get(id) })
    record.source = 'standard'
    return record
  }
  record.source = 'missing'
  return record
}

/** The licence identifiers in an SPDX expression ("MIT OR Apache-2.0", "MIT/Apache-2.0"). */
export function spdxIds(expression) {
  if (!expression) return []
  const ids = expression
    .split(/\s+(?:OR|AND|WITH)\s+|\/|[()]/)
    .map((part) => part.trim())
    .filter(Boolean)
  return [...new Set(ids)].sort(compareText)
}

async function fetchConfigured(io, file) {
  const text = await io.fetchText(file.url, file.encoding)
  return file.until === undefined ? text : cutBefore(text, file.until)
}

/**
 * Builds the notices. `io` does the downloads and archive reading (realIo, or a test's); `work` is
 * a scratch folder; `cache` keeps crates between runs; `log` reports progress.
 */
export async function generate(config, { io, work, cache = null, jobs = 8, log = () => {} }) {
  const problems = validateConfig(config)
  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`)
  const { deno } = config
  const store = new TextStore()

  // The source release: Cargo.lock, the licence files, and the scripts to scan.
  const source = join(work, 'deno_src.tar.gz')
  log(`deno ${deno.version}: ${deno.sourceUrl}`)
  await io.downloadChecked(deno.sourceUrl, deno.sourceSha256, source)
  const root = deno.sourceRoot
  const srcDir = join(work, 'src')
  await io.extractTar(
    source,
    [
      `${root}/Cargo.lock`,
      ...deno.licenseFiles.map((path) => `${root}/${path}`),
      ...deno.headerScan.map((path) => `${root}/${path}`)
    ],
    srcDir
  )
  const base = join(srcDir, root)
  const { crates, local } = splitPackages(
    parseCargoLock(await readFile(join(base, 'Cargo.lock'), 'utf8'))
  )

  const standardTexts = new Map()
  for (const [id, file] of Object.entries(config.spdxTexts ?? {})) {
    standardTexts.set(id, await fetchConfigured(io, file))
  }

  log(`${crates.length} crates from crates.io`)
  let done = 0
  const crateRecords = await mapLimit(crates, jobs, async (crate) => {
    const record = await readCrate(crate, { config, io, work, cache, standardTexts })
    if (++done % 100 === 0) log(`  ${done} of ${crates.length}`)
    return record
  })
  // Labelled in the crates' order, whatever order the downloads finished in.
  const labelled = crateRecords.map((record) => ({
    ...record,
    texts: record.texts.map(({ path, text }) => ({ path, label: store.add(text) }))
  }))

  const components = []
  for (const component of config.components) {
    const files = []
    for (const file of component.files) {
      files.push({
        path: file.path,
        url: file.url,
        label: store.add(await fetchConfigured(io, file))
      })
    }
    components.push({ ...component, files })
  }

  const sourceFiles = []
  for (const path of deno.licenseFiles) {
    sourceFiles.push({ path, label: store.add(await readFile(join(base, path), 'utf8')) })
  }
  const scanned = await scriptFiles(base, deno.headerScan)
  const headers = noticeHeaders(
    await Promise.all(
      scanned.map(async (path) => ({ path, text: await readFile(join(base, path), 'utf8') }))
    )
  )
  return render({
    config,
    crates: labelled,
    local,
    components,
    sourceFiles,
    headers,
    scannedCount: scanned.length,
    store
  })
}

// ---------------------------------------------------------------------------------------------
// The file.
// ---------------------------------------------------------------------------------------------

const RULE = '-'.repeat(100)

export function render({
  config,
  crates,
  local,
  components,
  sourceFiles,
  headers,
  scannedCount,
  store
}) {
  const { deno } = config
  const missing = crates.filter((crate) => crate.source === 'missing')
  const standard = crates.filter((crate) => crate.source === 'standard')
  const repository = crates.filter((crate) => crate.source === 'repository')
  const out = []
  const push = (...lines) => out.push(...lines)
  push(
    `THIRD-PARTY NOTICES FOR DENO ${deno.version}`,
    '',
    `Mergelane ships Deno ${deno.version} (deno-aarch64-apple-darwin from`,
    `https://github.com/denoland/deno/releases/tag/v${deno.version}) as Contents/Resources/deno. Deno is`,
    'MIT-licensed (LICENSE.md, next to this file). The Deno program also contains code by others. Deno',
    "publishes no list of it, so this file was generated by Mergelane's",
    'scripts/media-tools/deno-notices.mjs from the inputs pinned in scripts/media-tools/deno-notices.json.',
    '',
    'What it covers:',
    `1. Rust crates: every crates.io package in Deno's Cargo.lock at v${deno.version} (commit ${deno.commit}),`,
    "   each checked against Cargo.lock's SHA-256, with the licence, notice and copying files it publishes",
    '   (its own, and those of code it bundles). Cargo.lock lists the crates of every platform and of',
    "   Deno's own tests and tools, so the list is longer than what the macOS program contains.",
    `   Deno's own ${local} workspace crates are part of Deno and under its MIT licence.`,
    '2. V8 and the C and C++ libraries built into it, at the commits rusty_v8 pins for the v8 crate in',
    '   that Cargo.lock, and the JavaScript projects Deno carries (TypeScript, and Node.js code ported',
    "   into Deno's Node.js compatibility layer).",
    `3. The licence files in Deno's source, and the copyright notices in the comments of the ${scannedCount}`,
    '   JavaScript and TypeScript files Deno builds into the program.',
    '',
    'What it does not cover:',
    "- macOS's own libraries, which the program links to but which are not part of it.",
    '- Code whose authors gave no licence file or notice in any of the sources above.',
    missing.length === 0
      ? '- Every crate above has a licence text.'
      : `- ${missing.length} crate(s) publish no licence text, and no standard text is pinned for their licence:`,
    ...missing.map(
      (crate) => `    ${crate.name} ${crate.version} (${crate.license ?? 'no licence declared'})`
    ),
    '',
    'Each distinct licence text appears once, under LICENCE TEXTS at the end, labelled [T1], [T2], ...',
    'The lists say which texts apply to what.',
    '',
    RULE,
    `PART 1. RUST CRATES (${crates.length} from crates.io)`,
    RULE,
    ''
  )
  if (repository.length > 0) {
    push(
      `${repository.length} crate(s) publish no licence file of their own; their texts were taken from their`,
      'repository, at the commit the crate was published from, or where that commit is not in the',
      'repository, at the commit named next to the file (marked "from the repository").',
      ''
    )
  }
  if (standard.length > 0) {
    push(
      `${standard.length} crate(s) publish no licence file, and their repository has none at the recorded`,
      'commit (or they name no repository or commit). The standard text of each licence they declare is',
      'given (marked "standard text", from SPDX\'s license-list-data).',
      ''
    )
  }
  for (const crate of crates) {
    const how = {
      package: '',
      repository: ' (from the repository)',
      standard: ' (standard text)',
      missing: ''
    }[crate.source]
    push(`${crate.name} ${crate.version}`)
    push(
      `  licence: ${crate.license ?? (crate.licenseFile ? `see ${crate.licenseFile}` : 'not declared')}`
    )
    if (crate.repository) push(`  repository: ${crate.repository}`)
    push(
      crate.texts.length === 0
        ? '  texts: none published'
        : `  texts${how}: ${crate.texts.map((text) => `[${text.label}] ${text.path}`).join(', ')}`
    )
  }
  push(
    '',
    RULE,
    'PART 2. V8, THE LIBRARIES BUILT INTO IT, AND THE JAVASCRIPT PROJECTS DENO CARRIES',
    RULE,
    ''
  )
  for (const component of components) {
    push(
      component.name,
      `  licence: ${component.license}`,
      `  source: ${component.repository} at ${component.commit}`
    )
    push(`  texts: ${component.files.map((file) => `[${file.label}] ${file.path}`).join(', ')}`)
  }
  push('', RULE, "PART 3. LICENCE FILES AND NOTICES IN DENO'S OWN SOURCE", RULE, '')
  for (const file of sourceFiles) push(`${file.path}: [${file.label}]`)
  push('', `Notices in the comments of Deno's JavaScript and TypeScript (${headers.length}):`, '')
  headers.forEach((header, index) => {
    push(`Notice ${index + 1}, in ${header.files.length} file(s): ${header.files.join(', ')}`, '')
    push(...header.text.split('\n').map((line) => (line === '' ? '' : `    ${line}`)), '')
  })
  push(RULE, 'LICENCE TEXTS', RULE, '')
  for (const entry of store.entries()) {
    push(`[${entry.label}]`, '', entry.text, '', RULE, '')
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------

/** CLI entry point. Resolves to the exit code. */
export async function main(
  argv = process.argv.slice(2),
  { log = console.log, error = console.error, makeIo = realIo } = {}
) {
  let work = null
  try {
    let parsed
    try {
      parsed = parseArgs({
        args: argv,
        strict: true,
        options: {
          config: { type: 'string' },
          out: { type: 'string' },
          cache: { type: 'string' },
          jobs: { type: 'string' }
        }
      })
    } catch (failure) {
      error(`deno-notices: ${failure.message}\n${USAGE}`)
      return 2
    }
    const { values } = parsed
    const jobs = values.jobs === undefined ? 8 : Number(values.jobs)
    if (!Number.isInteger(jobs) || jobs < 1) {
      error(`deno-notices: --jobs must be a whole number of at least 1\n${USAGE}`)
      return 2
    }
    const configPath = resolve(values.config ?? DEFAULT_CONFIG)
    let config
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (failure) {
      throw new Error(`cannot read ${configPath}: ${failure.message}`)
    }
    work = await mkdtemp(join(tmpdir(), 'deno-notices-'))
    const cache = values.cache === undefined ? null : resolve(values.cache)
    const text = await generate(config, { io: makeIo(work), work, cache, jobs, log })
    const out = resolve(values.out ?? DEFAULT_OUT)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, text)
    log(
      `deno-notices: wrote ${relative(process.cwd(), out) || basename(out)} (${Buffer.byteLength(text)} bytes)`
    )
    return 0
  } catch (failure) {
    error(`deno-notices: ${failure.message}`)
    return 1
  } finally {
    if (work !== null) await rm(work, { recursive: true, force: true })
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
