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
    // Nothing to remove.
    await expect(section.getByRole('button', { name: /Remove helper/ })).toHaveCount(0)
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

  test('at launch, the sidebar offers an outdated helper’s update (ADR-0051)', async ({
    mergelane
  }) => {
    fake.version = '0.3.2'
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '1',
      MERGELANE_E2E_APP_VERSION: '0.3.3'
    })
    const page = mergelane.page
    // Straight away, on whatever screen Mergelane opens to.
    const notice = page.getByRole('status', { name: 'Helper update' })
    await expect(notice).toContainText('Update the helper to match Mergelane 0.3.3.')
    await expect(notice).toContainText('Your Mac asks for your password.')
    // One click runs the same install as Networks' Update (a development build has no helper to install).
    await notice.getByRole('button', { name: 'Update…' }).click()
    await expect(notice).toContainText(/needs the packaged app/)
    // Networks says the same with more, so the sidebar leaves it to it; Later lets it go for this launch.
    await mergelane.place('Networks')
    await expect(notice).toHaveCount(0)
    await expect(
      page
        .getByRole('region', { name: 'System merge' })
        .getByRole('group', { name: "Mergelane's helper is out of date" })
    ).toBeVisible()
    await mergelane.place('Downloads')
    await notice.getByRole('button', { name: 'Later' }).click()
    await expect(notice).toHaveCount(0)
  })

  test('no helper update is offered when it matches, or isn’t installed', async ({ mergelane }) => {
    fake.version = '0.3.3'
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '1',
      MERGELANE_E2E_APP_VERSION: '0.3.3'
    })
    await expect(mergelane.page.getByRole('navigation').first()).toBeVisible()
    await expect.poll(() => fake.requests.some((r) => r.method === 'status')).toBe(true)
    await expect(mergelane.page.getByRole('status', { name: 'Helper update' })).toHaveCount(0)
    fake.version = '0.1.0'
    await mergelane.relaunch({
      MERGELANE_E2E_DAEMON_SOCKET: fake.path,
      MERGELANE_E2E_DAEMON_INSTALLED: '0',
      MERGELANE_E2E_APP_VERSION: '0.3.3'
    })
    await expect(mergelane.page.getByRole('navigation').first()).toBeVisible()
    await expect(mergelane.page.getByRole('status', { name: 'Helper update' })).toHaveCount(0)
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

  test('keeps each site on one network by default, and turns it off and on', async ({
    mergelane
  }) => {
    const section = await openSection(mergelane)
    const sticky = section.getByRole('switch', { name: 'Keep each site on one network' })
    await expect(sticky).toBeChecked()
    await expect(sticky).toBeEnabled()
    await expect(section.getByText(/Sign-ins and calls stay steady/)).toBeVisible()
    await sticky.click()
    await expect(sticky).not.toBeChecked()
    expect(fake.stickySites).toBe(false)
    await sticky.click()
    await expect(sticky).toBeChecked()
    expect(fake.requests.filter((r) => r.method === 'setStickySites').map((r) => r.params)).toEqual(
      [{ enabled: false }, { enabled: true }]
    )
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
    await expect(section.getByText('Needs the updated helper.')).toHaveCount(2)
    await expect(
      section.getByRole('switch', { name: 'Keep each site on one network' })
    ).toBeDisabled()
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

// "Remove helper…" (ADR-0046). MERGELANE_E2E_ADMIN_PROMPT answers the administrator password
// prompt: the app records the osascript command it would run and runs nothing, so no test here
// asks for a password, runs the helper's uninstall, or touches /Library.

/** The osascript commands the app would have run, from the main process's test record. */
function adminCommands(mergelane: MergelaneApp): Promise<string[][]> {
  return mergelane
    .evaluateMain(
      () =>
        (((globalThis as Record<string, unknown>).__mergelaneTest ?? {}) as Record<string, unknown>)
          .adminCommands as string[][] | undefined,
      null
    )
    .then((recorded) => recorded ?? [])
}

/** Opens the confirmation from the section, and confirms. */
async function confirmRemoval(section: Locator): Promise<void> {
  await section.getByRole('button', { name: 'Remove helper…' }).click()
  const dialog = section.page().getByRole('alertdialog', { name: "Remove Mergelane's helper?" })
  await expect(dialog).toContainText(
    "System merge turns off, and can't be used until you install the helper again."
  )
  await expect(dialog).toContainText('Your Mac asks for your administrator password.')
  await expect(dialog).toContainText('Downloads keep working on every network.')
  await dialog.getByRole('button', { name: 'Remove helper' }).click()
  await expect(dialog).toHaveCount(0)
}

test.describe('Remove helper @smoke', () => {
  test('turns merging off, runs the helper’s uninstall through the password prompt, and offers the install again', async ({
    mergelane
  }) => {
    fake.state = 'on'
    const section = await openSection(mergelane, { MERGELANE_E2E_ADMIN_PROMPT: 'allow' })
    await expect(section.getByRole('status')).toHaveText(/^On\./)
    const resources = await mergelane.evaluateMain(() => process.resourcesPath, null)
    await confirmRemoval(section)

    await expect(
      section.getByText('Helper removed. Install it again to use system merge.')
    ).toBeVisible()
    const binary = `${resources}/mergelane-daemon`
    // One command, exactly: osascript with one -e line, the bundled binary's path single-quoted for
    // the shell (this checkout's path has a space in it), and `uninstall`.
    expect(binary).toContain(' ')
    expect(await adminCommands(mergelane)).toEqual([
      [
        '/usr/bin/osascript',
        '-e',
        `do shell script "'${binary}' uninstall" with administrator privileges`
      ]
    ])
    // Merging was turned off first, and never back on.
    const methods = fake.requests.map((r) => r.method)
    expect(methods).toContain('disable')
    expect(methods.lastIndexOf('enable')).toBeLessThan(methods.indexOf('disable'))
    expect(fake.state).toBe('off')

    // The helper is gone (as macOS would now report it): the section offers the install again.
    await mergelane.evaluateMain(() => {
      process.env.MERGELANE_E2E_DAEMON_INSTALLED = '0'
    }, null)
    await fake.close()
    await expect(section.getByRole('button', { name: 'Install' })).toBeVisible()
    await expect(section.getByRole('button', { name: /Remove helper/ })).toHaveCount(0)
    await expect(
      section.getByText('Helper removed. Install it again to use system merge.')
    ).toBeVisible()
    fake = await startFakeDaemon()
  })

  test('Cancel in the confirmation does nothing', async ({ mergelane }) => {
    fake.state = 'on'
    const section = await openSection(mergelane, { MERGELANE_E2E_ADMIN_PROMPT: 'allow' })
    await section.getByRole('button', { name: 'Remove helper…' }).click()
    const dialog = mergelane.page.getByRole('alertdialog', { name: "Remove Mergelane's helper?" })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await adminCommands(mergelane)).toEqual([])
    expect(fake.requests.some((r) => r.method === 'disable')).toBe(false)
    expect(fake.state).toBe('on')
  })

  test('a dismissed password prompt says so, and merging comes back on', async ({ mergelane }) => {
    fake.state = 'on'
    const section = await openSection(mergelane, { MERGELANE_E2E_ADMIN_PROMPT: 'cancel' })
    await confirmRemoval(section)
    await expect(
      section.getByText('Removal canceled. The helper is still installed.')
    ).toBeVisible()
    expect(await adminCommands(mergelane)).toHaveLength(1)
    const methods = fake.requests
      .map((r) => r.method)
      .filter((m) => m === 'disable' || m === 'enable')
    expect(methods).toEqual(['disable', 'enable'])
    await expect(section.getByRole('switch', { name: 'System merge' })).toBeChecked()
    await expect(section.getByRole('button', { name: 'Remove helper…' })).toBeEnabled()
  })

  test('a failed removal shows the reason', async ({ mergelane }) => {
    const section = await openSection(mergelane, {
      MERGELANE_E2E_ADMIN_PROMPT: 'fail:error: launchd: launchctl bootout: Operation not permitted'
    })
    await confirmRemoval(section)
    await expect(section.getByRole('alert')).toHaveText(
      "Couldn't remove the helper: error: launchd: launchctl bootout: Operation not permitted"
    )
    expect(await adminCommands(mergelane)).toHaveLength(1)
    // Merging was off: nothing to turn off or back on.
    expect(fake.requests.some((r) => r.method === 'disable' || r.method === 'enable')).toBe(false)
  })

  test('a development build without the test prompt says it needs the packaged app', async ({
    mergelane
  }) => {
    const section = await openSection(mergelane)
    await confirmRemoval(section)
    await expect(section.getByRole('alert')).toHaveText(
      'Removing the helper needs the packaged app.'
    )
    expect(await adminCommands(mergelane)).toEqual([])
    expect(fake.requests.some((r) => r.method === 'disable')).toBe(false)
  })
})
