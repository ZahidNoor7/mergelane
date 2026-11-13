import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, PROJECT_ROOT, test, type MergelaneApp } from './fixtures'

// Settings › Browser extensions (M3.4a, docs/DECISIONS.md ADR-0038 and ADR-0047), in the real app: it
// finds the browsers in an Applications folder of the test's own, saves the extension where the user
// can find it (a test run's own Downloads, never the computer's) and guides loading it. The Finder is
// never opened and no browser starts: the app notes what it would have done.

/** The app's version: what a saved extension folder is stamped with. */
const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
  .version as string

/** What the app noted instead of showing a Finder window or opening a browser. */
const recorded = (mergelane: MergelaneApp, kind: string): Promise<unknown> =>
  mergelane.evaluateMain(
    (_electron, key) =>
      (
        (globalThis as Record<string, unknown>).__mergelaneTest as
          Record<string, unknown> | undefined
      )?.[key],
    kind
  )

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
  test('finds the browsers, saves the extension where the user can find it on Install, and guides loading it', async ({
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

    // Where it goes: Downloads (a test run's own). Opening Settings saves nothing.
    const location = join(dirs.userData, 'Test Downloads')
    await expect(page.getByText(location, { exact: true })).toBeVisible()
    expect(existsSync(location)).toBe(false)
    expect(existsSync(join(dirs.userData, 'Browser Extension'))).toBe(false)

    // Install saves it, for this version, and guides loading it from there.
    await onMac.getByRole('button', { name: 'Install…' }).first().click()
    const folder = join(location, 'Mergelane Extension')
    const dialog = page.getByRole('dialog', { name: 'Add Mergelane to Chrome' })
    await expect(dialog.getByText(folder, { exact: true })).toBeVisible()
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
    expect(manifest.key).toBeTruthy()
    expect(await readFile(join(folder, '.mergelane-version'), 'utf8')).toBe(VERSION)
    expect(existsSync(join(location, 'Mergelane Extension for Firefox'))).toBe(false)
    await expect(dialog.getByText('chrome://extensions', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Show in Finder' }).click()
    await expect.poll(() => recorded(mergelane, 'revealed')).toEqual([folder])
    await dialog.getByRole('button', { name: 'Open Chrome' }).click()
    await expect
      .poll(() => recorded(mergelane, 'openedBrowser'))
      .toEqual([join(applications, 'Google Chrome.app')])
    await dialog.getByRole('button', { name: 'Close' }).last().click()

    // Another folder: the next install goes there, and both are kept up to date.
    const desktop = join(dirs.userData, 'Desktop')
    mkdirSync(desktop)
    await mergelane.evaluateMain(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
    }, desktop)
    await page.getByRole('button', { name: 'Change…' }).click()
    await expect(page.getByText(desktop, { exact: true })).toBeVisible()
    await onMac.getByRole('button', { name: 'Install…' }).last().click()
    const firefox = join(desktop, 'Mergelane Extension for Firefox')
    await expect(
      page
        .getByRole('dialog', { name: 'Add Mergelane to Firefox' })
        .getByText(firefox, { exact: true })
    ).toBeVisible()
    expect(existsSync(join(firefox, 'manifest.json'))).toBe(true)
    const settings = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    expect(settings.extensionLocation).toBe(desktop)
    expect(settings.extensionCopies).toEqual([
      { kind: 'chrome', path: folder },
      { kind: 'firefox', path: firefox }
    ])
  })

  test('every saved copy is brought up to date at launch; a folder Mergelane didn’t make is left alone', async ({
    mergelane,
    dirs
  }) => {
    await open(mergelane)
    const page = mergelane.page
    const onMac = page.getByRole('list', { name: 'Browsers on this Mac' })
    await onMac.getByRole('button', { name: 'Install…' }).first().click()
    const folder = join(dirs.userData, 'Test Downloads', 'Mergelane Extension')
    await expect(page.getByRole('dialog')).toBeVisible()
    // From an older Mergelane: the one saved now, and one in the folder it used before.
    const earlier = join(dirs.userData, 'Browser Extension', 'chrome')
    mkdirSync(earlier, { recursive: true })
    for (const old of [folder, earlier]) {
      writeFileSync(join(old, '.mergelane-version'), '0.0.1')
      writeFileSync(join(old, 'left-over.js'), '')
    }
    await mergelane.relaunch({
      MERGELANE_E2E_APPLICATIONS: applications,
      MERGELANE_E2E_EXTENSION_BUILD: build
    })
    for (const updated of [folder, earlier]) {
      // Polled from launch: for an instant while the new copy is swapped in, the folder isn't there.
      await expect
        .poll(() => readFile(join(updated, '.mergelane-version'), 'utf8').catch(() => 'missing'))
        .toBe(VERSION)
      expect(existsSync(join(updated, 'left-over.js'))).toBe(false)
      expect(existsSync(join(updated, 'manifest.json'))).toBe(true)
    }

    // A folder of that name the user made: Install says so and doesn't touch it.
    const theirs = join(dirs.userData, 'Test Downloads', 'Mergelane Extension for Firefox')
    mkdirSync(theirs)
    writeFileSync(join(theirs, 'notes.txt'), 'mine')
    await open(mergelane)
    await mergelane.page
      .getByRole('list', { name: 'Browsers on this Mac' })
      .getByRole('button', { name: 'Install…' })
      .last()
      .click()
    await expect(mergelane.page.getByRole('dialog').getByRole('alert')).toHaveText(
      '“Test Downloads” already has a folder named “Mergelane Extension for Firefox” that Mergelane didn’t make. Move it, or choose another folder for the extension.'
    )
    expect(await readdir(theirs)).toEqual(['notes.txt'])
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
