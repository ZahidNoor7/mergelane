import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { startFakeDaemon, type FakeDaemon } from './fakeDaemon'
import { BLOCK, expect, interfacesEnv, NETWORKS, test, type MergelaneApp } from './fixtures'
import type { NetworkActivity } from '../src/shared/networkActivity'

// M3.7 (docs/DECISIONS.md ADR-0042): the diagnostics bundle, saved from Settings › General and from the
// app menu through a stubbed save dialog (never the real one, never ~/Downloads), unzipped and
// searched for everything it must not hold; and the network dropouts and the day's fastest merged
// speed surviving a relaunch.

let fake: FakeDaemon
let scratch: string
test.beforeEach(async () => {
  fake = await startFakeDaemon()
  scratch = await mkdtemp(join(tmpdir(), 'mergelane-diag-'))
})
test.afterEach(async () => {
  await fake.close()
  await rm(scratch, { recursive: true, force: true })
})

const TOKEN = 'e2e-s3cr3t-token'
const FILE = 'tax-return-e2e-private.bin'
/** Everything planted below that a bundle must not hold. */
const SECRETS = [
  TOKEN,
  'tax-return-e2e-private',
  'Secret Hotspot Name',
  'proxy.secret.example',
  'proxy-user-e2e',
  'proxy-pass-e2e',
  '203.0.113.99',
  homedir(),
  userInfo().username
]

/** The next save dialog answers `path` (or is cancelled); the Finder is never opened. */
async function stubDialog(mergelane: MergelaneApp, path: string | null): Promise<void> {
  await mergelane.evaluateMain(({ dialog, shell }, target) => {
    const store = globalThis as Record<string, unknown>
    store.__saveDialogs = 0
    dialog.showSaveDialog = (async () => {
      store.__saveDialogs = (store.__saveDialogs as number) + 1
      return target === null
        ? { canceled: true, filePath: '' }
        : { canceled: false, filePath: target }
    }) as never
    const revealed: string[] = []
    store.__revealed = revealed
    shell.showItemInFolder = (shown: string) => void revealed.push(shown)
  }, path)
}

