import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { fetchBuild, loadPin, mergeInto } from '../../scripts/adblock/ubol.mjs'

const root = dirname(fileURLToPath(import.meta.url))
// `node extension/build.mjs <dir>` builds somewhere else: e2e specs running side by side each
// load their own copy, so one spec's rebuild never deletes the extension another's browser runs.
const out = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist')
const scripts = join(out, 'scripts')

await rm(out, { recursive: true, force: true })

// One self-contained script each. The background is loaded as a module next to uBO Lite's
// (ADR-0063), which a self-contained script is too; the popup and options pages load classic scripts.
for (const name of ['background', 'popup', 'options']) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir: scripts,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(root, 'src', `${name}.ts`),
        formats: ['iife'],
        name: 'mergelane',
        fileName: () => `${name}.js`
      }
    }
  })
}

const base = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf-8'))
// One manifest per browser: given both background keys, Chrome reports the one it doesn't use as
// an error.
const manifests = {
  chrome: {
    ...base,
    // The first Chrome where every API this calls returns a promise (contextMenus.removeAll).
    minimum_chrome_version: '123',
    background: { service_worker: 'background.js' }
  },
  firefox: {
    // The key fixes the Chrome extension's ID (docs/BROWSER-BRIDGE.md); Firefox uses gecko.id.
    ...Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'key')),
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'mergelane@zahidnoor7.github.io',
        strict_min_version: '121.0',
        // Everything goes to the local app on 127.0.0.1; nothing leaves the device.
        data_collection_permissions: { required: ['none'] }
      }
    }
  }
}

// uBO Lite, the ad blocker (ADR-0063): its pinned build for each browser, fetched and checked once
// into app/extension/.cache, then merged under Mergelane's files with one manifest for both.
const ubol = await loadPin()
const brand = {
  icons: join(root, 'icons'),
  mark: join(root, '../../design-system/mergelane/redesign/brand/svg/mark.svg')
}

for (const [browser, manifest] of Object.entries(manifests)) {
  const dir = join(out, browser)
  await mkdir(dir, { recursive: true })
  await cp(scripts, dir, { recursive: true })
  for (const file of ['popup.html', 'options.html', 'ui.css']) {
    await cp(join(root, 'src', file), join(dir, file))
  }
  await cp(join(root, 'icons'), join(dir, 'icons'), { recursive: true })
  await cp(join(root, '../src/renderer/src/assets/fonts'), join(dir, 'fonts'), { recursive: true })
  const buildDir = await fetchBuild(ubol, browser, { log: (line) => console.log(line) })
  await mergeInto(dir, browser, manifest, { buildDir, ...brand })
}
await rm(scripts, { recursive: true })
console.log(
  `Built ${Object.keys(manifests).join(' and ')} with uBO Lite ${ubol.version} into ${out}`
)
