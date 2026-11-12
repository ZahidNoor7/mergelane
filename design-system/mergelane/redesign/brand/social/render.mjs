// Renders social-preview.html to social-preview.png (1280 × 640), the GitHub social preview.
// usage, from the repository root (uses the app's Playwright and its Chromium):
//   node design-system/mergelane/redesign/brand/social/render.mjs
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../../../../../app/package.json'))
const { chromium } = require('playwright')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1
  })
  await page.goto(pathToFileURL(join(here, 'social-preview.html')).href)
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(() => document.fonts.check('720 112px Archivo'))
  if (!loaded) throw new Error('Archivo did not load')
  await page.screenshot({ path: join(here, 'social-preview.png') })
} finally {
  await browser.close()
}
