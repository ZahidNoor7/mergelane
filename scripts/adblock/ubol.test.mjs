// Tests for ubol.mjs, the merging of uBO Lite into the browser extension (ADR-0063). No network:
// "downloads" copy a zip made here with /usr/bin/ditto.
//
// node --test --experimental-test-coverage --test-coverage-include='scripts/adblock/ubol.mjs' \
//   scripts/adblock/ubol.test.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { sha256File } from '../media-tools/fetch.mjs'
import {
  applyPatches,
  brandImages,
  brandLocales,
  checkTree,
  copyBuild,
  DEFAULT_PIN,
  fetchBuild,
  laterVersion,
  LEFT_OUT,
  loadPin,
  mergeInto,
  mergeManifest,
  patchText,
  PATCHES,
  pinProblems,
  SERVICE_WORKER
} from './ubol.mjs'

const run = promisify(execFile)
let work

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'mergelane-ubol-test-'))
})
after(async () => {
  await rm(work, { recursive: true, force: true })
})

const SHA = 'a'.repeat(64)
const pinWith = (tool) => ({ tools: [tool] })
const goodTool = () => ({
  name: 'ubo-lite',
  version: '2026.1110.1816',
  builds: {
    chrome: { url: 'https://example.com/c.zip', sha256: SHA },
    firefox: { url: 'https://example.com/f.xpi', sha256: SHA }
  }
})

/** uBO Lite's manifests, cut down to the fields mergeManifest reads. */
const THEIRS = {
  chrome: {
    default_locale: 'en',
    background: { service_worker: '/js/background.js', type: 'module' },
    permissions: ['activeTab', 'alarms', 'declarativeNetRequest', 'scripting', 'storage'],
    host_permissions: ['<all_urls>'],
    declarative_net_request: {
      rule_resources: [{ id: 'easylist', enabled: true, path: '/r.json' }]
    },
    web_accessible_resources: [{ resources: ['/strictblock.html'], matches: ['<all_urls>'] }],
    commands: {
      'enter-picker-mode': { description: '__MSG_pickerTipEnter__' }
    },
    storage: { managed_schema: 'managed_storage.json' },
    minimum_chrome_version: '122.0'
  },
  firefox: {
    default_locale: 'en',
    background: { scripts: ['/js/background.js'], type: 'module' },
    permissions: ['declarativeNetRequest', 'scripting', 'storage'],
    optional_permissions: ['userScripts'],
    host_permissions: ['<all_urls>'],
    declarative_net_request: { rule_resources: [] },
    web_accessible_resources: [],
    browser_specific_settings: {
      gecko: {
        id: 'uBOLiteRedux@raymondhill.net',
        strict_min_version: '128.0'
      }
    }
  }
}
const OURS = {
  chrome: {
    manifest_version: 3,
    name: 'Download with Mergelane',
    permissions: ['alarms', 'downloads', 'storage'],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '123',
    background: { service_worker: 'background.js' }
  },
  firefox: {
    manifest_version: 3,
    name: 'Download with Mergelane',
    permissions: ['downloads', 'storage'],
    host_permissions: ['<all_urls>'],
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'mergelane@zahidnoor7.github.io',
        strict_min_version: '121.0'
      }
    }
  }
}

