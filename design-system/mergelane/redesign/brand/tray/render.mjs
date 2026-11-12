// Renders the Windows notification-area icon, app/resources/tray.ico, from the blue mark alone
// (../svg/mark.svg), as the design's Windows 11 study asks (docs/DECISIONS.md ADR-0061). The ICO holds
// the 16, 20 and 24px versions Microsoft's notification-area guidance names, and the larger ones its
// icon guidance lists for the notification area at higher display scales (32, 40, 48 and 64px), each a
// 32-bit PNG. Electron recommends ICO for tray icons on Windows.
// usage, from the repository root (uses the app's Playwright and its Chromium):
//   node design-system/mergelane/redesign/brand/tray/render.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../../../../../app/package.json'))
const { chromium } = require('playwright')

export const SIZES = [16, 20, 24, 32, 40, 48, 64]

/** An ICO file holding these PNG images (ICONDIR, one ICONDIRENTRY each, then the PNGs). */
export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size >= 256 ? 0 : size, entry) // width
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1) // height
    header.writeUInt8(0, entry + 2) // no palette
    header.writeUInt8(0, entry + 3) // reserved
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(({ png }) => png)])
}

async function render() {
  const mark = await readFile(join(here, '../svg/mark.svg'), 'utf8')
  const browser = await chromium.launch()
  try {
    const images = []
    for (const size of SIZES) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1
      })
      // The mark is wide: it fills the width, with a pixel to spare on each side from 16px, and is centred
      // in the height.
      const pad = Math.max(1, Math.round(size / 16))
      await page.setContent(
        `<html><body style="margin:0;background:transparent">` +
          `<div style="width:${size}px;height:${size}px;display:grid;place-items:center;box-sizing:border-box;padding:0 ${pad}px">` +
          mark.replace('<svg ', '<svg style="width:100%;height:auto;display:block" ') +
          `</div></body></html>`
      )
      images.push({ size, png: await page.screenshot({ omitBackground: true }) })
      await page.close()
    }
    const out = join(here, '../../../../../app/resources/tray.ico')
    await writeFile(out, encodeIco(images))
    console.log(`wrote ${out}`)
  } finally {
    await browser.close()
  }
}

await render()
