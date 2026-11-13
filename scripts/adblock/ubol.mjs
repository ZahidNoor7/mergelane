// uBO Lite inside Mergelane's browser extension (ADR-0063). One extension does both jobs: sending
// downloads to Mergelane, and blocking ads and trackers with uBO Lite (GPL-3.0-or-later, by Raymond
// Hill and contributors).
//
// uBO Lite's official release builds, pinned in ubol.json by version and SHA-256, are fetched at build
// time, checked, and unpacked into a cache (app/extension/.cache, gitignored). extension/build.mjs then
// copies one into each browser's folder, applies the few changes in PATCHES, puts Mergelane's own files
// on top and writes one manifest from both (mergeManifest). Nothing of uBO Lite is committed, and the
// extension never fetches filter lists itself: the lists are the ones compiled into the pinned build.
//
// Its files stay where uBO Lite puts them (js/, rulesets/, css/, ...): they refer to each other by
// absolute paths such as /js/scripting/css-api.js. Mergelane's own files (background.js, popup.html,
// options.html, ui.css, icons/, fonts/) don't clash with any of them; uBO Lite's popup.html is the
// only one left out, for Mergelane's popup, which shows uBO Lite's per-site switch itself.
//
// Node.js built-ins only, plus the download helpers the media tools use.
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadWithRetries, extract, sha256File, urlProblem } from '../media-tools/fetch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PIN = join(HERE, 'ubol.json')
export const DEFAULT_CACHE = resolve(HERE, '../../app/extension/.cache/ubol')
export const BROWSERS = ['chrome', 'firefox']

const SHA256 = /^[0-9a-f]{64}$/
const VERSION = /^[0-9]+(\.[0-9]+)*$/

/** Problems with ubol.json; empty when there are none. */
export function pinProblems(pin) {
  const tool = Array.isArray(pin?.tools) && pin.tools.length === 1 ? pin.tools[0] : null
  if (!tool) return ['ubol.json must list exactly one tool']
  const problems = []
  if (!VERSION.test(String(tool.version ?? ''))) problems.push('version must be dotted numbers')
  for (const browser of BROWSERS) {
    const build = tool.builds?.[browser]
    if (!build) {
      problems.push(`no ${browser} build`)
      continue
    }
    if (typeof build.url !== 'string' || urlProblem(build.url)) {
      problems.push(`${browser}: url must be an https URL`)
    }
    if (!SHA256.test(String(build.sha256 ?? ''))) {
      problems.push(`${browser}: sha256 must be 64 lowercase hex characters`)
    }
  }
  return problems
}

/** The pinned uBO Lite from ubol.json, checked. */
export async function loadPin(path = DEFAULT_PIN) {
  const pin = JSON.parse(await readFile(path, 'utf-8'))
  const problems = pinProblems(pin)
  if (problems.length > 0) throw new Error(`${path}:\n  - ${problems.join('\n  - ')}`)
  return pin.tools[0]
}

/**
 * Refuses anything in an unpacked build but folders and regular files: no links, so copying it into
 * the extension can't reach outside it.
 */
export async function checkTree(root) {
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (!entry.isFile()) {
        throw new Error(`uBO Lite: "${relative(root, path)}" is not a file or a folder`)
      }
    }
  }
  await walk(root)
}

/**
 * The unpacked build for one browser: <cacheDir>/<version>/<browser>. Downloaded, checked against its
 * pinned SHA-256 and unpacked only when the cache doesn't already hold it (its stamp names the hash).
 * Any failure leaves nothing half-made behind.
 */
export async function fetchBuild(
  tool,
  browser,
  { cacheDir = DEFAULT_CACHE, download = downloadWithRetries, log = () => {} } = {}
) {
  const build = tool.builds[browser]
  if (!build) throw new Error(`uBO Lite: no ${browser} build pinned`)
  const base = join(cacheDir, tool.version)
  const dir = join(base, browser)
  const stamp = join(base, `${browser}.sha256`)
  if (existsSync(dir) && existsSync(stamp)) {
    if ((await readFile(stamp, 'utf-8')).trim() === build.sha256) return dir
  }
  await mkdir(base, { recursive: true })
  const archive = join(base, `${browser}.zip.part`)
  const unpacked = `${dir}.part`
  await rm(archive, { force: true })
  await rm(unpacked, { recursive: true, force: true })
  try {
    log(`uBO Lite ${tool.version} for ${browser}: downloading ${build.url}`)
    await download(build.url, archive, { log })
    const sha256 = await sha256File(archive)
    if (sha256 !== build.sha256) {
      throw new Error(`uBO Lite ${browser}: SHA-256 is ${sha256}, expected ${build.sha256}`)
    }
    await mkdir(unpacked)
    await extract(archive, 'zip', unpacked)
    await checkTree(unpacked)
    await rm(dir, { recursive: true, force: true })
    await rename(unpacked, dir)
    await writeFile(stamp, `${build.sha256}\n`)
    return dir
  } catch (failure) {
    await rm(unpacked, { recursive: true, force: true })
    throw failure
  } finally {
    await rm(archive, { force: true })
  }
}

