import { startFakeDaemon, type FakeDaemon } from './fakeDaemon'
import type { Locator } from '@playwright/test'
import { expect, test, type MergelaneApp } from './fixtures'

// The networks menu's System merge section against a fake mergelane-daemon (Phase 1 M1.4;
// helper updates, auto-resume and the failover history from M2.4).
let fake: FakeDaemon
test.beforeEach(async () => {
  fake = await startFakeDaemon()
})
test.afterEach(async () => {
  await fake.close()
})

/** Launches against the fake, opens the networks menu, and returns its System merge section. */
async function openSection(
  mergelane: MergelaneApp,
  env: Record<string, string> = {}
): Promise<Locator> {
  await mergelane.relaunch({
    MERGELANE_E2E_DAEMON_SOCKET: fake.path,
    MERGELANE_E2E_DAEMON_INSTALLED: '1',
    ...env
  })
  await mergelane.place('Networks')
  return mergelane.page.getByRole('region', { name: 'System merge' })
}

/** Times `seconds` before `now`, taken once so differences between two of them are exact. */
function before(now: number): (seconds: number) => string {
  return (seconds) => new Date(now - seconds * 1000).toISOString()
}

test.describe('System merge @smoke', () => {
  test('the switch turns merging on and off, and shows merged traffic', async ({ mergelane }) => {
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '1'
    })
    const page = mergelane.page
    await mergelane.place('Networks')
    const section = page.getByRole('region', { name: 'System merge' })
    const toggle = section.getByRole('switch', { name: 'System merge' })
    await expect(toggle).not.toBeChecked()
    await expect(section.getByRole('status')).toHaveText(/^Off\./)

    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(section.getByRole('status')).toHaveText(/^On\./)
    const traffic = section.getByRole('list', { name: 'Merged traffic per network' })
    await expect(traffic.getByText('feth10')).toBeVisible()
    await expect(traffic.getByText(/no internet/)).toBeVisible()
    expect(fake.requests.some((r) => r.method === 'enable')).toBe(true)

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    expect(fake.state).toBe('off')
    // A development build doesn't compare its version with the helper's ('fake' here).
    await expect(section.getByRole('group', { name: /out of date/ })).toHaveCount(0)
  })

  test('a refusal is shown in the daemon’s words', async ({ mergelane }) => {
    fake.refuseEnable = {
      code: 'VPN_ACTIVE',
      message:
        'Another VPN (utun4) is routing all IPv4 traffic. Turn it off to use system-wide merging.'
    }
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '1'
    })
    const page = mergelane.page
    await mergelane.place('Networks')
    const section = page.getByRole('region', { name: 'System merge' })
    await section.getByRole('switch', { name: 'System merge' }).click()
    await expect(section.getByRole('alert')).toHaveText(/Another VPN \(utun4\)/)
    await expect(section.getByRole('switch', { name: 'System merge' })).not.toBeChecked()
  })

  test('without the helper, it offers the install', async ({ mergelane }) => {
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: '/tmp/mlfd-none',
      MERGELANE_E2E_DAEMON_INSTALLED: '0'
    })
    const page = mergelane.page
    await mergelane.place('Networks')
    const section = page.getByRole('region', { name: 'System merge' })
    await expect(section.getByText('Needs a one-time install of a small helper.')).toBeVisible()
    // Not installed is a normal state, not an error.
    await expect(section.getByRole('alert')).toHaveCount(0)
    await section.getByRole('button', { name: 'Install' }).click()
    // A development build can't install (it has no bundled helper): it says so, in words.
    await expect(section.getByRole('alert')).toHaveText(/needs the packaged app/)
  })

  test('an outdated helper offers the update, which a development build can’t run', async ({
    mergelane
  }) => {
    fake.version = '0.0.9'
    const section = await openSection(mergelane, { MERGELANE_E2E_APP_VERSION: '0.2.0' })
    const banner = section.getByRole('group', { name: "Mergelane's helper is out of date" })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('The helper is 0.0.9; this app is 0.2.0.')
    // An outdated helper still merges.
    await expect(section.getByRole('switch', { name: 'System merge' })).toBeEnabled()

    await banner.getByRole('button', { name: 'Update' }).click()
    // The update is the same admin-prompt install, which needs the bundled helper.
    await expect(section.getByRole('alert')).toHaveText(/needs the packaged app/)
    await expect(banner).toBeVisible()
    expect(fake.requests.some((r) => r.method === 'enable' || r.method === 'disable')).toBe(false)
  })

  test('the matching helper is not flagged', async ({ mergelane }) => {
    fake.version = '0.2.0'
    const section = await openSection(mergelane, { MERGELANE_E2E_APP_VERSION: '0.2.0' })
    await expect(section.getByRole('status')).toHaveText(/^Off\./)
    await expect(section.getByRole('group', { name: /out of date/ })).toHaveCount(0)
  })

  test('the auto-resume switch reflects the helper and turns the setting on and off', async ({
    mergelane
  }) => {
    fake.autoResume = true
    const section = await openSection(mergelane)
    const autoResume = section.getByRole('switch', { name: 'Turn back on after a crash' })
    await expect(autoResume).toBeChecked()
    await expect(autoResume).toBeEnabled()
    await expect(section.getByText('After an unexpected stop, merging comes back on')).toBeVisible()

    await autoResume.click()
    await expect(autoResume).not.toBeChecked()
    expect(fake.autoResume).toBe(false)
    await autoResume.click()
    await expect(autoResume).toBeChecked()
    expect(fake.autoResume).toBe(true)
    expect(fake.requests.filter((r) => r.method === 'setAutoResume').map((r) => r.params)).toEqual([
      { enabled: false },
      { enabled: true }
    ])
    // It's a setting of its own: merging stayed off.
    expect(fake.state).toBe('off')
  })

  test('an older helper without auto-resume shows the switch disabled, with a note', async ({
    mergelane
  }) => {
    fake.legacy = true
    const section = await openSection(mergelane)
    const autoResume = section.getByRole('switch', { name: 'Turn back on after a crash' })
    await expect(autoResume).toBeDisabled()
    await expect(autoResume).not.toBeChecked()
    await expect(section.getByText('Needs the updated helper.')).toBeVisible()
    // Missing methods mark it out of date even in a development build.
    await expect(
      section.getByRole('group', { name: "Mergelane's helper is out of date" })
    ).toBeVisible()
    await autoResume.click({ force: true })
    expect(fake.requests.some((r) => r.method === 'setAutoResume')).toBe(false)
  })

  test('the failover history shows recent link drops and recoveries', async ({ mergelane }) => {
    const ago = before(Date.now())
    fake.state = 'on'
    const dropped = ago(150)
    fake.events = [
      { at: dropped, link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' },
      { at: ago(110), link: 'en5', from: 'down', to: 'up', reason: 'probe-ok' },
      { at: ago(20), link: 'en7', from: 'up', to: 'gone', reason: 'lost' }
    ]
    const section = await openSection(mergelane)
    const history = section.getByRole('list', { name: 'Recent network dropouts' })
    const rows = history.getByRole('listitem')
    await expect(rows).toHaveText([
      'en7 disconnected just now · still out',
      'en5 dropped 2 min ago · back after 40s'
    ])
    await expect(rows.nth(1).locator('time')).toHaveAttribute('datetime', dropped)

    // With merging off, only recent changes are worth showing.
    fake.state = 'off'
    fake.events = [
      { at: ago(3600), link: 'en5', from: 'up', to: 'down', reason: 'probe-failed' },
      { at: ago(3500), link: 'en5', from: 'down', to: 'up', reason: 'probe-ok' }
    ]
    await expect(history).toHaveCount(0)
    // With it on, older ones are shown too.
    fake.state = 'on'
    await expect(rows).toHaveText([/^en5 dropped .+ · back after 1m 40s$/])
  })
})