/** A small stand-in for an unpacked uBO Lite build, holding every text PATCHES changes. */
async function fakeBuild(dir, browser = 'chrome') {
  await mkdir(join(dir, 'js'), { recursive: true })
  await mkdir(join(dir, 'img'), { recursive: true })
  await mkdir(join(dir, '_locales', 'en'), { recursive: true })
  await mkdir(join(dir, '_locales', 'fr'), { recursive: true })
  await mkdir(join(dir, '_locales', 'empty'), { recursive: true })
  await mkdir(join(dir, 'META-INF'), { recursive: true })
  await writeFile(
    join(dir, 'js', 'config.js'),
    'export const c = {\n    showBlockedCount: true,\n};\n'
  )
  await writeFile(
    join(dir, 'js', 'action.js'),
    'export function toggleToolbarIcon(tabId) {\n    setIcon(tabId);\n}\n'
  )
  await writeFile(join(dir, 'js', 'background.js'), '// uBO Lite\n')
  await writeFile(join(dir, 'dashboard.html'), '<img src="img/ublock.svg" alt="uBO Lite">\n')
  await writeFile(join(dir, 'popup.html'), 'theirs\n')
  await writeFile(join(dir, 'README.md'), 'readme\n')
  await writeFile(join(dir, 'META-INF', 'cose.sig'), 'sig\n')
  await writeFile(join(dir, 'img', 'ublock.svg'), '<svg/>\n')
  await writeFile(
    join(dir, '_locales', 'en', 'messages.json'),
    JSON.stringify({
      extName: { message: 'uBlock Origin Lite' },
      other: { message: 'x' },
      blocked: { message: 'uBO Lite has prevented this; uBO Lite says so' },
      odd: { description: 'no message' }
    })
  )
  await writeFile(
    join(dir, '_locales', 'fr', 'messages.json'),
    JSON.stringify({ title: { message: 'uBO Lite — Tableau de bord' } })
  )
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(THEIRS[browser]))
  return dir
}

async function fakeBrand() {
  const icons = join(work, 'brand-icons')
  await mkdir(icons, { recursive: true })
  for (const name of ['icon-16.png', 'icon-32.png', 'icon-128.png']) {
    await writeFile(join(icons, name), name)
  }
  const mark = join(work, 'mark.svg')
  await writeFile(mark, '<svg id="mergelane"/>')
  return { icons, mark }
}

describe('pinProblems', () => {
  test('accepts a complete pin', () => {
    assert.deepEqual(pinProblems(pinWith(goodTool())), [])
  })
  test('needs exactly one tool', () => {
    assert.deepEqual(pinProblems({}), ['ubol.json must list exactly one tool'])
    assert.deepEqual(pinProblems({ tools: [goodTool(), goodTool()] }), [
      'ubol.json must list exactly one tool'
    ])
  })
  test('names each problem', () => {
    const tool = goodTool()
    tool.version = 'latest'
    delete tool.builds.firefox
    tool.builds.chrome = { url: 'http://example.com/c.zip', sha256: 'ABC' }
    assert.deepEqual(pinProblems(pinWith(tool)), [
      'version must be dotted numbers',
      'chrome: url must be an https URL',
      'chrome: sha256 must be 64 lowercase hex characters',
      'no firefox build'
    ])
  })
  test('a missing url is a problem', () => {
    const tool = goodTool()
    delete tool.builds.chrome.url
    assert.deepEqual(pinProblems(pinWith(tool)), ['chrome: url must be an https URL'])
  })
})

describe('loadPin', () => {
  test("reads the repository's pin", async () => {
    const tool = await loadPin(DEFAULT_PIN)
    assert.equal(tool.name, 'ubo-lite')
    assert.match(tool.license, /^GPL-3\.0/)
  })
  test('refuses a broken pin with its problems', async () => {
    const path = join(work, 'bad.json')
    await writeFile(path, JSON.stringify({ tools: [] }))
    await assert.rejects(loadPin(path), /must list exactly one tool/)
  })
})

describe('checkTree', () => {
  test('accepts folders and files', async () => {
    const dir = await fakeBuild(join(work, 'tree-ok'))
    await checkTree(dir)
  })
  test('refuses a link', async () => {
    const dir = join(work, 'tree-link')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await symlink('/etc/hosts', join(dir, 'sub', 'hosts'))
    await assert.rejects(checkTree(dir), /"sub\/hosts" is not a file or a folder/)
  })
})

