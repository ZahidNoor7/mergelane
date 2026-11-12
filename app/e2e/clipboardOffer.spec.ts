import type { Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type MergelaneApp } from './fixtures'

// Settings › Downloads › "Offer links I copy" (M3.6, docs/DECISIONS.md ADR-0043): with it on, a
// link the user copied is offered as they switch to Mergelane; off, the clipboard isn't read.
//
// The Mac's clipboard is the person at it's: these tests leave it alone. Main's clipboard.readText
// is swapped for one that answers from a stand-in (and counts its calls), except in the one test
// that goes through the real clipboard, which puts back what was there before it ends. The test
// window is hidden and never takes focus (testKnobs.hideWindow), so switching to Mergelane is
// Electron's 'browser-window-focus', emitted in main.

interface ClipboardStandIn {
  text: string
  reads: number
}

/** Puts `text` on the stand-in clipboard, swapping it in the first time. */
function copy(mergelane: MergelaneApp, text: string): Promise<void> {
  return mergelane.evaluateMain(({ clipboard }, value) => {
    const global = globalThis as unknown as {
      __clipboard?: ClipboardStandIn
      __realReadText?: typeof clipboard.readText
    }
    if (!global.__clipboard) {
      const standIn: ClipboardStandIn = { text: '', reads: 0 }
      global.__clipboard = standIn
      global.__realReadText = clipboard.readText
      clipboard.readText = async () => {
        standIn.reads++
        return standIn.text
      }
    }
    global.__clipboard.text = value
  }, text)
}

/** How many times main has read the stand-in clipboard. */
function reads(mergelane: MergelaneApp): Promise<number> {
  return mergelane.evaluateMain(
    () => (globalThis as unknown as { __clipboard?: ClipboardStandIn }).__clipboard?.reads ?? 0,
    null
  )
}