/** Top-level entries of a build that Mergelane doesn't ship: its own manifest and popup replace
 * them, and Mozilla's signature and listing files belong to uBO Lite's own add-on. */
export const LEFT_OUT = new Set([
  'manifest.json',
  'popup.html',
  'META-INF',
  'mozilla-recommendation.json',
  'README.md'
])

/** Copies an unpacked build into an extension folder, without LEFT_OUT. */
export async function copyBuild(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    if (LEFT_OUT.has(entry)) continue
    await cp(join(from, entry), join(to, entry), { recursive: true })
  }
}

/**
 * Mergelane's changes to uBO Lite's files. Each `find` must occur exactly once, so an update of the
 * pinned build that moves one of them stops the build instead of shipping it unchanged.
 */
export const PATCHES = [
  {
    file: 'js/config.js',
    find: '    showBlockedCount: true,\n',
    replace: '    showBlockedCount: false,\n',
    why: 'The toolbar badge keeps showing how many videos the page has (mediaWatch.ts); counting blocked requests there instead stays a choice in the ad-blocking settings.'
  },
  {
    file: 'js/action.js',
    find: 'export function toggleToolbarIcon(tabId) {\n',
    replace:
      'export function toggleToolbarIcon(tabId) {\n' +
      '    // Mergelane (ADR-0063): the toolbar icon says whether downloads go to Mergelane, so a\n' +
      "    // site where ads aren't blocked doesn't grey it. The popup says so instead.\n" +
      '    return;\n',
    why: "Mergelane's toolbar icon greys only when downloads stay in the browser."
  },
  {
    file: 'dashboard.html',
    find: 'alt="uBO Lite"',
    replace: 'alt="Mergelane"',
    why: "The settings page shows Mergelane's mark (img/ublock.svg is replaced by it)."
  }
]

/** `text` with one patch applied; throws unless its `find` occurs exactly once. */
export function patchText(text, patch) {
  const count = text.split(patch.find).length - 1
  if (count !== 1) {
    throw new Error(
      `uBO Lite patch for ${patch.file}: expected the text once, found it ${count} times`
    )
  }
  return text.replace(patch.find, () => patch.replace)
}

export async function applyPatches(dir, patches = PATCHES) {
  for (const patch of patches) {
    const path = join(dir, patch.file)
    await writeFile(path, patchText(await readFile(path, 'utf-8'), patch))
  }
}

/**
 * uBO Lite's pages name it in their words ("uBO Lite has prevented the following page from
 * loading", the window title): inside Mergelane's extension they say Mergelane, in every language.
 * Its credits (the About pane's links to uBlock and its contributors) are left as they are.
 */
export async function brandLocales(dir, name = 'Mergelane') {
  const locales = join(dir, '_locales')
  for (const locale of await readdir(locales)) {
    const path = join(locales, locale, 'messages.json')
    if (!existsSync(path)) continue
    const messages = JSON.parse(await readFile(path, 'utf-8'))
    for (const entry of Object.values(messages)) {
      if (typeof entry?.message === 'string') {
        entry.message = entry.message.replaceAll('uBO Lite', name)
      }
    }
    if (messages.extName) messages.extName.message = name
    await writeFile(path, `${JSON.stringify(messages, null, 2)}\n`)
  }
}

/** Mergelane's marks over uBO Lite's: its toolbar and page icons, and the settings page's logo. */
export async function brandImages(dir, { icons, mark }) {
  const sizes = {
    16: 'icon-16.png',
    32: 'icon-32.png',
    64: 'icon-128.png',
    128: 'icon-128.png'
  }
  for (const [size, file] of Object.entries(sizes)) {
    await cp(join(icons, file), join(dir, 'img', `icon_${size}.png`))
  }
  await cp(mark, join(dir, 'img', 'ublock.svg'))
}

