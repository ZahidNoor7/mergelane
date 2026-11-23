import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { createPackage } from '@electron/asar'
import checkPackage, { SHOWN, strayEntries, strayMessage } from './check-package.mjs'

// What a correct build's archive lists (directories and files, as @electron/asar's listPackage gives them).
const CLEAN = [
  '/package.json',
  '/node_modules',
  '/node_modules/koffi',
  '/node_modules/koffi/index.js',
  '/node_modules/node-datachannel-like/index.js',
  '/out',
  '/out/main/index.js',
  '/out/preload/index.js',
  '/out/renderer/index.html',
  '/resources',
  '/resources/tray.ico',
  '/resources/trayTemplate@2x.png',
  '/resources/binary-icon.png'
]

test('a correct build has nothing stray', () => {
  assert.deepEqual(strayEntries(CLEAN), [])
  assert.deepEqual(strayEntries([]), [])
  assert.deepEqual(strayEntries(['/', '']), [])
})

test('what 0.6.0 shipped by mistake is named once per folder', () => {
  const listing = [
    ...CLEAN,
    '/extension',
    '/extension/.cache/ubol/chrome/manifest.json',
    '/extension/dist/chrome/background.js',
    '/e2e',
    '/e2e/fixtures.ts',
    '/e2e/nzb.spec.ts',
    '/test-results/.last-run.json',
    '/tsconfig.web.tsbuildinfo',
    '/playwright.config.ts'
  ]
  assert.deepEqual(strayEntries(listing), [
    'e2e',
    'extension',
    'playwright.config.ts',
    'test-results',
    'tsconfig.web.tsbuildinfo'
  ])
})

test('inside allowed folders: media tools and the WebRTC packages are still stray', () => {
  const listing = [
    ...CLEAN,
    '/resources/bin',
    '/resources/bin/ffmpeg',
    '/resources/bin-win/x64/deno.exe',
    '/node_modules/node-datachannel/lib/index.js',
    '/node_modules/webrtc-polyfill'
  ]
  assert.deepEqual(strayEntries(listing), [
    'node_modules/node-datachannel',
    'node_modules/webrtc-polyfill',
    'resources/bin',
    'resources/bin-win'
  ])
})

test('Windows separators are read the same', () => {
  assert.deepEqual(
    strayEntries(['\\out\\main\\index.js', '\\e2e\\fixtures.ts', '\\resources\\bin\\ffmpeg']),
    ['e2e', 'resources/bin']
  )
})

test('the message names the first few and counts the rest', () => {
  assert.equal(
    strayMessage('/x/app.asar', ['e2e', 'extension']),
    "/x/app.asar holds files Mergelane doesn't load: e2e, extension. Let them in through `files` in electron-builder.yml only if the app reads them at run time."
  )
  const many = Array.from({ length: SHOWN + 3 }, (_, i) => `stray${String(i).padStart(2, '0')}`)
  const message = strayMessage('/x/app.asar', many)
  assert.match(message, new RegExp(`stray${String(SHOWN - 1).padStart(2, '0')} and 3 more\\.`))
  assert.doesNotMatch(message, new RegExp(`stray${SHOWN}`))
})

const scratch = await mkdtemp(join(tmpdir(), 'check-package-'))
after(() => rm(scratch, { recursive: true, force: true }))

/** Packs `files` (path -> contents) into <scratch>/<name>/Resources/app.asar, and returns the hook's context. */
async function packed(name, files) {
  const source = join(scratch, name, 'source')
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await writeFile(join(source, path), contents)
  }
  const appOutDir = join(scratch, name, 'app')
  await mkdir(join(appOutDir, 'Resources'), { recursive: true })
  await createPackage(source, join(appOutDir, 'Resources', 'app.asar'))
  return { appOutDir, packager: { getResourcesDir: (dir) => join(dir, 'Resources') } }
}

test('the hook passes a correct archive', async () => {
  const context = await packed('clean', {
    'package.json': '{"name":"mergelane"}',
    'out/main/index.js': '',
    'resources/tray.ico': '',
    'node_modules/koffi/index.js': ''
  })
  await checkPackage(context)
})

test('the hook fails the build on a stray file, naming it and the archive', async () => {
  const context = await packed('stray', {
    'package.json': '{"name":"mergelane"}',
    'out/main/index.js': '',
    'e2e/fixtures.ts': '',
    'node_modules/node-datachannel/index.js': ''
  })
  await assert.rejects(checkPackage(context), (error) => {
    assert.match(
      error.message,
      /stray[\\/]app[\\/]Resources[\\/]app\.asar holds files Mergelane doesn't load: /
    )
    assert.match(error.message, /: e2e, node_modules\/node-datachannel\. /)
    return true
  })
})

test('the hook fails when the archive is missing', async () => {
  const context = {
    appOutDir: join(scratch, 'missing'),
    packager: { getResourcesDir: (dir) => dir }
  }
  await assert.rejects(checkPackage(context))
})
