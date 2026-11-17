import type { Page } from '@playwright/test'
import { BLOCK, expect, test, type MergelaneApp } from './fixtures'

// Every speed in the unit chosen, and only in it (ADR-0071, ADR-0072): with a slow download running (where MB/s
// used to drop to KB/s), each unit is chosen in Settings, and then every place that shows a speed is read: the
// Dashboard, the downloads list, the download's details, Networks, the menu bar item and its menu. Any other unit
// on them fails the test.

/** Every speed unit the page's text says, once each. SpeedText sets its unit apart, without a space. */
async function unitsOn(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText)
  const found =
    text.match(/(?<![A-Za-z])(KB\/s|MB\/s|GB\/s|B\/s|Mbps|Kbps|Gbps|bps)(?![A-Za-z])/g) ?? []
  return [...new Set(found)]
}

const LABEL = { kb: 'KB/s', bytes: 'MB/s', bits: 'Mbps' } as const

async function choose(mergelane: MergelaneApp, unit: keyof typeof LABEL): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'General' })
    .click()
  await mergelane.page
    .getByRole('group', { name: 'Speed units' })
    .getByRole('button', { name: LABEL[unit] })
    .click()
}

test.describe('Speed units @smoke', () => {
  test('every speed, everywhere, is in the unit chosen and only that unit', async ({
    mergelane,
    serve
  }) => {
    test.skip(process.platform !== 'darwin', 'the menu bar is macOS’s')
    // About 0.3 MB/s: under 1 MB/s, where a unit used to change by itself.
    const origin = await serve({ size: 512 * BLOCK, bytesPerSecond: 300_000 })
    const id = await mergelane.start(origin.url(), origin.sha256, { connections: 1 })
    await mergelane.waitForHttpStatus('downloading')
    await mergelane.api.updateSettings({ menuBarSpeedText: 'on' })
    const page = mergelane.page

    for (const unit of ['bytes', 'kb', 'bits'] as const) {
      await choose(mergelane, unit)
      const label = LABEL[unit]

      await mergelane.place('Dashboard')
      // Something is moving, so speeds are on the page.
      await expect(page.getByText(/^Includes .+ of downloads$/)).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => unitsOn(page), { timeout: 15_000 }).toEqual([label])

      await mergelane.place('Downloads')
      await expect(page.getByText('Download speed', { exact: true })).toBeVisible()
      await expect.poll(() => unitsOn(page)).toEqual([label])

      // The download's own details.
      await page.getByRole('button', { name: 'test.bin' }).first().click()
      await expect.poll(() => unitsOn(page)).toEqual([label])
      await page.keyboard.press('Escape')

      await mergelane.place('Networks')
      await expect.poll(() => unitsOn(page)).toEqual([label])

      // The menu bar item, said in the main process.
      await expect
        .poll(async () =>
          mergelane.evaluateMain(
            () =>
              (
                (globalThis as Record<string, unknown>).__mergelaneTest as {
                  menuBar?: { title: string }
                }
              ).menuBar?.title ?? '',
            null
          )
        )
        .toMatch(new RegExp(` ${label.replace('/', '\\/')}$`))
    }

    // The menu under the icon, in the last unit chosen.
    const made = mergelane.electronApp.waitForEvent('window')
    await mergelane.evaluateMain(() => {
      ;(
        globalThis as unknown as { __mergelaneMenuBar: { click(): void } }
      ).__mergelaneMenuBar.click()
    }, null)
    const menu = await made
    await menu.waitForLoadState('domcontentloaded')
    await expect.poll(() => unitsOn(menu), { timeout: 10_000 }).toEqual(['Mbps'])
    await mergelane.api.cancelDownload(id)
  })
})
