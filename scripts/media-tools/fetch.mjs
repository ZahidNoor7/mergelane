// Fetches the media tools pinned in tools.json (yt-dlp and FFmpeg) for the app bundle.
// CLAUDE.md: they ship only as separate executables, fetched at build time with pinned SHA-256
// checksums and never committed. docs/MEDIA-TOOLS.md says which builds and why.
//
// usage: node scripts/media-tools/fetch.mjs [output-dir] [--manifest <tools.json>]
//
// output-dir defaults to app/resources/bin (gitignored). For each tool this:
//   1. skips it when <output-dir>/<name> already has the pinned hash (only licences are refreshed);
//   2. downloads the pinned URL, following redirects (https only; plain http only for loopback);
//   3. checks the download's SHA-256 before anything is extracted or made executable;
//   4. extracts archives with /usr/bin/ditto (zip) or /usr/bin/tar, and checks the extracted
//      executable's own SHA-256;
//   5. checks that `lipo -archs` lists arm64;
//   6. installs it as <output-dir>/<name> with mode 0755 and copies its licence texts to
//      <output-dir>/licenses/<name>/.
// Any failure exits 1 with a message and leaves no partial executable behind.
// Needs macOS with the Xcode command line tools (/usr/bin/lipo). Node.js built-ins only.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_MANIFEST = join(HERE, 'tools.json')
export const DEFAULT_OUT_DIR = resolve(HERE, '../../app/resources/bin')

/** Fields every tool needs. Archives also need archivePath and binarySha256. */
export const REQUIRED_FIELDS = [
  'name',
  'version',
  'url',
  'sha256',
  'archive',
  'license',
  'licenseUrl',
  'licenseFiles',
  'sourceUrl'
]
export const ARCHIVE_FORMATS = ['none', 'zip', 'tar']

const SHA256 = /^[0-9a-f]{64}$/
// Doubles as the installed file name, so no path separators.
const NAME = /^[a-z0-9][a-z0-9._-]*$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// A generic client name: nothing about the user or the project goes to the download servers.
const USER_AGENT = 'media-tools-fetch (Node.js)'

/** Returns a problem with the URL, or null when it may be downloaded from. */
export function urlProblem(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return `not a valid URL: ${JSON.stringify(url)}`
  }
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return null
  return `only https URLs are allowed: ${url}`
}

/** True for a relative path that stays inside its base directory. */
function isContainedPath(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return false
  const normal = normalize(path)
  return normal !== '.' && normal !== '..' && !normal.startsWith(`..${sep}`)
}

/** Returns a list of problems; empty means the manifest can be used. */
export function validateManifest(manifest) {
  const tools = manifest?.tools
  if (!Array.isArray(tools) || tools.length === 0) return ['the manifest has no "tools" list']
  const problems = []
  const names = new Set()
  tools.forEach((tool, index) => {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
      problems.push(`tools[${index}] is not an object`)
      return
    }
    const label = typeof tool.name === 'string' && tool.name ? tool.name : `tools[${index}]`
    const add = (problem) => problems.push(`${label}: ${problem}`)
    for (const field of REQUIRED_FIELDS) {
      if (tool[field] === undefined || tool[field] === null || tool[field] === '') {
        add(`missing "${field}"`)
      }
    }
    if (tool.name !== undefined) {
      if (typeof tool.name !== 'string' || !NAME.test(tool.name)) {
        add('"name" must be lowercase letters, digits, ".", "_" or "-"')
      } else if (names.has(tool.name)) {
        add('the name is used twice')
      }
      names.add(tool.name)
    }
    for (const field of ['sha256', 'binarySha256']) {
      if (tool[field] !== undefined && !SHA256.test(tool[field])) {
        add(`"${field}" must be 64 lowercase hex characters`)
      }
    }
    if (tool.url) {
      const problem = urlProblem(tool.url)
      if (problem) add(problem)
    }
    if (tool.archive !== undefined && !ARCHIVE_FORMATS.includes(tool.archive)) {
      add(`"archive" must be one of: ${ARCHIVE_FORMATS.join(', ')}`)
    }
    if (tool.archive === 'zip' || tool.archive === 'tar') {
      if (tool.archivePath === undefined) {
        add(`missing "archivePath" (the executable's path inside the ${tool.archive} archive)`)
      } else if (!isContainedPath(tool.archivePath)) {
        add('"archivePath" must be a relative path inside the archive')
      }
      if (tool.binarySha256 === undefined) {
        add('missing "binarySha256" (the SHA-256 of the extracted executable)')
      }
    }
    if (tool.archive === 'none' && tool.binarySha256 && tool.binarySha256 !== tool.sha256) {
      add('"binarySha256" must equal "sha256" when there is no archive')
    }
    if (tool.licenseFiles !== undefined) {
      if (!Array.isArray(tool.licenseFiles) || tool.licenseFiles.length === 0) {
        add('"licenseFiles" must be a non-empty list')
      } else {
        for (const file of tool.licenseFiles) {
          if (!isContainedPath(file)) {
            add(`licence file ${JSON.stringify(file)} must be a path relative to the manifest`)
          }
        }
      }
    }
  })
  return problems
}

