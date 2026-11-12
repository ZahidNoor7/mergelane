import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The app icon wherever Mergelane shows it, kept to the final design's
// (design-system/mergelane/redesign/brand, ADR-0034). The browser extension carried Plexo's icon
// until 2026-11-12; these keep every copy on the design's.

const app = resolve(__dirname, '../..')
const brand = resolve(app, '../design-system/mergelane/redesign/brand/png')
const extension = resolve(app, 'extension')

const bytes = (path: string): Buffer => readFileSync(path)

/** A PNG's width, height and colour type, from its IHDR chunk. */
function png(path: string): { width: number; height: number; colourType: number } {
  const data = bytes(path)
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(data.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data[25] }
}
/** PNG colour types with an alpha channel: grey with alpha (4) and RGB with alpha (6). */
const WITH_ALPHA = [4, 6]

describe('the app icon', () => {
  it('is the design’s in Settings › Updates and in the menu bar', () => {
    expect(bytes(resolve(app, 'src/renderer/src/assets/brand/icon-128.png'))).toEqual(
      bytes(resolve(brand, 'icon-default-128.png'))
    )
    expect(bytes(resolve(app, 'resources/trayTemplate.png'))).toEqual(
      bytes(resolve(brand, 'trayTemplate.png'))
    )
    expect(png(resolve(app, 'resources/trayTemplate@2x.png'))).toMatchObject({
      width: 32,
      height: 32
    })
  })

  it('is the design’s in the window and the packaged app, at 512 px', () => {
    for (const path of ['build/icon.png', 'resources/icon-dark.png']) {
      expect(png(resolve(app, path))).toMatchObject({ width: 512, height: 512 })
    }
    expect(bytes(resolve(app, 'resources/icon-dark.png'))).toEqual(
      bytes(resolve(app, 'build/icon.png'))
    )
  })
})

describe('the browser extension’s icon', () => {
  const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8')) as {
    icons: Record<string, string>
    action: { default_icon: Record<string, string> }
  }
  const background = readFileSync(resolve(extension, 'src/background.ts'), 'utf8')
  /** The icons background.ts sets: on while it captures and reaches Mergelane, off otherwise. */
  const set = (name: string): Record<string, string> => {
    const found = background.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))
    expect(found, name).not.toBeNull()
    return Object.fromEntries(
      [...found![1].matchAll(/(\d+): '([^']+)'/g)].map(([, size, path]) => [size, path])
    )
  }

  it('is the design’s at the sizes the design exports', () => {
    expect(bytes(resolve(extension, 'icons/icon-128.png'))).toEqual(
      bytes(resolve(brand, 'icon-default-128.png'))
    )
    expect(bytes(resolve(extension, 'icons/icon-32.png'))).toEqual(
      bytes(resolve(brand, 'icon-default-32.png'))
    )
  })

  it('names files that exist, at the size each is named for, with transparent corners', () => {
    const named = [manifest.icons, manifest.action.default_icon, set('ICON'), set('ICON_OFF')]
    for (const icons of named) {
      expect(Object.keys(icons).length).toBeGreaterThan(0)
      for (const [size, path] of Object.entries(icons)) {
        const file = resolve(extension, path)
        expect(existsSync(file), path).toBe(true)
        const { width, height, colourType } = png(file)
        expect([width, height], path).toEqual([Number(size), Number(size)])
        expect(WITH_ALPHA, path).toContain(colourType)
      }
    }
  })

  it('goes grey while it is off', () => {
    for (const path of Object.values(set('ICON_OFF'))) {
      expect(png(resolve(extension, path)).colourType, path).toBe(4)
    }
  })
})