describe('fetchBuild', () => {
  let zip
  let zipSha
  before(async () => {
    const source = await fakeBuild(join(work, 'zip-source'))
    zip = join(work, 'build.zip')
    await run('/usr/bin/ditto', ['-c', '-k', source, zip])
    zipSha = await sha256File(zip)
  })
  const toolWith = (sha256) => ({
    version: '1.0',
    builds: { chrome: { url: 'https://example.com/c.zip', sha256 } }
  })

  test('downloads, checks, unpacks, then reuses the cache', async () => {
    const cacheDir = join(work, 'cache-a')
    const calls = []
    const download = async (url, dest) => {
      calls.push(url)
      await copyFile(zip, dest)
    }
    const lines = []
    const dir = await fetchBuild(toolWith(zipSha), 'chrome', {
      cacheDir,
      download,
      log: (line) => lines.push(line)
    })
    assert.equal(dir, join(cacheDir, '1.0', 'chrome'))
    assert.ok(existsSync(join(dir, 'js', 'config.js')))
    assert.equal((await readFile(join(cacheDir, '1.0', 'chrome.sha256'), 'utf-8')).trim(), zipSha)
    assert.deepEqual(await readdir(join(cacheDir, '1.0')), ['chrome', 'chrome.sha256'])
    assert.match(lines[0], /downloading https:\/\/example\.com\/c\.zip/)

    await fetchBuild(toolWith(zipSha), 'chrome', { cacheDir, download })
    assert.equal(calls.length, 1)
  })

  test('downloads again when the pin changed', async () => {
    const cacheDir = join(work, 'cache-b')
    let calls = 0
    const download = async (_url, dest) => {
      calls++
      await copyFile(zip, dest)
    }
    await fetchBuild(toolWith(zipSha), 'chrome', { cacheDir, download })
    await writeFile(join(cacheDir, '1.0', 'chrome.sha256'), `${SHA}\n`)
    await fetchBuild(toolWith(zipSha), 'chrome', { cacheDir, download })
    assert.equal(calls, 2)
  })

  test('refuses a build with the wrong hash and leaves nothing behind', async () => {
    const cacheDir = join(work, 'cache-c')
    const download = async (_url, dest) => copyFile(zip, dest)
    await assert.rejects(
      fetchBuild(toolWith(SHA), 'chrome', { cacheDir, download }),
      new RegExp(`SHA-256 is ${zipSha}, expected ${SHA}`)
    )
    assert.deepEqual(await readdir(join(cacheDir, '1.0')), [])
  })

  test('needs a pinned build for the browser', async () => {
    await assert.rejects(fetchBuild(toolWith(SHA), 'firefox', { cacheDir: work }), /no firefox/)
  })
})

describe('copyBuild', () => {
  test('leaves out what Mergelane replaces or does not ship', async () => {
    const from = await fakeBuild(join(work, 'copy-from'))
    const to = join(work, 'copy-to')
    await copyBuild(from, to)
    const entries = await readdir(to)
    for (const left of LEFT_OUT) assert.ok(!entries.includes(left), left)
    assert.ok(entries.includes('js') && entries.includes('dashboard.html'))
  })
})

