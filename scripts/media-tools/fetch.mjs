// Fetches the media tools pinned in tools.json (yt-dlp, FFmpeg and Deno) for the app bundle.
// CLAUDE.md: they ship only as separate executables, fetched at build time with pinned SHA-256
// checksums and never committed. docs/MEDIA-TOOLS.md says which builds and why.
//
// usage: node scripts/media-tools/fetch.mjs [output-dir] [--manifest <tools.json>]
//
// output-dir defaults to app/resources/bin (gitignored). Each tool says how it is installed:
//
//   "install": "file"    one program, <output-dir>/<name> (Deno). It is skipped when that file
//                        already has the pinned hash. Otherwise the pinned URL is downloaded and its
//                        SHA-256 checked before anything is extracted or made executable; an archive
//                        is extracted with /usr/bin/ditto (zip) or /usr/bin/tar and the program in it
//                        checked against its own pinned SHA-256.
//   "install": "folder"  a program with the files it needs, <output-dir>/<name>/ (yt-dlp's unpacked
//                        build, ADR-0031). The archive is checked against its pinned SHA-256 and
//                        extracted as the folder; nothing in it may lead outside it. "links" names
//                        copies that the archive made of symlinks (a zip made without keeping
//                        links), each turned back into its link only when it is identical to what
//                        the link points to.
//   "install": "build"   a program built from source, <output-dir>/<name> (FFmpeg, ADR-0028). The
//                        pinned source tarball is downloaded and checked against sourceSha256 before
//                        anything else happens, then the build script next to this file runs with
//                        an argument list (no shell): <script> <tarball> <out-dir>, and must write
//                        <out-dir>/<name>.
//
// A folder or a build is skipped when its stamp (<output-dir>/.stamps/<name>.json) still matches:
// the pinned hashes, the build script's hash, and the hash of what is installed. In every case
// `lipo -archs` must list arm64, the licence texts are copied to <output-dir>/licenses/<name>/
// first, and the program is installed with mode 0755. Any failure exits 1 with a message and
// leaves no partial program behind.
// Needs macOS with the Xcode command line tools (/usr/bin/lipo, and clang and make for a build).
// Node.js built-ins only.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_MANIFEST = join(HERE, 'tools.json')
export const DEFAULT_OUT_DIR = resolve(HERE, '../../app/resources/bin')

/** Fields every tool needs, however it is installed. */
export const REQUIRED_FIELDS = [
  'name',
  'version',
  'install',
  'license',
  'licenseUrl',
  'licenseFiles',
  'sourceUrl'
]
export const INSTALL_KINDS = ['file', 'folder', 'build']
export const ARCHIVE_FORMATS = ['none', 'zip', 'tar']

/** The fields each kind of install needs, and the ones it may have, beyond REQUIRED_FIELDS. */
const INSTALL_REQUIRES = {
  file: ['url', 'sha256', 'archive'],
  folder: ['url', 'sha256', 'archive', 'executable'],
  build: ['sourceSha256', 'buildScript']
}
const INSTALL_ALLOWS = {
  file: ['url', 'sha256', 'archive', 'archivePath', 'binarySha256'],
  folder: ['url', 'sha256', 'archive', 'executable', 'links'],
  build: ['buildScript']
}
const INSTALL_FIELDS = [...new Set(Object.values(INSTALL_ALLOWS).flat())]

const SHA256 = /^[0-9a-f]{64}$/
// Doubles as the installed file name, so no path separators.
const NAME = /^[a-z0-9][a-z0-9._-]*$/
// A file next to the manifest, as sources.mjs requires of buildScript too.
const PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// A generic client name: nothing about the user or the project goes to the download servers.
const USER_AGENT = 'media-tools-fetch (Node.js)'
/** Bytes of a failed build's output kept for the error message. */
const BUILD_OUTPUT_KEEP = 8 * 1024
const BUILD_OUTPUT_LINES = 20

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

