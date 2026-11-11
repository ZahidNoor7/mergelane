import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type MergelaneApp } from './fixtures'

// Liquid Glass (M3.1 pull request 7): the theme puts the window in macOS's material (Electron's
// vibrancy) over a clear background; Reduce Transparency from Settings makes it solid again. Read
// from the real window, through what Electron reports, and the saved settings.

const windowBackground = (mergelane: MergelaneApp): Promise<string> =>
  mergelane.evaluateMain(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    null
  )

test.describe('Liquid Glass @smoke', () => {
  test.skip(process.platform !== 'darwin', 'the material is macOS’s')

  test('the theme clears the window for the material; Reduce transparency makes it solid', async ({
    mergelane,
    dirs
  }) => {
    const before = await windowBackground(mergelane)
    await mergelane.openSettings()
    const page = mergelane.page
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Appearance' })
      .click()
    await page.getByText('Liquid Glass', { exact: true }).first().click()
    await expect.poll(() => windowBackground(mergelane)).not.toBe(before)
    const glass = await windowBackground(mergelane)
    expect(glass.toUpperCase()).toMatch(/^#0{6}(0{2})?$/)

    const panel = page.getByRole('region', { name: 'Liquid Glass' })
    await panel.getByRole('button', { name: 'Tinted' }).click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.glass))
      .toBe('tinted')
    await panel.getByRole('switch', { name: 'Reduce transparency' }).click()
    // Solid: the theme's own ground again.
    await expect.poll(() => windowBackground(mergelane)).not.toBe(glass)
    await expect
      .poll(async () =>
        JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
      )
      .toMatchObject({ appearanceTheme: 'liquid', glassLook: 'tinted', solidGlass: true })

    // Kept over a restart, from the first frame.
    await mergelane.relaunch()
    expect((await windowBackground(mergelane)).toUpperCase()).not.toMatch(/^#0{6}(0{2})?$/)
    await mergelane.page.getByRole('heading', { level: 1 }).first().waitFor()
    expect(await mergelane.page.evaluate(() => document.documentElement.dataset.solid)).toBe('')
  })
})
