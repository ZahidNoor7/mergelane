import { listPackage } from '@electron/asar'
import { join } from 'node:path'

// electron-builder's afterPack hook (electron-builder.yml, ADR-0074). It reads the archive the build just made,
// entries marked as unpacked included, and fails the build if anything in it is outside what the app loads.

/** What app.asar may hold at its top: the code electron-vite builds, the icons it imports, and what electron-builder
 * always adds, package.json and the production node_modules. */
export const ALLOWED = new Set(['package.json', 'node_modules', 'out', 'resources'])

/** Inside an allowed folder, what still must not ship there: the media tools, which go beside the archive
 * (extraResources), and the WebRTC packages, which Mergelane never loads (rc.12 shipped a macOS binary of
 * node-datachannel on Windows). */
const UNWANTED = [
  ['resources', 'bin'],
  ['resources', 'bin-win'],
  ['node_modules', 'node-datachannel'],
  ['node_modules', 'webrtc-polyfill']
]

/** At most this many entries are named in the error; the rest are counted. */
export const SHOWN = 10

/** The entries of an archive listing that must not ship, each named once by its outermost path: `e2e`, not every
 * spec under it. Paths may use either separator. */
export function strayEntries(entries) {
  const stray = new Set()
  for (const entry of entries) {
    const parts = entry.split(/[\\/]/).filter(Boolean)
    if (parts.length === 0) continue
    if (!ALLOWED.has(parts[0])) {
      stray.add(parts[0])
      continue
    }
    const unwanted = UNWANTED.find(([top, name]) => parts[0] === top && parts[1] === name)
    if (unwanted) stray.add(unwanted.join('/'))
  }
  return [...stray].sort()
}

/** The error for `stray`, naming the first {@link SHOWN}. */
export function strayMessage(archive, stray) {
  const shown = stray.slice(0, SHOWN).join(', ')
  const more = stray.length > SHOWN ? ` and ${stray.length - SHOWN} more` : ''
  return `${archive} holds files Mergelane doesn't load: ${shown}${more}. Let them in through \`files\` in electron-builder.yml only if the app reads them at run time.`
}

export default async function checkPackage(context) {
  const archive = join(context.packager.getResourcesDir(context.appOutDir), 'app.asar')
  const stray = strayEntries(listPackage(archive))
  if (stray.length) throw new Error(strayMessage(archive, stray))
}