const isMissing = (value) => value === undefined || value === null || value === ''

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
      if (isMissing(tool[field])) add(`missing "${field}"`)
    }
    if (tool.name !== undefined) {
      if (typeof tool.name !== 'string' || !NAME.test(tool.name)) {
        add('"name" must be lowercase letters, digits, ".", "_" or "-"')
      } else if (names.has(tool.name)) {
        add('the name is used twice')
      }
      names.add(tool.name)
    }

    const kind = INSTALL_KINDS.includes(tool.install) ? tool.install : null
    if (tool.install !== undefined && kind === null) {
      add(`"install" must be one of: ${INSTALL_KINDS.join(', ')}`)
    }
    if (kind !== null) {
      for (const field of INSTALL_REQUIRES[kind]) {
        if (isMissing(tool[field])) add(`missing "${field}" (needed when "install" is "${kind}")`)
      }
      for (const field of INSTALL_FIELDS) {
        if (tool[field] !== undefined && !INSTALL_ALLOWS[kind].includes(field)) {
          add(`"${field}" is not used when "install" is "${kind}"`)
        }
      }
    }

    for (const field of ['sha256', 'binarySha256', 'sourceSha256']) {
      if (tool[field] !== undefined && !SHA256.test(tool[field])) {
        add(`"${field}" must be 64 lowercase hex characters`)
      }
    }
    for (const field of ['url', 'sourceUrl']) {
      if (isMissing(tool[field])) continue
      const problem = urlProblem(tool[field])
      if (problem) add(problem)
    }
    if (tool.archive !== undefined && !ARCHIVE_FORMATS.includes(tool.archive)) {
      add(`"archive" must be one of: ${ARCHIVE_FORMATS.join(', ')}`)
    }
    if (kind === 'file' && (tool.archive === 'zip' || tool.archive === 'tar')) {
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
    if (kind === 'folder') {
      if (tool.archive === 'none') add('"archive" must be zip or tar when "install" is "folder"')
      if (tool.executable !== undefined && !isContainedPath(tool.executable)) {
        add('"executable" must be a relative path inside the folder')
      }
      if (tool.links !== undefined) {
        const links = tool.links
        if (links === null || typeof links !== 'object' || Array.isArray(links)) {
          add('"links" must map paths in the folder to the link targets they should be')
        } else {
          for (const [path, target] of Object.entries(links)) {
            const stays =
              isContainedPath(path) &&
              typeof target === 'string' &&
              !isAbsolute(target) &&
              isContainedPath(join(dirname(path), target))
            if (!stays) {
              add(
                `link ${JSON.stringify(path)} -> ${JSON.stringify(target)} must stay in the folder`
              )
            }
          }
        }
      }
    }
    if (tool.buildScript !== undefined && !PLAIN_FILE.test(String(tool.buildScript))) {
      add('"buildScript" must be the name of a file next to the manifest')
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

/** True when `real` (a real path) is `root` itself or inside it. */
function isInside(root, real) {
  const inside = relative(root, real)
  return !(inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside))
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
  const realRoot = await realpath(root)
  if (real === realRoot || !isInside(realRoot, real)) {
    throw new Error(`${name}: "${path}" leads outside the archive`)
  }
  if (!(await lstat(real)).isFile()) throw new Error(`${name}: "${path}" is not a file`)
  return real
}

/**
 * Checks that everything under root is a folder, a regular file, or a symlink to something inside
 * root, so the folder can be copied into the app without reaching anything else.
 */
async function checkTree(root, name) {
  const realRoot = await realpath(root)
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const shown = relative(root, path)
      if (entry.isSymbolicLink()) {
        let real = null
        try {
          real = await realpath(path)
        } catch {
          // A link to nothing: refused below, like one that leads out.
        }
        if (real === null || !isInside(realRoot, real)) {
          throw new Error(`${name}: "${shown}" leads outside the archive`)
        }
      } else if (entry.isDirectory()) {
        await walk(path)
      } else if (!entry.isFile()) {
        throw new Error(`${name}: "${shown}" is not a file or a folder`)
      }
    }
  }
  await walk(root)
}