/** Reads and validates a manifest, throwing one error that lists every problem. */
export async function loadManifest(path) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the manifest ${path}: ${error.message}`)
  }
  const problems = validateManifest(manifest)
  if (problems.length > 0) {
    throw new Error(`invalid manifest ${path}:\n  - ${problems.join('\n  - ')}`)
  }
  return manifest
}

function get(url, timeoutMs) {
  const client = new URL(url).protocol === 'https:' ? https : http
  return new Promise((resolvePromise, reject) => {
    const request = client.get(
      url,
      { headers: { 'user-agent': USER_AGENT }, timeout: timeoutMs },
      resolvePromise
    )
    // 'timeout' only reports an idle socket; the request has to be destroyed by hand (Node docs).
    request.on('timeout', () => {
      request.destroy(new Error(`no data from ${url} for ${timeoutMs / 1000}s`))
    })
    request.on('error', reject)
  })
}

/**
 * Downloads url to dest (created with mode 0600, never executable), following redirects.
 * Returns the SHA-256 of what was written, the byte count and the final URL.
 */
export async function download(url, dest, { maxRedirects = 10, timeoutMs = 60_000 } = {}) {
  let current = url
  for (let redirects = 0; ; redirects++) {
    const problem = urlProblem(current)
    if (problem) throw new Error(problem)
    const response = await get(current, timeoutMs)
    const { statusCode, headers } = response
    if (REDIRECT_STATUSES.has(statusCode)) {
      response.resume()
      if (!headers.location)
        throw new Error(`HTTP ${statusCode} without a Location from ${current}`)
      if (redirects >= maxRedirects)
        throw new Error(`more than ${maxRedirects} redirects from ${url}`)
      current = new URL(headers.location, current).href
      continue
    }
    if (statusCode !== 200) {
      response.resume()
      throw new Error(`HTTP ${statusCode} from ${current}`)
    }
    const hash = createHash('sha256')
    let bytes = 0
    await pipeline(
      response,
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk)
          bytes += chunk.length
          yield chunk
        }
      },
      createWriteStream(dest, { flags: 'wx', mode: 0o600 })
    )
    return { sha256: hash.digest('hex'), bytes, url: current }
  }
}

/** SHA-256 of a file, as lowercase hex. */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** The architectures `lipo -archs` reports for a Mach-O file. */
export async function archsOf(path) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/lipo', ['-archs', path])
    return stdout.trim().split(/\s+/)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        '/usr/bin/lipo is missing: run this on macOS with the Xcode command line tools'
      )
    }
    throw new Error(
      `lipo cannot read ${path}, so it is not a Mach-O executable (${error.stderr?.trim()})`
    )
  }
}

/** Extracts a verified archive into an empty directory with the macOS tools. */
export async function extract(archive, format, dir) {
  if (format === 'zip') {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', archive, dir])
  } else if (format === 'tar') {
    // bsdtar detects gzip/bzip2/xz itself, and refuses ".." and absolute paths by default.
    await execFileAsync('/usr/bin/tar', ['-x', '-f', archive, '-C', dir])
  } else {
    throw new Error(`unknown archive format: ${format}`)
  }
}

/** Resolves path inside root, refusing anything that leads out of it or is not a plain file. */
async function fileInside(root, path, name) {
  const candidate = resolve(root, path)
  let real
  try {
    real = await realpath(candidate)
  } catch {
    throw new Error(`${name}: "${path}" is not in the archive`)
  }
  const inside = relative(await realpath(root), real)
  if (inside === '' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`${name}: "${path}" leads outside the archive`)
  }
  if (!(await lstat(real)).isFile()) throw new Error(`${name}: "${path}" is not a file`)
  return real
}

/** Hash of path when it is a regular file, otherwise null. */
async function installedHash(path) {
  try {
    if (!(await lstat(path)).isFile()) return null
  } catch {
    return null
  }
  return sha256File(path)
}

async function copyLicenses(tool, manifestDir, outDir) {
  const dir = join(outDir, 'licenses', tool.name)
  await mkdir(dir, { recursive: true })
  for (const file of tool.licenseFiles) {
    const dest = join(dir, basename(file))
    try {
      await copyFile(join(manifestDir, file), dest)
    } catch (error) {
      throw new Error(`${tool.name}: cannot copy licence file ${file}: ${error.message}`)
    }
    await chmod(dest, 0o644)
  }
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * Fetches, verifies and installs one tool. Returns 'installed' or 'up-to-date'.
 * Nothing is made executable until every check has passed.
 */
export async function fetchTool(tool, { outDir, manifestDir, log = () => {}, ...network }) {
  const dest = join(outDir, tool.name)
  const expected = tool.archive === 'none' ? tool.sha256 : tool.binarySha256
  await mkdir(outDir, { recursive: true })

  if ((await installedHash(dest)) === expected) {
    await chmod(dest, 0o755)
    await copyLicenses(tool, manifestDir, outDir)
    log(`${tool.name} ${tool.version}: already installed with the pinned hash`)
    return 'up-to-date'
  }

  // Work inside outDir so the final rename stays on one filesystem; removed whatever happens.
  const work = await mkdtemp(join(outDir, `.fetch-${tool.name}-`))
  try {
    const downloaded = join(work, 'download')
    log(`${tool.name} ${tool.version}: downloading ${tool.url}`)
    const { sha256, bytes } = await download(tool.url, downloaded, network)
    if (sha256 !== tool.sha256) {
      throw new Error(
        `${tool.name}: SHA-256 mismatch for ${tool.url}\n` +
          `  expected ${tool.sha256}\n  received ${sha256}\n` +
          'The download was deleted. If upstream re-published it, verify the new file and update tools.json.'
      )
    }

    let binary = downloaded
    if (tool.archive !== 'none') {
      const unpacked = join(work, 'unpacked')
      await mkdir(unpacked)
      await extract(downloaded, tool.archive, unpacked)
      binary = await fileInside(unpacked, tool.archivePath, tool.name)
      const binaryHash = await sha256File(binary)
      if (binaryHash !== tool.binarySha256) {
        throw new Error(
          `${tool.name}: SHA-256 mismatch for ${tool.archivePath} in the archive\n` +
            `  expected ${tool.binarySha256}\n  received ${binaryHash}`
        )
      }
    }

    const archs = await archsOf(binary)
    if (!archs.includes('arm64')) {
      throw new Error(
        `${tool.name}: not built for Apple silicon: lipo -archs reports "${archs.join(' ')}", expected arm64`
      )
    }

    // Licences first: if one is missing, no executable is installed without its licence.
    await copyLicenses(tool, manifestDir, outDir)
    await chmod(binary, 0o755)
    await rename(binary, dest)
    log(
      `${tool.name} ${tool.version}: installed ${dest} (${megabytes(bytes)} downloaded; ${archs.join(', ')})`
    )
    return 'installed'
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Fetches every tool in a manifest, validating the whole manifest before any download. */
export async function fetchAll(manifest, options) {
  const problems = validateManifest(manifest)
  if (problems.length > 0) throw new Error(`invalid manifest:\n  - ${problems.join('\n  - ')}`)
  const results = {}
  for (const tool of manifest.tools) {
    results[tool.name] = await fetchTool(tool, options)
  }
  return results
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
    if (positionals.length > 1)
      throw new Error(`expected one output directory, got ${positionals.length}`)
    const manifestPath = resolve(values.manifest ?? DEFAULT_MANIFEST)
    const outDir = resolve(positionals[0] ?? DEFAULT_OUT_DIR)
    const manifest = await loadManifest(manifestPath)
    await fetchAll(manifest, { outDir, manifestDir: dirname(manifestPath), log })
    log(`media tools ready in ${outDir}`)
    return 0
  } catch (failure) {
    error(`fetch-media-tools: ${failure.message}`)
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
