import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, PROJECT_ROOT, test, type MergelaneApp } from './fixtures'

// Settings › Browser extensions (M3.4a, docs/DECISIONS.md ADR-0038), in the real app: it finds the
// browsers in an Applications folder of the test's own, readies the extension in Mergelane's folder
// and guides loading it. The Finder is never opened: the app notes what it would show.

let root: string
let applications: string
let build: string

test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mergelane-browsers-'))
  applications = join(root, 'Applications')
  for (const app of ['Google Chrome.app', 'Firefox.app', 'Brave Browser.app']) {
    mkdirSync(join(applications, app), { recursive: true })
  }
  build = join(root, 'extension')
  execFileSync('node', ['extension/build.mjs', build], { cwd: PROJECT_ROOT, stdio: 'inherit' })
})
test.afterAll(() => rmSync(root, { recursive: true, force: true }))

async function open(mergelane: MergelaneApp): Promise<void> {
  await mergelane.relaunch({
    MERGELANE_E2E_APPLICATIONS: applications,
    MERGELANE_E2E_EXTENSION_BUILD: build
  })
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Browser extensions' })
    .click()
}

test.describe('Browser extensions @smoke', () => {
  test('finds the browsers, readies the extension and guides loading it', async ({
    mergelane,
    dirs
  }) => {
    await open(mergelane)
    const page = mergelane.page
    const onMac = page.getByRole('list', { name: 'Browsers on this Mac' })
    await expect(onMac.getByRole('listitem')).toHaveText([
      /^Google Chrome.*Load the extension once, by hand/,
      /^Firefox.*temporary add-on/
    ])
    // Brave is on the Mac but not supported yet; Edge isn't on it.
    const others = page.getByRole('list', { name: 'Other browsers' })
    await expect(others.getByText(/^Not supported yet: Brave/)).toBeVisible()
    await expect(
      others.getByText('Not on this Mac. Install it, then scan again.').first()
    ).toBeVisible()

    // The extension, copied into Mergelane's folder for this version.
    const folder = join(dirs.userData, 'Browser Extension', 'chrome')
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
    expect(manifest.key).toBeTruthy()
    expect(existsSync(join(dirs.userData, 'Browser Extension', 'firefox', 'manifest.json'))).toBe(
      true
    )

    await onMac.getByRole('button', { name: 'Install…' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    await expect(dialog.getByText('chrome://extensions', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Show in Finder' }).click()
    await expect
      .poll(() =>
        mergelane.evaluateMain(
          () =>
            (
              (globalThis as Record<string, unknown>).__mergelaneTest as
                { revealed?: string[] } | undefined
            )?.revealed,
          null
        )
      )
      .toEqual([join(folder, 'manifest.json')])
  })

  test('Scan again finds a browser installed meanwhile', async ({ mergelane }) => {
    await open(mergelane)
    const page = mergelane.page
    const onMac = page.getByRole('list', { name: 'Browsers on this Mac' })
    await expect(onMac.getByRole('listitem')).toHaveCount(2)
    mkdirSync(join(applications, 'Microsoft Edge.app'))
    try {
      await page.getByRole('button', { name: 'Scan again' }).click()
      await expect(onMac.getByRole('listitem')).toHaveCount(3)
      await expect(onMac.getByText('Microsoft Edge')).toBeVisible()
    } finally {
      rmSync(join(applications, 'Microsoft Edge.app'), { recursive: true, force: true })
    }
  })
})
