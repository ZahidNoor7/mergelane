import { startFakeDaemon, type FakeDaemon } from './fakeDaemon'
import { expect, test } from './fixtures'

// The networks menu's System merge section against a fake mergelane-daemon (Phase 1 M1.4).
let fake: FakeDaemon
test.beforeEach(async () => {
  fake = await startFakeDaemon()
})
test.afterEach(async () => {
  await fake.close()
})

test.describe('System merge @smoke', () => {
  test('the switch turns merging on and off, and shows merged traffic', async ({ mergelane }) => {
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '1'
    })
    const page = mergelane.page
    await page.getByRole('button', { name: /^\d+ networks?$|^No network$/ }).click()
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
    await page.getByRole('button', { name: /^\d+ networks?$|^No network$/ }).click()
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
    await page.getByRole('button', { name: /^\d+ networks?$|^No network$/ }).click()
    const section = page.getByRole('region', { name: 'System merge' })
    await expect(section.getByText('Needs a one-time install of a small helper.')).toBeVisible()
    await section.getByRole('button', { name: 'Install' }).click()
    // A development build can't install (it has no bundled helper): it says so, in words.
    await expect(section.getByRole('alert')).toHaveText(/needs the packaged app/)
  })
})
