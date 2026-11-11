import { BLOCK, expect, test, type MergelaneApp } from './fixtures'

// New download's "When" (ADR-0044): Now, Add to queue, or At a time.

const SIZE = 24 * BLOCK

/** The destination picker is native UI: the sheet's Change picks the test's folder instead. */
async function pickDestination(mergelane: MergelaneApp, destination: string): Promise<void> {
  await mergelane.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

/** Opens New download on `url`, in the test's folder, with "When" set to `choice`. */
async function sheet(
  mergelane: MergelaneApp,
  destination: string,
  url: string,
  choice: 'Now' | 'Add to queue' | 'At a time'
): Promise<ReturnType<MergelaneApp['page']['getByRole']>> {
  await pickDestination(mergelane, destination)
  const page = mergelane.page
  const link = await mergelane.newDownload()
  const dialog = page.getByRole('dialog', { name: 'New download' })
  await dialog.getByRole('button', { name: 'Change' }).click()
  await link.fill(url)
  await expect(dialog.getByRole('textbox', { name: 'File name' })).toBeVisible()
  await dialog.getByRole('group', { name: 'When' }).getByRole('button', { name: choice }).click()
  return dialog
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('Add to queue waits until it is started, or until a running download ends @smoke', async ({
  mergelane,
  serve,
  dirs
}) => {
  const origin = await serve({ size: SIZE })
  const page = mergelane.page
  const dialog = await sheet(mergelane, dirs.dest, origin.url('/queued.bin'), 'Add to queue')
  await expect(
    dialog.getByText('It waits for a turn: it starts when a running download finishes')
  ).toBeVisible()
  await mergelane.expectNextDownload(origin.sha256)
  const submit = dialog.locator('button[type="submit"]')
  await expect(submit).toHaveText('Add to queue')
  await submit.click()
  await expect(dialog).toBeHidden()

  const queued = await mergelane.current()
  expect(queued).toMatchObject({ status: 'queued', held: true, bytesDownloaded: 0 })
  // Nothing else is running and there is room, yet it waits: it was added, not started.
  await sleep(2000)
  expect(await mergelane.byId(queued!.id)).toMatchObject({ status: 'queued', bytesDownloaded: 0 })
  const row = page.getByRole('listitem').filter({ hasText: 'queued.bin' })
  await expect(row).toContainText('Waiting for a turn')

  await row.getByRole('button', { name: 'Start now queued.bin' }).click()
  await expect.poll(async () => (await mergelane.byId(queued!.id))?.status).toBe('completed')
  expect((await mergelane.byId(queued!.id))?.held).toBeUndefined()

  // Its turn also comes when a download that is running ends.
  const held = await mergelane.start(origin.url('/held.bin'), origin.sha256, {
    when: { kind: 'queue' }
  })
  expect((await mergelane.byId(held))?.status).toBe('queued')
  const now = await mergelane.start(origin.url('/now.bin'), origin.sha256)
  await expect.poll(async () => (await mergelane.byId(now))?.status).toBe('completed')
  await expect.poll(async () => (await mergelane.byId(held))?.status).toBe('completed')
})

test('At a time starts the download at its time, and Start now starts it early @smoke', async ({
  mergelane,
  serve,
  dirs
}) => {
  const origin = await serve({ size: SIZE })
  const page = mergelane.page

  // From the sheet: the next time the clock reads the time picked, two hours from now.
  const later = new Date(Date.now() + 2 * 60 * 60_000)
  const field = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`
  const dialog = await sheet(mergelane, dirs.dest, origin.url('/later.bin'), 'At a time')
  await dialog.getByLabel('Start time').fill(field)
  const submit = dialog.locator('button[type="submit"]')
  await expect(submit).toHaveText(/^Start (tomorrow )?at /)
  await mergelane.expectNextDownload(origin.sha256)
  await submit.click()
  await expect(dialog).toBeHidden()
  const planned = await mergelane.current()
  later.setSeconds(0, 0)
  expect(planned).toMatchObject({ status: 'queued', startAt: later.getTime(), bytesDownloaded: 0 })
  const row = page.getByRole('listitem').filter({ hasText: 'later.bin' })
  await expect(row).toContainText(/Starts (tomorrow )?at /)
  await row.getByRole('button', { name: 'Start now later.bin' }).click()
  await expect.poll(async () => (await mergelane.byId(planned!.id))?.status).toBe('completed')

  // A few seconds ahead: it waits, then starts on its own when the time comes.
  const at = Date.now() + 4000
  const timed = await mergelane.start(origin.url('/timed.bin'), origin.sha256, {
    when: { kind: 'at', at }
  })
  expect(await mergelane.byId(timed)).toMatchObject({ status: 'queued', startAt: at })
  await sleep(1500)
  expect(await mergelane.byId(timed)).toMatchObject({ status: 'queued', bytesDownloaded: 0 })
  await expect
    .poll(async () => (await mergelane.byId(timed))?.status, { timeout: 20_000 })
    .toBe('completed')
  const done = await mergelane.byId(timed)
  expect(done?.startAt).toBeUndefined()
  expect(done?.missedStartAt).toBeUndefined()
  // It started at its time, not before.
  const started = mergelane.sessions
    .at(-1)!
    .find((state) => state.id === timed && state.status === 'downloading')
  expect(started).toBeTruthy()

  // A time that can't be used is refused, and no download is made.
  const before = (await mergelane.api.listDownloads()).length
  await expect(
    mergelane.start(origin.url('/bad.bin'), origin.sha256, {
      when: { kind: 'at', at: Date.now() + 30 * 24 * 60 * 60_000 }
    })
  ).rejects.toThrow(/start time can’t be used/)
  expect((await mergelane.api.listDownloads()).length).toBe(before)
})

test('the queue and start times survive a relaunch; a time missed while closed starts late @smoke', async ({
  mergelane,
  serve
}) => {
  const origin = await serve({ size: SIZE })
  const held = await mergelane.start(origin.url('/held.bin'), origin.sha256, {
    when: { kind: 'queue' }
  })
  const farAt = Date.now() + 60 * 60_000
  const far = await mergelane.start(origin.url('/far.bin'), origin.sha256, {
    when: { kind: 'at', at: farAt }
  })
  const soonAt = Date.now() + 3000
  const soon = await mergelane.start(origin.url('/soon.bin'), origin.sha256, {
    when: { kind: 'at', at: soonAt }
  })
  await mergelane.quit()
  // Mergelane is closed when the soon one's time comes.
  await sleep(Math.max(0, soonAt - Date.now()) + 1000)
  // Held part way, so it can be seen running.
  const reached = origin.hold(4 * BLOCK)
  await mergelane.launch()
  await reached

  expect(await mergelane.byId(held)).toMatchObject({ status: 'queued', held: true })
  expect(await mergelane.byId(far)).toMatchObject({ status: 'queued', startAt: farAt })
  expect(await mergelane.byId(soon)).toMatchObject({
    status: 'downloading',
    missedStartAt: soonAt
  })
  expect((await mergelane.byId(soon))?.startAt).toBeUndefined()

  // It says so, on its row and in its details.
  const page = mergelane.page
  await expect(page.getByRole('listitem').filter({ hasText: 'soon.bin' })).toContainText(
    'Started late'
  )
  await page.getByRole('button', { name: 'soon.bin', exact: true }).click()
  await expect(page.getByText(/while Mergelane was closed/).first()).toBeVisible()
  origin.release()
  await expect.poll(async () => (await mergelane.byId(soon))?.status).toBe('completed')
  // That run ending was the turn the one added to the queue was waiting for, as before the
  // relaunch; the one for later still waits for its time.
  await expect.poll(async () => (await mergelane.byId(held))?.status).toBe('completed')
  expect(await mergelane.byId(far)).toMatchObject({ status: 'queued', bytesDownloaded: 0 })

  await mergelane.api.resumeDownload(far)
  await expect.poll(async () => (await mergelane.byId(far))?.status).toBe('completed')
})
