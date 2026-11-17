import type { WebContents } from 'electron'

// Pages besides the main window that keep their own list of downloads and networks, and so hear the same
// updates: the menu bar's menu (menuBarPanel.ts, ADR-0067), which works while the main window is closed.

const pages = new Set<WebContents>()

/** Sends `page` the downloads' and networks' updates from now on; the returned function stops that. */
export function keepPageCurrent(page: WebContents): () => void {
  pages.add(page)
  return () => pages.delete(page)
}

/** Whether any such page is listening. */
export function otherPagesListening(): boolean {
  for (const page of pages) if (!page.isDestroyed()) return true
  return false
}

/** One update, to every such page. */
export function sendToOtherPages(channel: string, ...args: unknown[]): void {
  for (const page of pages) {
    if (page.isDestroyed()) pages.delete(page)
    else page.send(channel, ...args)
  }
}