/** The user switching to Mergelane: its window gains focus. */
function switchToMergelane(mergelane: MergelaneApp): Promise<void> {
  return mergelane.evaluateMain(({ app, BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    app.emit('browser-window-focus', { preventDefault: () => undefined }, window)
  }, null)
}

async function turnOn(mergelane: MergelaneApp): Promise<void> {
  await mergelane.openSettings()
  await mergelane.page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Downloads' })
    .click()
  const offerSwitch = mergelane.page.getByRole('switch', { name: 'Offer links I copy' })
  await expect(offerSwitch).toHaveAttribute('aria-checked', 'false')
  await offerSwitch.click()
  await expect(offerSwitch).toHaveAttribute('aria-checked', 'true')
}

const offer = (mergelane: MergelaneApp): Locator =>
  mergelane.page.getByRole('region', { name: 'Copied link' })

test.describe('Offer links I copy @smoke', () => {
  test('off, as it starts, the clipboard isn’t read when the user switches to Mergelane', async ({
    mergelane
  }) => {
    await copy(mergelane, 'https://example.com/file.iso')
    await switchToMergelane(mergelane)
    await switchToMergelane(mergelane)
    // Give main the time it would take to read and send.
    await mergelane.page.waitForTimeout(300)
    expect(await reads(mergelane)).toBe(0)
    await expect(offer(mergelane)).toHaveCount(0)

    // On and back off: not read again either.
    await turnOn(mergelane)
    await mergelane.page.getByRole('switch', { name: 'Offer links I copy' }).click()
    // Saved as nothing at all once off again.
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(join(mergelane.dirs.userData, 'app-settings.json'), 'utf8')
        ) as Record<string, unknown>
        return saved.offerCopiedLinks
      })
      .toBeUndefined()
    await switchToMergelane(mergelane)
    await mergelane.page.waitForTimeout(300)
    expect(await reads(mergelane)).toBe(0)
  })

  test('on, a copied link is offered once on switching to Mergelane, and Download… opens New download with it', async ({
    mergelane,
    serve
  }) => {
    const origin = await serve({ size: 64 * 1024 })
    const link = origin.url()
    await turnOn(mergelane)

    // Not a link: nothing offered, though the clipboard was read.
    await copy(mergelane, 'some words someone copied')
    await switchToMergelane(mergelane)
    await expect.poll(() => reads(mergelane)).toBe(1)
    await expect(offer(mergelane)).toHaveCount(0)

    await copy(mergelane, `${link}\n`)
    await switchToMergelane(mergelane)
    await expect(offer(mergelane)).toBeVisible()
    await expect(offer(mergelane).getByTitle(link)).toBeVisible()
    // Not focused: the offer waits for the user.
    expect(
      await offer(mergelane).evaluate((element) => element.contains(document.activeElement))
    ).toBe(false)

    // Dismissed, the same copy isn't offered again at the next switch.
    await offer(mergelane).getByRole('button', { name: 'Dismiss' }).click()
    await expect(offer(mergelane)).toHaveCount(0)
    await switchToMergelane(mergelane)
    await expect.poll(() => reads(mergelane)).toBe(3)
    await mergelane.page.waitForTimeout(300)
    await expect(offer(mergelane)).toHaveCount(0)

    // Another copy is; then the first again, since it's no longer the last one offered.
    await copy(mergelane, 'magnet:?xt=urn:btih:' + 'ab'.repeat(20) + '&dn=Copied%20Film')
    await switchToMergelane(mergelane)
    await expect(offer(mergelane)).toContainText('Copied Film')
    await copy(mergelane, link)
    await switchToMergelane(mergelane)
    await expect(offer(mergelane).getByTitle(link)).toBeVisible()

    await offer(mergelane).getByRole('button', { name: 'Download…' }).click()
    await expect(mergelane.page.getByRole('textbox', { name: 'Link' })).toHaveValue(link)
    await expect(offer(mergelane)).toHaveCount(0)
    // Shown, not started.
    expect(await mergelane.current()).toBeNull()
  })

  test('through the real clipboard, which is put back as it was', async ({ mergelane }) => {
    await turnOn(mergelane)
    const link = 'https://example.com/mergelane-e2e/copied.iso'
    // What the Mac's clipboard held, every format of it, copied out now (an item clipboard.read()
    // returns may read the clipboard only when asked) and kept in main to put back.
    const before = await mergelane.evaluateMain(async ({ clipboard, ClipboardItem }) => {
      const copies: Electron.ClipboardItem[] = []
      const formats: Array<{ type: string; size: number }> = []
      for (const item of await clipboard.read()) {
        // An empty clipboard reads as an item with no formats, which ClipboardItem refuses. There is
        // nothing of it to put back: with no copies, the clipboard is cleared again below.
        if (item.types.length === 0) continue
        const data: Record<string, Blob | Electron.ClipboardBookmark> = {}
        // HTML written back as text/html gains a <meta charset='utf-8'> in front, one more on every
        // run (seen on macOS 27, Electron 44). The same bytes, raw, as the Mac's own pasteboard type
        // go back unchanged, so when read() gave those, they alone put the HTML back.
        const rawHtml = item.types.some((type) =>
          /^electron application\/osclipboard;format="(Apple HTML pasteboard type|public\.html)"$/.test(
            type
          )
        )
        for (const type of item.types) {
          const value = await item.getType(type)
          if (!(type === 'text/html' && rawHtml)) data[type] = value
          formats.push({ type, size: value instanceof Blob ? value.size : -1 })
        }
        copies.push(new ClipboardItem(data))
      }
      const text = await clipboard.readText()
      Object.assign(globalThis, { __savedClipboard: { copies, text } })
      return { text, formats }
    }, null)
    try {
      await mergelane.evaluateMain(({ clipboard }, text) => clipboard.writeText(text), link)
      await switchToMergelane(mergelane)
      await expect(offer(mergelane).getByTitle(link)).toBeVisible()
    } finally {
      await mergelane.evaluateMain(async ({ clipboard }) => {
        const { copies, text } = (
          globalThis as unknown as {
            __savedClipboard: { copies: Electron.ClipboardItem[]; text: string }
          }
        ).__savedClipboard
        try {
          if (copies.length > 0) await clipboard.write(copies)
          else clipboard.clear()
        } catch {
          // A format that can't be written back: the text, at least.
          await clipboard.writeText(text)
        }
      }, null)
    }
    const after = await mergelane.evaluateMain(async ({ clipboard }) => {
      const formats: Array<{ type: string; size: number }> = []
      for (const item of await clipboard.read()) {
        for (const type of item.types) {
          const value = await item.getType(type)
          formats.push({ type, size: value instanceof Blob ? value.size : -1 })
        }
      }
      return { text: await clipboard.readText(), formats }
    }, null)
    expect(after).toEqual(before)
  })
})