/**
 * A SHA-256 over a folder: every entry's path, type and permissions, each file's SHA-256 and each
 * symlink's target, in a fixed order. Null when path is not a folder.
 */
export async function treeHash(path) {
  try {
    if (!(await lstat(path)).isDirectory()) return null
  } catch {
    return null
  }
  const lines = []
  const walk = async (dir) => {
    const entries = (await readdir(dir)).sort()
    for (const entry of entries) {
      const full = join(dir, entry)
      const shown = relative(path, full)
      const info = await lstat(full)
      const perms = (info.mode & 0o777).toString(8)
      if (info.isSymbolicLink()) lines.push(`link ${shown} -> ${await readlink(full)}`)
      else if (info.isDirectory()) {
        lines.push(`dir ${perms} ${shown}`)
        await walk(full)
      } else lines.push(`file ${perms} ${await sha256File(full)} ${shown}`)
    }
  }
  await walk(path)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/**
 * Turns copies back into the symlinks they were made from: for each [path, target] in order, the
 * file or folder at path must be identical to what target points to (a link relative to path's
 * folder, as in the archive it came from), and is replaced by the link. A path that already is
 * that link is left as it is.
 */
async function restoreLinks(root, links, name) {
  for (const [path, target] of Object.entries(links)) {
    const full = join(root, path)
    const pointsTo = resolve(dirname(full), target)
    let info
    try {
      info = await lstat(full)
    } catch {
      throw new Error(`${name}: "${path}" is not in the archive, so it can't be made a link`)
    }
    if (info.isSymbolicLink() && (await readlink(full)) === target) continue
    const hashOf = info.isDirectory() ? treeHash : installedHash
    const copy = info.isDirectory() || info.isFile() ? await hashOf(full) : null
    if (copy === null || copy !== (await hashOf(pointsTo))) {
      throw new Error(
        `${name}: "${path}" is not a copy of "${target}", so it can't be made a link to it`
      )
    }
    await rm(full, { recursive: true })
    await symlink(target, full)
  }
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

/** Puts exactly the tool's licence texts in <outDir>/licenses/<name>/: texts an older pin listed
 * (FFmpeg's GPL text, say) must not ship with a program they no longer describe. */
async function copyLicenses(tool, manifestDir, outDir) {
  const dir = join(outDir, 'licenses', tool.name)
  await rm(dir, { recursive: true, force: true })
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

/** Where a folder's or a build's stamp is kept. electron-builder copies only the named tools. */
export function stampPath(outDir, name) {
  return join(outDir, '.stamps', `${name}.json`)
}

/** The stamp's contents, or null when there is none or it can't be read. */
async function readStamp(path) {
  try {
    const stamp = JSON.parse(await readFile(path, 'utf8'))
    return stamp !== null && typeof stamp === 'object' ? stamp : null
  } catch {
    return null
  }
}

/** Writes the stamp through a file in work, renamed into place. */
async function writeStamp(outDir, work, name, stamp) {
  const path = stampPath(outDir, name)
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(work, 'stamp.json')
  await writeFile(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`

/** Downloads a pinned file into work and checks it against its hash; nothing else happens first. */
async function downloadPinned(tool, url, expected, dest, log, network) {
  log(`${tool.name} ${tool.version}: downloading ${url}`)
  const { sha256, bytes } = await download(url, dest, network)
  if (sha256 !== expected) {
    throw new Error(
      `${tool.name}: SHA-256 mismatch for ${url}\n` +
        `  expected ${expected}\n  received ${sha256}\n` +
        'The download was deleted. If upstream re-published it, verify the new file and update tools.json.'
    )
  }
  return bytes
}

async function requireArm64(tool, path) {
  const archs = await archsOf(path)
  if (!archs.includes('arm64')) {
    throw new Error(
      `${tool.name}: not built for Apple silicon: lipo -archs reports "${archs.join(' ')}", expected arm64`
    )
  }
  return archs
}

/** Runs a mkdtemp'd work folder inside outDir (so renames stay on one filesystem), then removes it. */
async function inWorkDir(outDir, name, task) {
  const work = await mkdtemp(join(outDir, `.fetch-${name}-`))
  try {
    return await task(work)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** "install": "file": one program, from a download or from inside an archive. */
async function installFile(tool, { outDir, manifestDir, log, ...network }) {
  const dest = join(outDir, tool.name)
  const expected = tool.archive === 'none' ? tool.sha256 : tool.binarySha256
  if ((await installedHash(dest)) === expected) {
    await chmod(dest, 0o755)
    await copyLicenses(tool, manifestDir, outDir)
    log(`${tool.name} ${tool.version}: already installed with the pinned hash`)
    return 'up-to-date'
  }

  return inWorkDir(outDir, tool.name, async (work) => {
    const downloaded = join(work, 'download')
    const bytes = await downloadPinned(tool, tool.url, tool.sha256, downloaded, log, network)

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

    const archs = await requireArm64(tool, binary)
    // Licences first: if one is missing, no executable is installed without its licence.
    await copyLicenses(tool, manifestDir, outDir)
    await chmod(binary, 0o755)
    await rename(binary, dest)
    log(
      `${tool.name} ${tool.version}: installed ${dest} (${megabytes(bytes)} downloaded; ${archs.join(', ')})`
    )
    return 'installed'
  })
}

/** "install": "folder": an archive whose contents become <outDir>/<name>/. */
async function installFolder(tool, { outDir, manifestDir, log, ...network }) {
  const dest = join(outDir, tool.name)
  const stampFile = stampPath(outDir, tool.name)
  const stamp = await readStamp(stampFile)
  // What the folder is made from: the archive, and what is done to it.
  const recipe = { sha256: tool.sha256, executable: tool.executable, links: tool.links ?? {} }
  if (
    stamp !== null &&
    JSON.stringify(recipe) ===
      JSON.stringify({ sha256: stamp.sha256, executable: stamp.executable, links: stamp.links }) &&
    typeof stamp.treeSha256 === 'string' &&
    stamp.treeSha256 === (await treeHash(dest))
  ) {
    await copyLicenses(tool, manifestDir, outDir)
    log(`${tool.name} ${tool.version}: already installed from the pinned archive`)
    return 'up-to-date'
  }

  return inWorkDir(outDir, tool.name, async (work) => {
    const downloaded = join(work, 'download')
    const bytes = await downloadPinned(tool, tool.url, tool.sha256, downloaded, log, network)
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked)
    await extract(downloaded, tool.archive, unpacked)
    await checkTree(unpacked, tool.name)
    if (tool.links !== undefined) {
      await restoreLinks(unpacked, tool.links, tool.name)
      await checkTree(unpacked, tool.name)
    }
    const program = await fileInside(unpacked, tool.executable, tool.name)
    const archs = await requireArm64(tool, program)
    await chmod(program, 0o755)
    const tree = await treeHash(unpacked)

    await copyLicenses(tool, manifestDir, outDir)
    await rm(stampFile, { force: true })
    // Whatever was there before (an older folder, or the single-file program of an older pin).
    await rm(dest, { recursive: true, force: true })
    await rename(unpacked, dest)
    await writeStamp(outDir, work, tool.name, {
      name: tool.name,
      version: tool.version,
      ...recipe,
      treeSha256: tree
    })
    log(
      `${tool.name} ${tool.version}: installed ${dest}/ (${megabytes(bytes)} downloaded; ${tool.executable}: ${archs.join(', ')})`
    )
    return 'installed'
  })
}

/** Lines of text at the end of output, for an error message. */
function lastLines(text) {
  return text.trimEnd().split('\n').slice(-BUILD_OUTPUT_LINES).join('\n')
}

/**
 * Runs the build script as `/bin/bash <script> <args...>`: an argument list, never a command line
 * for a shell to parse. Its temporary files go in tempDir. Rejects on a non-zero exit with the end
 * of its output; `onOutput` sees all of it as it comes.
 */
function runBuildScript(script, args, { tempDir, onOutput }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tempDir }
    })
    let tail = ''
    const take = (chunk) => {
      onOutput?.(chunk)
      tail = (tail + chunk.toString()).slice(-BUILD_OUTPUT_KEEP)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) return resolvePromise()
      const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`
      reject(new Error(`${basename(script)} ${how}:\n${lastLines(tail)}`))
    })
  })
}

