import type { Locator } from '@playwright/test'
import { expect, test, type MergelaneApp } from './fixtures'

// The Windows 11 look (docs/DECISIONS.md ADR-0060), rendered on the Mac: MERGELANE_E2E_RENDERER_PLATFORM
// (testKnobs.ts) tells the renderer it runs on Windows, so these tests check the real stylesheet in a real
// Chromium, which the unit tests (jsdom, no CSS) can't. What Windows itself draws, Mica and the caption
// buttons, is checked on the Windows laptop (docs/WINDOWS-TESTING.md).

async function asWindows(mergelane: MergelaneApp): Promise<void> {
  await mergelane.relaunch({ MERGELANE_E2E_RENDERER_PLATFORM: 'win32' })
}

const style = (locator: Locator, property: string): Promise<string> =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

async function settingsSection(mergelane: MergelaneApp, name: string): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name })
    .click()
}

test.describe('The Windows look @smoke', () => {
  test('a 32px title bar with the app’s name, the navigation pane’s accent pill, and the content on its own layer', async ({
    mergelane
  }) => {
    await asWindows(mergelane)
    const { page } = mergelane
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'win32')

    const titleBar = page.locator('.ml-titlebar')
    await expect(titleBar).toHaveText('Mergelane')
    expect((await titleBar.boundingBox())?.height).toBe(32)
    expect(await style(titleBar, 'font-family')).toMatch(/^"Segoe UI Variable Text"/)
    // Clear, so Mica (or the window's ground) shows through behind the title bar and the pane.
    expect(await style(page.locator('body'), 'background-color')).toBe('rgba(0, 0, 0, 0)')

    const nav = page.getByRole('navigation', { name: 'Mergelane' })
    const pill = page.getByTestId('nav-pill')
    await nav.getByRole('button', { name: 'Downloads' }).click()
    await expect(pill).toHaveCSS('translate', '0px 48px')
    await nav.getByRole('button', { name: 'Dashboard' }).click()
    await expect(pill).toHaveCSS('translate', '0px 10px')

    const content = page.locator('.ml-content')
    await expect(content).toHaveCSS('border-top-left-radius', '8px')
    await expect(content).toHaveCSS('border-top-width', '1px')
  })

  test('4px corners on fields and buttons, a field’s accent underline, and Fluent switches', async ({
    mergelane
  }) => {
    await asWindows(mergelane)
    const { page } = mergelane
    await page
      .getByRole('navigation', { name: 'Mergelane' })
      .getByRole('button', { name: 'Downloads' })
      .click()
    const search = page.getByRole('textbox', { name: 'Search downloads' })
    const field = page.locator('.ml-field').filter({ has: search })
    await expect(field).toHaveCSS('border-top-left-radius', '4px')
    await expect(page.getByRole('button', { name: /New download/ }).first()).toHaveCSS(
      'border-top-left-radius',
      '4px'
    )
    await search.focus()
    expect(await style(field, 'box-shadow')).toContain('0px -2px 0px 0px inset')

    await settingsSection(mergelane, 'General')
    const startWithWindows = page.getByRole('switch', { name: 'Start with Windows' })
    await expect(startWithWindows).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Open at login' })).toHaveCount(0)
    await expect(startWithWindows).toHaveCSS('width', '40px')
    await expect(startWithWindows).toHaveCSS('height', '20px')
    // Off: an outlined track, not a filled one.
    await expect(startWithWindows).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  })

  test('every theme but Liquid Glass, which is macOS’s, and a word about Mica', async ({
    mergelane
  }) => {
    await asWindows(mergelane)
    await settingsSection(mergelane, 'Appearance')
    const { page } = mergelane
    await expect(page.getByRole('radio', { name: /Porcelain/ })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Liquid Glass/ })).toHaveCount(0)
    await expect(page.getByText(/On Windows every theme sits on Mica/)).toBeVisible()
  })

  test('Liquid Glass chosen on a Mac opens on Windows as Porcelain, and is still saved for the Mac', async ({
    mergelane
  }) => {
    test.skip(process.platform !== 'darwin', 'Liquid Glass is chosen on the Mac')
    const { page } = mergelane
    await settingsSection(mergelane, 'Appearance')
    await page.getByText('Liquid Glass', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'liquid')

    await asWindows(mergelane)
    await expect(mergelane.page.locator('html')).toHaveAttribute('data-palette', 'porcelain')
    await settingsSection(mergelane, 'Appearance')
    await expect(mergelane.page.getByRole('radio', { name: /Porcelain/ })).toBeChecked()

    // Back on the Mac (the fixture keeps a relaunch's environment, so the knob is cleared, not left out).
    await mergelane.relaunch({ MERGELANE_E2E_RENDERER_PLATFORM: '' })
    await expect(mergelane.page.locator('html')).toHaveAttribute('data-platform', 'darwin')
    await expect(mergelane.page.locator('html')).toHaveAttribute('data-palette', 'liquid')
  })

  test('on the Mac, as before: no Windows title bar, and Liquid Glass offered', async ({
    mergelane
  }) => {
    test.skip(process.platform !== 'darwin', 'the Mac’s own look')
    const { page } = mergelane
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'darwin')
    await expect(page.locator('.ml-titlebar')).toHaveCount(0)
    await expect(page.getByTestId('nav-pill')).toHaveCount(0)
    await settingsSection(mergelane, 'Appearance')
    await expect(page.getByRole('radio', { name: /Liquid Glass/ })).toHaveCount(1)
  })
})