/** Every file of the zip at `zip`, by its path inside it, unzipped with macOS's own ditto. */
async function unzip(zip: string): Promise<Record<string, string>> {
  const out = await mkdtemp(join(scratch, 'unzipped-'))
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
  const files: Record<string, string> = {}
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`)
      else files[`${prefix}${entry.name}`] = await readFile(path, 'utf-8')
    }
  }
  await walk(out, '')
  return files
}

test('Save Diagnostics… writes a redacted zip where the user chose, from Settings and the app menu', async ({
  mergelane,
  serve,
  dirs
}) => {
  const helperLog = join(scratch, 'daemon.log')
  await writeFile(
    helperLog,
    `old line\nmergelane-daemon 0.2.0 listening (merging off)\nflow to 203.0.113.99 for ${homedir()}/x\n`
  )
  await mergelane.relaunch({
    MERGELANE_E2E_DAEMON_SOCKET: fake.path,
    MERGELANE_E2E_DAEMON_INSTALLED: '1',
    MERGELANE_E2E_HELPER_LOG: helperLog
  })

  // A finished download whose link carries a token and whose name is private.
  const origin = await serve({ size: 4 * BLOCK })
  await mergelane.start(origin.url(`/files/${FILE}?token=${TOKEN}`), origin.sha256)
  await mergelane.waitForHttpStatus('completed')
  // A renamed network with a proxy that signs in.
  await mergelane.api.updateSettings({
    networkPreferences: {
      a: {
        customName: 'Secret Hotspot Name',
        proxy: {
          enabled: false,
          type: 'http',
          host: 'proxy.secret.example',
          port: 3128,
          username: 'proxy-user-e2e',
          password: 'proxy-pass-e2e'
        }
      }
    },
    destinationDir: dirs.dest
  })

  const first = join(scratch, 'first-bundle.zip')
  await stubDialog(mergelane, first)
  const page = mergelane.page
  await mergelane.openSettings()
  const group = page.getByRole('region', { name: 'Troubleshooting' })
  await group.getByRole('button', { name: 'Save Diagnostics…' }).click()
  await expect(group.getByRole('status')).toHaveText('Saved as first-bundle.zip.')
  await group.getByRole('button', { name: 'Show in Finder' }).click()
  await expect
    .poll(() =>
      mergelane.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
    )
    .toEqual([first])

  const files = await unzip(first)
  const names = Object.keys(files).sort()
  expect(names).toHaveLength(3)
  const folder = names[0].split('/')[0]
  expect(folder).toMatch(/^Mergelane-Diagnostics-\d{4}-\d{2}-\d{2}-\d{4}$/)
  expect(names).toEqual([
    `${folder}/README.txt`,
    `${folder}/diagnostics.json`,
    `${folder}/helper-log.txt`
  ])
  const everything = Object.values(files).join('\n')
  for (const secret of SECRETS)
    expect(everything, `the bundle holds ${secret}`).not.toContain(secret)

  const report = JSON.parse(files[`${folder}/diagnostics.json`])
  expect(report.app.electron).toBe(
    await mergelane.evaluateMain(() => process.versions.electron, null)
  )
  expect(report.system).toMatchObject({ platform: 'darwin', arch: process.arch })
  expect(report.helper).toMatchObject({ installed: true, reachable: true, state: 'off' })
  expect(report.networks.map((network: { id: string }) => network.id)).toEqual(
    Object.keys(NETWORKS)
  )
  expect(report.networks[0].addresses).toEqual([{ family: 4, scope: 'loopback' }])
  expect(report.settings.networks.a).toMatchObject({
    renamed: true,
    proxy: { enabled: false, type: 'http', signIn: true }
  })
  expect(report.history.newest[0]).toMatchObject({
    kind: 'http',
    status: 'completed',
    site: origin.url('/').replace(/\/$/, '/…'),
    fileType: 'bin',
    bytesDownloaded: 4 * BLOCK
  })
  expect(files[`${folder}/helper-log.txt`]).toBe(
    'old line\nmergelane-daemon 0.2.0 listening (merging off)\nflow to <ip> for ~/…\n'
  )
  expect(files[`${folder}/README.txt`]).toContain('Mergelane never sends this anywhere')

  // The app menu's Save Diagnostics… goes through the same row.
  const second = join(scratch, 'from-menu')
  await stubDialog(mergelane, second)
  await mergelane.place('Downloads')
  await mergelane.evaluateMain(({ Menu }) => {
    Menu.getApplicationMenu()!.getMenuItemById('save-diagnostics')!.click()
  }, null)
  await expect(group.getByRole('status')).toHaveText('Saved as from-menu.zip.')
  expect((await stat(`${second}.zip`)).size).toBeGreaterThan(0)

  // Cancelled: nothing written, and what was said before stays.
  await stubDialog(mergelane, null)
  await group.getByRole('button', { name: 'Save Diagnostics…' }).click()
  await expect
    .poll(() =>
      mergelane.evaluateMain(() => (globalThis as Record<string, unknown>).__saveDialogs, null)
    )
    .toBe(1)
  await expect(group.getByRole('status')).toHaveText('Saved as from-menu.zip.')
  // (The download's folder is checked by the fixture: the bundles went elsewhere.)
  expect((await readdir(scratch)).filter((name) => name.endsWith('.zip')).sort()).toEqual([
    'first-bundle.zip',
    'from-menu.zip'
  ])

  // A folder it can't write to: the user is told, and nothing is left behind.
  await stubDialog(mergelane, join(scratch, 'no-such-folder', 'x.zip'))
  await group.getByRole('button', { name: 'Save Diagnostics…' }).click()
  await expect(group.getByRole('status')).toHaveText(
    'The diagnostics couldn’t be saved there. Choose another folder.'
  )
  // Every bundle is put together in a temporary folder, removed once it's copied (or not).
  const temp = await mergelane.evaluateMain(({ app }) => app.getPath('temp'), null)
  expect((await readdir(temp)).filter((name) => name.startsWith('mergelane-diagnostics-'))).toEqual(
    []
  )
})

const networkActivity = (mergelane: MergelaneApp): Promise<NetworkActivity> =>
  mergelane.api.networkActivity() as Promise<NetworkActivity>

test('dropouts and the day’s fastest merged speed survive a relaunch', async ({
  mergelane,
  serve
}) => {
  // A steady download of about ten seconds: five held make the day's fastest merged speed.
  const origin = await serve({ size: 96 * BLOCK, bytesPerSecond: 256 * 1024 })
  await mergelane.start(origin.url(), origin.sha256)
  await mergelane.waitForHttpStatus('completed')
  await expect
    .poll(async () => (await networkActivity(mergelane)).fastest?.bytesPerSec ?? 0, {
      timeout: 15_000
    })
    .toBeGreaterThan(0)
  const fastest = (await networkActivity(mergelane)).fastest

  // Network a drops.
  await mergelane.evaluateMain((_electron, value) => {
    process.env['MERGELANE_E2E_INTERFACES'] = value
  }, interfacesEnv({}))
  await expect
    .poll(async () => (await networkActivity(mergelane)).events.map((event) => event.change))
    .toEqual(Object.keys(NETWORKS).map(() => 'dropped'))
  await mergelane.place('Networks')
  const log = mergelane.page.getByRole('log', { name: 'Recent network dropouts' })
  await expect(log.getByRole('listitem').first()).toContainText('dropped')

  // Quit and open again, with the networks back: the drop is still there, and they came back while
  // Mergelane was closed.
  await mergelane.relaunch()
  const after = await networkActivity(mergelane)
  expect(after.fastest).toEqual(fastest)
  await expect
    .poll(async () => (await networkActivity(mergelane)).events.map((event) => event.change))
    .toEqual([
      ...Object.keys(NETWORKS).map(() => 'dropped'),
      ...Object.keys(NETWORKS).map(() => 'recovered')
    ])
  await mergelane.place('Networks')
  const relaunched = mergelane.page.getByRole('log', { name: 'Recent network dropouts' })
  await expect(relaunched.getByRole('listitem').first()).toContainText(
    'came back while Mergelane was closed'
  )
  await expect(relaunched.getByRole('listitem').last()).toContainText('dropped')

  await mergelane.place('Dashboard')
  const today = mergelane.page.getByRole('region', { name: 'Today' })
  const dropouts = Object.keys(NETWORKS).length
  await expect(
    today.getByText('Network dropouts').locator('xpath=following-sibling::dd')
  ).toHaveText(`${dropouts}, all back`)
  await expect(
    today.getByText('Fastest merged speed').locator('xpath=following-sibling::dd')
  ).not.toHaveText('—')
})
