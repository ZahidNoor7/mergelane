import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SCHEDULE } from '../src/shared/downloadSchedule'
import { BLOCK, expect, test, type MergelaneApp } from './fixtures'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'
import { seededBytes, sha256 } from './origin'

const schedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true }
const at = (day: number, hour: number): number => new Date(2000, 0, day, hour).getTime()

async function clock(mergelane: MergelaneApp, now: number, wake = true): Promise<void> {
  await mergelane.evaluateMain(
    ({ powerMonitor }, value) => {
      Date.now = () => value.now
      if (value.wake) powerMonitor.emit('resume')
    },
    { now, wake }
  )
}

test('scheduled queue holds new downloads and manual resumes; manually paused downloads stay paused @smoke', async ({
  mergelane,
  serve
}) => {
  await clock(mergelane, at(1, 8))
  await mergelane.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const first = await mergelane.start(origin.url('/first'), origin.sha256)
  const second = await mergelane.start(origin.url('/second'), origin.sha256)
  expect((await mergelane.byId(first))?.status).toBe('queued')
  expect((await mergelane.byId(second))?.bytesDownloaded).toBe(0)
  await mergelane.api.pauseDownload(first)
  await mergelane.api.resumeDownload(first)
  await expect.poll(async () => (await mergelane.byId(first))?.status).toBe('queued')
  await mergelane.api.pauseDownload(first)
  await clock(mergelane, at(2, 0))
  await expect.poll(async () => (await mergelane.byId(second))?.status).toBe('completed')
  expect((await mergelane.byId(first))?.status).toBe('paused')
  await mergelane.api.resumeDownload(first)
  await expect.poll(async () => (await mergelane.byId(first))?.status).toBe('completed')
})

test('the clock cutoff stops active HTTP transfers, preserves progress, and blocks queue draining @smoke', async ({
  mergelane,
  serve
}) => {
  await clock(mergelane, at(1, 0))
  await mergelane.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await mergelane.start(origin.url(), origin.sha256)
  await held
  const next = await mergelane.start(origin.url('/next'), origin.sha256)
  // No wake event: the main-process timer must enforce the cutoff itself.
  await clock(mergelane, at(1, 7), false)
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('queued')
  const stopped = await mergelane.byId(id)
  expect(stopped?.bytesDownloaded).toBeGreaterThan(0)
  expect(stopped?.speedBytesPerSec).toBe(0)
  expect((await mergelane.byId(next))?.bytesDownloaded).toBe(0)
  origin.release()
  await clock(mergelane, at(2, 0))
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
  await expect.poll(async () => (await mergelane.byId(next))?.status).toBe('completed')
})

test('scheduled intent survives restart, while expiration stays blocked until disabled @smoke', async ({
  mergelane,
  serve
}) => {
  await clock(mergelane, at(1, 8))
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 16 * BLOCK })
  const id = await mergelane.start(origin.url(), origin.sha256)
  await mergelane.relaunch()
  expect((await mergelane.byId(id))?.status).toBe('queued')
  expect((await mergelane.byId(id))?.bytesDownloaded).toBe(0)
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
})

test('a restart inside the window continues scheduled work @smoke', async ({
  mergelane,
  serve
}) => {
  const minute = new Date().getHours() * 60 + new Date().getMinutes()
  const open = { ...schedule, startMinute: (minute + 1420) % 1440, endMinute: (minute + 20) % 1440 }
  await mergelane.api.updateSettings({ downloadSchedule: open })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await mergelane.start(origin.url(), origin.sha256)
  await held
  await mergelane.quit()
  origin.release()
  await mergelane.launch()
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
})

test('the cutoff stops torrent peers and uploads; reopening finishes the same file @smoke', async ({
  mergelane
}) => {
  const swarm = await new Swarm().start()
  try {
    await clock(mergelane, at(1, 0))
    await mergelane.api.updateSettings({ downloadSchedule: schedule, speedLimit: 128 * 1024 })
    const data = seededBytes(2 * 1024 * 1024, 32)
    const torrent = await swarm.seed([named(data, 'scheduled.bin')], { pieceLength: 64 * 1024 })
    const id = await mergelane.start(await torrentFileOnDisk(torrent), sha256(data))
    await mergelane.waitUntil((state) => state.bytesDownloaded > 0)
    await clock(mergelane, at(1, 7))
    await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('queued')
    // Saving a closed window waits for the client to finish closing.
    await mergelane.api.updateSettings({ downloadSchedule: schedule })
    const stopped = await mergelane.byId(id)
    expect(stopped?.speedBytesPerSec).toBe(0)
    if (stopped?.kind === 'torrent') expect(stopped.uploadSpeedBytesPerSec).toBe(0)
    await clock(mergelane, at(2, 0))
    await mergelane.api.updateSettings({ speedLimit: undefined })
    await expect
      .poll(async () => (await mergelane.byId(id))?.status, { timeout: 30_000 })
      .toBe('completed')
  } finally {
    await swarm.stop()
  }
})