describe('patches', () => {
  test('patchText replaces text found once', () => {
    assert.equal(patchText('a b c', { file: 'f', find: 'b', replace: '$&x' }), 'a $&x c')
  })
  test('patchText refuses text found no times or twice', () => {
    assert.throws(() => patchText('a', { file: 'f.js', find: 'b', replace: '' }), /f\.js.*0 times/)
    assert.throws(() => patchText('bb', { file: 'f.js', find: 'b', replace: '' }), /2 times/)
  })
  test('every patch applies to the build', async () => {
    const dir = await fakeBuild(join(work, 'patch'))
    await applyPatches(dir)
    assert.match(await readFile(join(dir, 'js', 'config.js'), 'utf-8'), /showBlockedCount: false/)
    assert.match(
      await readFile(join(dir, 'js', 'action.js'), 'utf-8'),
      /toggleToolbarIcon\(tabId\) \{\n.*\n.*\n {4}return;\n/
    )
    assert.match(await readFile(join(dir, 'dashboard.html'), 'utf-8'), /alt="Mergelane"/)
    for (const patch of PATCHES) assert.ok(patch.why.length > 0, patch.file)
  })
  test("the pinned builds take every patch, when they're in the cache", async (t) => {
    const tool = await loadPin()
    for (const browser of ['chrome', 'firefox']) {
      const cached = join(
        new URL('../../app/extension/.cache/ubol', import.meta.url).pathname,
        tool.version,
        browser
      )
      if (!existsSync(cached)) {
        t.diagnostic(`no cached ${browser} build at ${cached}; run npm run build:extension`)
        continue
      }
      for (const patch of PATCHES) {
        patchText(await readFile(join(cached, patch.file), 'utf-8'), patch)
      }
    }
  })
})

describe('branding', () => {
  test('says Mergelane in every locale, and skips a folder without messages', async () => {
    const dir = await fakeBuild(join(work, 'brand'))
    await brandLocales(dir)
    const en = JSON.parse(await readFile(join(dir, '_locales', 'en', 'messages.json'), 'utf-8'))
    assert.equal(en.extName.message, 'Mergelane')
    assert.equal(en.other.message, 'x')
    assert.equal(en.blocked.message, 'Mergelane has prevented this; Mergelane says so')
    assert.deepEqual(en.odd, { description: 'no message' })
    const fr = JSON.parse(await readFile(join(dir, '_locales', 'fr', 'messages.json'), 'utf-8'))
    assert.equal(fr.extName, undefined)
    assert.equal(fr.title.message, 'Mergelane — Tableau de bord')
  })
  test("puts Mergelane's icons and mark over uBO Lite's", async () => {
    const dir = await fakeBuild(join(work, 'brand-images'))
    await brandImages(dir, await fakeBrand())
    assert.equal(await readFile(join(dir, 'img', 'icon_64.png'), 'utf-8'), 'icon-128.png')
    assert.equal(await readFile(join(dir, 'img', 'icon_16.png'), 'utf-8'), 'icon-16.png')
    assert.equal(await readFile(join(dir, 'img', 'ublock.svg'), 'utf-8'), '<svg id="mergelane"/>')
  })
})

describe('laterVersion', () => {
  test('compares number by number', () => {
    assert.equal(laterVersion('123', '122.0'), '123')
    assert.equal(laterVersion('121.0', '128.0'), '128.0')
    assert.equal(laterVersion('128', '128.0'), '128')
    assert.equal(laterVersion('10.1', '9.9'), '10.1')
    assert.equal(laterVersion(undefined, '5'), '5')
    assert.equal(laterVersion('5', undefined), '5')
  })
})

describe('mergeManifest', () => {
  test("chrome: Mergelane's manifest with uBO Lite's rules, one module service worker", () => {
    const merged = mergeManifest(OURS.chrome, THEIRS.chrome, 'chrome')
    assert.equal(merged.name, 'Download with Mergelane')
    assert.deepEqual(merged.background, {
      service_worker: 'service-worker.js',
      type: 'module'
    })
    assert.deepEqual(merged.permissions, [
      'alarms',
      'downloads',
      'storage',
      'activeTab',
      'declarativeNetRequest',
      'scripting'
    ])
    assert.deepEqual(merged.host_permissions, ['<all_urls>'])
    assert.equal(merged.minimum_chrome_version, '123')
    assert.equal(merged.default_locale, 'en')
    assert.deepEqual(merged.declarative_net_request, THEIRS.chrome.declarative_net_request)
    assert.deepEqual(merged.web_accessible_resources, THEIRS.chrome.web_accessible_resources)
    assert.deepEqual(merged.commands, THEIRS.chrome.commands)
    assert.deepEqual(merged.storage, THEIRS.chrome.storage)
    assert.equal(merged.optional_permissions, undefined)
  })
  test('firefox: both backgrounds as modules, the later minimum version', () => {
    const merged = mergeManifest(OURS.firefox, THEIRS.firefox, 'firefox')
    assert.deepEqual(merged.background, {
      scripts: ['background.js', '/js/background.js'],
      type: 'module'
    })
    assert.deepEqual(merged.browser_specific_settings.gecko, {
      id: 'mergelane@zahidnoor7.github.io',
      strict_min_version: '128.0'
    })
    assert.deepEqual(merged.optional_permissions, ['userScripts'])
    assert.equal(merged.commands, undefined)
    assert.equal(merged.storage, undefined)
  })
  test('fills in what either side leaves out', () => {
    const theirs = { ...THEIRS.firefox, default_locale: undefined }
    delete theirs.permissions
    delete theirs.host_permissions
    delete theirs.browser_specific_settings
    const merged = mergeManifest({ background: {} }, theirs, 'firefox')
    assert.equal(merged.default_locale, 'en')
    assert.deepEqual(merged.permissions, [])
    assert.deepEqual(merged.background.scripts, ['/js/background.js'])
    assert.equal(merged.browser_specific_settings.gecko.strict_min_version, undefined)
    const chrome = mergeManifest(
      {},
      { ...THEIRS.chrome, minimum_chrome_version: undefined },
      'chrome'
    )
    assert.equal(chrome.minimum_chrome_version, undefined)
  })
  test("Mergelane's shortcuts win over uBO Lite's", () => {
    const ours = {
      ...OURS.chrome,
      commands: { 'enter-picker-mode': { description: 'ours' } }
    }
    const merged = mergeManifest(ours, THEIRS.chrome, 'chrome')
    assert.equal(merged.commands['enter-picker-mode'].description, 'ours')
  })
  test('refuses a manifest it does not understand', () => {
    assert.throws(() => mergeManifest(OURS.chrome, {}, 'chrome'), /no declarative_net_request/)
    assert.throws(
      () => mergeManifest(OURS.chrome, { ...THEIRS.chrome, background: { scripts: [] } }, 'chrome'),
      /no service worker/
    )
    assert.throws(
      () =>
        mergeManifest(
          OURS.firefox,
          { ...THEIRS.firefox, background: { scripts: ['a'] } },
          'firefox'
        ),
      /no module background scripts/
    )
    assert.throws(() => mergeManifest(OURS.chrome, THEIRS.chrome, 'safari'), /unknown browser/)
  })
})

describe('mergeInto', () => {
  async function oursIn(dir) {
    await mkdir(join(dir, 'icons'), { recursive: true })
    await writeFile(join(dir, 'background.js'), '// Mergelane\n')
    await writeFile(join(dir, 'popup.html'), 'ours\n')
    await writeFile(join(dir, 'icons', 'icon-16.png'), 'png')
    return dir
  }

  test('chrome: uBO Lite under Mergelane, one manifest, the service worker', async () => {
    const buildDir = await fakeBuild(join(work, 'merge-build'))
    const dir = await oursIn(join(work, 'merge-out', 'chrome'))
    const manifest = await mergeInto(dir, 'chrome', OURS.chrome, {
      buildDir,
      ...(await fakeBrand())
    })
    assert.equal(manifest.background.service_worker, 'service-worker.js')
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')), manifest)
    assert.equal(await readFile(join(dir, 'service-worker.js'), 'utf-8'), SERVICE_WORKER)
    assert.equal(await readFile(join(dir, 'popup.html'), 'utf-8'), 'ours\n')
    assert.equal(await readFile(join(dir, 'background.js'), 'utf-8'), '// Mergelane\n')
    assert.equal(await readFile(join(dir, 'js', 'background.js'), 'utf-8'), '// uBO Lite\n')
    assert.match(await readFile(join(dir, 'js', 'config.js'), 'utf-8'), /showBlockedCount: false/)
    assert.ok(!existsSync(join(dir, 'META-INF')))
    assert.ok(!existsSync(`${dir}.ubol`))
  })

  test('firefox: no service worker file', async () => {
    const buildDir = await fakeBuild(join(work, 'merge-build-ff'), 'firefox')
    const dir = await oursIn(join(work, 'merge-out', 'firefox'))
    await mergeInto(dir, 'firefox', OURS.firefox, {
      buildDir,
      ...(await fakeBrand())
    })
    assert.ok(!existsSync(join(dir, 'service-worker.js')))
  })

  test('refuses a file of the same name and leaves the folder as it was', async () => {
    const buildDir = await fakeBuild(join(work, 'clash-build'))
    const dir = await oursIn(join(work, 'clash-out', 'chrome'))
    await writeFile(join(dir, 'dashboard.html'), 'ours\n')
    await assert.rejects(
      mergeInto(dir, 'chrome', OURS.chrome, {
        buildDir,
        ...(await fakeBrand())
      }),
      /build also has dashboard\.html/
    )
    assert.equal(await readFile(join(dir, 'dashboard.html'), 'utf-8'), 'ours\n')
    assert.ok(!existsSync(`${dir}.ubol`))
  })
})