const union = (...lists) => [...new Set(lists.flat().filter((item) => item !== undefined))]

/** The larger of two version strings such as "123" and "122.0", compared number by number. */
export function laterVersion(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference > 0 ? a : b
  }
  return a
}

/** The Chrome service worker: Mergelane's background first, so it still runs if uBO Lite's
 * fails to start, then uBO Lite's. Both are modules in one worker. */
export const SERVICE_WORKER = "import './background.js'\nimport './js/background.js'\n"

/**
 * One manifest from Mergelane's (`ours`, already made for `browser` by build.mjs) and uBO Lite's
 * (`theirs`). Mergelane's name, key, icons, popup, options page and background come first; uBO
 * Lite adds its rules, permissions, page resources, shortcuts and policy schema. Its background joins
 * Mergelane's, both loaded as modules.
 */
export function mergeManifest(ours, theirs, browser) {
  for (const field of ['declarative_net_request', 'web_accessible_resources', 'background']) {
    if (!theirs?.[field]) throw new Error(`uBO Lite's ${browser} manifest has no ${field}`)
  }
  const merged = {
    ...ours,
    default_locale: theirs.default_locale ?? 'en',
    permissions: union(ours.permissions ?? [], theirs.permissions ?? []),
    host_permissions: union(ours.host_permissions ?? [], theirs.host_permissions ?? []),
    declarative_net_request: theirs.declarative_net_request,
    web_accessible_resources: union(
      ours.web_accessible_resources ?? [],
      theirs.web_accessible_resources
    )
  }
  const optional = union(ours.optional_permissions ?? [], theirs.optional_permissions ?? [])
  if (optional.length > 0) merged.optional_permissions = optional
  if (theirs.commands) merged.commands = { ...theirs.commands, ...(ours.commands ?? {}) }
  if (theirs.storage) merged.storage = theirs.storage
  if (browser === 'chrome') {
    if (!theirs.background.service_worker) {
      throw new Error("uBO Lite's chrome manifest has no service worker")
    }
    merged.background = { service_worker: 'service-worker.js', type: 'module' }
    const minimum = laterVersion(ours.minimum_chrome_version, theirs.minimum_chrome_version)
    if (minimum !== undefined) merged.minimum_chrome_version = String(minimum)
  } else if (browser === 'firefox') {
    const scripts = theirs.background.scripts
    if (!Array.isArray(scripts) || theirs.background.type !== 'module') {
      throw new Error("uBO Lite's firefox manifest has no module background scripts")
    }
    merged.background = {
      scripts: union(ours.background?.scripts ?? [], scripts),
      type: 'module'
    }
    const gecko = ours.browser_specific_settings?.gecko ?? {}
    merged.browser_specific_settings = {
      ...ours.browser_specific_settings,
      gecko: {
        ...gecko,
        strict_min_version: laterVersion(
          gecko.strict_min_version,
          theirs.browser_specific_settings?.gecko?.strict_min_version
        )
      }
    }
  } else {
    throw new Error(`unknown browser: ${browser}`)
  }
  return merged
}

/**
 * uBO Lite merged into one built browser folder (`dir`, which already holds Mergelane's files):
 * copied under them, patched, branded, its manifest merged into `ours`. Returns the manifest written.
 */
export async function mergeInto(dir, browser, ours, { buildDir, icons, mark }) {
  const theirs = JSON.parse(await readFile(join(buildDir, 'manifest.json'), 'utf-8'))
  const staging = `${dir}.ubol`
  await rm(staging, { recursive: true, force: true })
  try {
    await copyBuild(buildDir, staging)
    await applyPatches(staging)
    await brandLocales(staging)
    await brandImages(staging, { icons, mark })
    // Mergelane's files go on top; none has the same name as one of uBO Lite's (checked here).
    for (const entry of await readdir(dir)) {
      if (existsSync(join(staging, entry))) {
        throw new Error(`uBO Lite's ${browser} build also has ${entry}`)
      }
      await cp(join(dir, entry), join(staging, entry), { recursive: true })
    }
    const manifest = mergeManifest(ours, theirs, browser)
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (browser === 'chrome') await writeFile(join(staging, 'service-worker.js'), SERVICE_WORKER)
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
    return manifest
  } catch (failure) {
    await rm(staging, { recursive: true, force: true })
    throw failure
  }
}