/** "install": "build": the pinned source tarball, built by the build script next to the manifest. */
async function installBuild(tool, { outDir, manifestDir, log, onBuildOutput, ...network }) {
  const dest = join(outDir, tool.name)
  const script = join(manifestDir, tool.buildScript)
  let scriptSha256
  try {
    scriptSha256 = await sha256File(script)
  } catch (error) {
    throw new Error(`${tool.name}: cannot read the build script ${script}: ${error.message}`)
  }
  const stampFile = stampPath(outDir, tool.name)
  const stamp = await readStamp(stampFile)
  if (
    stamp?.sourceSha256 === tool.sourceSha256 &&
    stamp.buildScriptSha256 === scriptSha256 &&
    typeof stamp.binarySha256 === 'string' &&
    (await installedHash(dest)) === stamp.binarySha256
  ) {
    await chmod(dest, 0o755)
    await copyLicenses(tool, manifestDir, outDir)
    log(`${tool.name} ${tool.version}: already built from the pinned source with this build script`)
    return 'up-to-date'
  }

  return inWorkDir(outDir, tool.name, async (work) => {
    const tarball = join(work, basename(new URL(tool.sourceUrl).pathname) || 'source')
    await downloadPinned(tool, tool.sourceUrl, tool.sourceSha256, tarball, log, network)

    const built = join(work, 'built')
    // The build's own scratch space (its TMPDIR), in the system's temporary folder rather than in
    // outDir, whose path may have spaces. Removed whatever happens, with anything a stopped build
    // left in it.
    const tempDir = await mkdtemp(join(tmpdir(), `mergelane-build-${tool.name}-`))
    try {
      log(`${tool.name} ${tool.version}: building with ${tool.buildScript}`)
      await runBuildScript(script, [tarball, built], { tempDir, onOutput: onBuildOutput })
    } catch (error) {
      throw new Error(`${tool.name}: the build failed: ${error.message}`)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }

    const program = join(built, tool.name)
    if ((await installedHash(program)) === null) {
      throw new Error(`${tool.name}: ${tool.buildScript} finished but did not write ${tool.name}`)
    }
    const archs = await requireArm64(tool, program)
    const binarySha256 = await sha256File(program)

    await copyLicenses(tool, manifestDir, outDir)
    await rm(stampFile, { force: true })
    await chmod(program, 0o755)
    await rename(program, dest)
    await writeStamp(outDir, work, tool.name, {
      name: tool.name,
      version: tool.version,
      sourceSha256: tool.sourceSha256,
      buildScriptSha256: scriptSha256,
      binarySha256
    })
    log(
      `${tool.name} ${tool.version}: built ${dest} (${archs.join(', ')}; SHA-256 ${binarySha256})`
    )
    return 'built'
  })
}

const INSTALLERS = { file: installFile, folder: installFolder, build: installBuild }

/**
 * Fetches, verifies and installs one tool. Returns 'installed', 'built' or 'up-to-date'.
 * Nothing is made executable until every check has passed.
 */
export async function fetchTool(tool, { outDir, manifestDir, log = () => {}, ...rest }) {
  await mkdir(outDir, { recursive: true })
  if (!Object.hasOwn(INSTALLERS, tool.install)) {
    throw new Error(`${tool.name}: unknown install kind ${JSON.stringify(tool.install)}`)
  }
  return INSTALLERS[tool.install](tool, { outDir, manifestDir, log, ...rest })
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

/** CLI entry point. Returns the exit code. A build's output goes to `buildOutput` as it comes. */
export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    error = console.error,
    buildOutput = (chunk) => process.stdout.write(chunk)
  } = {}
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
    await fetchAll(manifest, {
      outDir,
      manifestDir: dirname(manifestPath),
      log,
      onBuildOutput: buildOutput
    })
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