async function openSchedule(mergelane: MergelaneApp): Promise<void> {
  await mergelane.place('Networks')
  await mergelane.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
  await mergelane.page.getByRole('region', { name: 'Download schedule' }).scrollIntoViewIfNeeded()
}

async function chooseTime(mergelane: MergelaneApp, label: string, time: string): Promise<void> {
  const [hour, minute] = time.split(':')
  for (const [part, value] of [
    ['hour', hour],
    ['minute', minute]
  ]) {
    await mergelane.page
      .getByRole('spinbutton', { name: `${label} ${part}`, exact: true })
      .fill(value)
  }
}

test('schedule dialog saves, cancels edits, validates times, and restores settings @smoke', async ({
  mergelane
}, testInfo) => {
  const page = mergelane.page
  // The indicator is in the Downloads place's header (where the app opens); the schedule's state
  // is also at the sidebar's foot, in every place. Which of its two messages shows depends on the
  // time of day the test runs, so either is accepted.
  const indicator = page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  const sidebarSchedule = page.getByText(/^(Downloads stop at|Waiting until) /)
  await expect(indicator).toBeHidden()
  await expect(sidebarSchedule).toBeHidden()
  await openSchedule(mergelane)
  const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('group', { name: 'Start at', exact: true })).toBeHidden()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(mergelane, 'Start at', '00:00')
  await chooseTime(mergelane, 'Stop at', '00:00')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await chooseTime(mergelane, 'Stop at', '07:00')
  await expect(dialog.locator('input[type="date"], input[type="time"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Mon', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await chooseTime(mergelane, 'Stop at', '07:13')
  await chooseTime(mergelane, 'Stop at', '07:00')
  await dialog.getByRole('button', { name: 'End date', exact: true }).click()
  const calendar = page.getByRole('dialog', { name: 'Choose end date' })
  await calendar.getByRole('button', { name: 'Go to the next month' }).click()
  await page.screenshot({ path: test.info().outputPath('schedule-calendar.png') })
  // Choose a day in the displayed month, excluding the adjacent months' trailing dates.
  await calendar
    .locator('[data-slot="calendar"] td:not([data-outside]) button')
    .filter({ hasText: /^15$/ })
    .click()
  const endDateLabel = await dialog
    .getByRole('button', { name: 'End date', exact: true })
    .innerText()
  await testInfo.attach('schedule-dialog.png', {
    body: await page.screenshot({ path: test.info().outputPath('schedule-dialog.png') }),
    contentType: 'image/png'
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  // Saved from the Networks place, which has no indicator: the sidebar says it at once.
  await expect(sidebarSchedule).toBeVisible()
  await mergelane.place('Downloads')
  await expect(indicator).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('schedule-toolbar.png') })
  await indicator.click()
  await expect(dialog.getByRole('switch', { name: 'Enable download schedule' })).toBeFocused()
  await expect(dialog.getByRole('region', { name: 'Download schedule' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'End date', exact: true })).toBeInViewport({
    ratio: 1
  })
  await chooseTime(mergelane, 'Stop at', '09:00')
  await dialog.getByRole('navigation').getByRole('button').nth(1).click()
  await dialog.getByRole('button', { name: /^All downloads/ }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '09'
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await mergelane.relaunch()
  await openSchedule(mergelane)
  const restored = mergelane.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(restored.getByRole('switch', { name: 'Enable download schedule' })).toBeChecked()
  await expect(restored.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '07'
  )
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    endDateLabel
  )
  await expect(restored.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await restored.getByRole('button', { name: 'End date', exact: true }).click()
  await mergelane.page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    'No end date'
  )
  await restored.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await restored.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(restored).toBeHidden()
  await expect(mergelane.page.getByText(/^(Downloads stop at|Waiting until) /)).toBeHidden()
  // Where the indicator would be, so that its absence means something.
  await mergelane.place('Downloads')
  await expect(
    mergelane.page.getByRole('heading', { name: 'Downloads', level: 1, exact: true })
  ).toBeVisible()
  await expect(
    mergelane.page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  ).toBeHidden()
})

test('an overnight schedule remains usable at the minimum window size @smoke', async ({
  mergelane
}) => {
  await mergelane.evaluateMain(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(720, 620)
  }, null)
  await mergelane.page.emulateMedia({ colorScheme: 'dark' })
  await openSchedule(mergelane)
  const dialog = mergelane.page.getByRole('dialog', { name: 'Speed & data limits' })
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(mergelane, 'Start at', '22:00')
  const minute = dialog.getByRole('spinbutton', { name: 'Start at minute', exact: true })
  const hour = dialog.getByRole('spinbutton', { name: 'Start at hour', exact: true })
  await minute.focus()
  await mergelane.page.keyboard.press('ArrowDown')
  await expect(minute).toHaveValue('59')
  await expect(minute).toHaveAttribute('aria-valuenow', '59')
  await mergelane.page.keyboard.press('ArrowUp')
  await expect(minute).toHaveValue('00')
  await mergelane.page.keyboard.press('ArrowLeft')
  await expect(hour).toBeFocused()
  await mergelane.page.keyboard.press('End')
  await expect(hour).toHaveValue('23')
  await mergelane.page.keyboard.press('ArrowUp')
  await expect(hour).toHaveValue('00')
  await hour.evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '21:37')
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    )
  })
  await expect(hour).toHaveValue('21')
  await expect(minute).toHaveValue('37')
  await hour.focus()
  await mergelane.page.keyboard.press('ControlOrMeta+A')
  await hour.pressSequentially('22')
  await expect(minute).toBeFocused()
  await minute.fill('00')
  await minute.fill('75')
  await expect(minute).toHaveValue('00')
  await mergelane.page.screenshot({ path: test.info().outputPath('schedule-time-dark.png') })
  await expect(dialog.getByText('Next day', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({
    ratio: 1
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('main refuses invalid schedule changes without clearing the existing window @smoke', async ({
  mergelane,
  serve
}) => {
  await clock(mergelane, at(1, 8))
  await mergelane.api.updateSettings({ downloadSchedule: schedule })
  await expect(
    mergelane.api.updateSettings({ downloadSchedule: { ...schedule, days: [] } })
  ).rejects.toThrow()
  const origin = await serve({ size: 8 * BLOCK })
  const id = await mergelane.start(origin.url(), origin.sha256)
  expect((await mergelane.byId(id))?.status).toBe('queued')
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
})

test('quitting during the cutoff saves progress and leaves the restored queue stopped @smoke', async ({
  mergelane,
  serve
}) => {
  await clock(mergelane, at(1, 0))
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await mergelane.start(origin.url(), origin.sha256)
  await held
  await clock(mergelane, at(1, 7))
  await mergelane.quit()
  origin.release()
  await mergelane.launch()
  const restored = await mergelane.byId(id)
  expect(restored?.status).toBe('queued')
  expect(restored?.bytesDownloaded).toBeGreaterThan(0)
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
})

test('enabling a closed window adopts active work; a manual pause survives its cutoff and restart @smoke', async ({
  mergelane,
  serve
}) => {
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  await mergelane.api.updateSettings({ downloadsAtOnce: 1 })
  const active = await mergelane.start(origin.url('/active'), origin.sha256)
  await held
  const waiting = await mergelane.start(origin.url('/waiting'), origin.sha256)
  await clock(mergelane, at(1, 8))
  await mergelane.api.updateSettings({ downloadSchedule: schedule })
  const stopped = await mergelane.byId(active)
  expect(stopped?.status).toBe('queued')
  expect(stopped?.scheduled).toBe(true)
  expect((await mergelane.byId(waiting))?.scheduled).toBe(true)
  await mergelane.api.pauseDownload(active)
  await mergelane.quit()
  origin.release()
  await mergelane.launch()
  expect((await mergelane.byId(active))?.status).toBe('paused')
  // Whichever local time the app restarted in, the scheduled entry can run when disabled.
  await mergelane.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await mergelane.byId(waiting))?.status).toBe('completed')
  expect((await mergelane.byId(active))?.status).toBe('paused')
  await mergelane.api.resumeDownload(active)
  await expect.poll(async () => (await mergelane.byId(active))?.status).toBe('completed')
})

test('a malformed saved schedule blocks transfers and can be disabled from settings @smoke', async ({
  mergelane,
  serve,
  dirs
}) => {
  await clock(mergelane, at(1, 8))
  await mergelane.api.updateSettings({ downloadSchedule: schedule })
  const origin = await serve({ size: 8 * BLOCK })
  const id = await mergelane.start(origin.url(), origin.sha256)
  await mergelane.quit()
  await writeFile(
    join(dirs.userData, 'app-settings.json'),
    JSON.stringify({
      downloadSchedule: { ...schedule, days: [] }
    })
  )
  await mergelane.launch()
  expect((await mergelane.byId(id))?.status).toBe('queued')
  expect((await mergelane.byId(id))?.bytesDownloaded).toBe(0)
  await openSchedule(mergelane)
  const dialog = mergelane.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await mergelane.byId(id))?.status).toBe('completed')
})
