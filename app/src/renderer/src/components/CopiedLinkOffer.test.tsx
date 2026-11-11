import type { DownloadState, FinishedDownload } from '@shared/types'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { useCopiedLinks } from '../hooks/useCopiedLinks'
import { CopiedLinkOffer } from './CopiedLinkOffer'

const LINK = 'https://files.example.com/releases/big.iso'
const initial = useAppStore.getState()
let send: ((link: string) => void) | null = null
const unsubscribe = vi.fn()
const onCopiedLink = vi.fn((callback: (link: string) => void) => {
  send = callback
  return unsubscribe
})

beforeEach(() => {
  window.mergelane = {
    ...window.mergelane,
    onCopiedLink,
    updateSettings: vi.fn(() => Promise.resolve())
  } as unknown as typeof window.mergelane
  useAppStore.setState({ offerCopiedLinks: true })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  send = null
  vi.clearAllMocks()
})

const offer = (): HTMLElement | null => screen.queryByRole('region', { name: 'Copied link' })

describe('useCopiedLinks', () => {
  it('offers what main finds on the clipboard, and stops listening when unmounted', () => {
    const { unmount } = renderHook(() => useCopiedLinks())
    act(() => send?.(LINK))
    expect(useAppStore.getState().copiedLink).toBe(LINK)
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('the offer', () => {
  it('shows the copied link at the sidebar’s foot; Download… opens New download with it', async () => {
    render(<CopiedLinkOffer layout="sidebar" />)
    expect(offer()).toBeNull()
    act(() => useAppStore.getState().offerCopiedLink(LINK))
    expect(screen.getByRole('status').textContent).toContain('Download the link you copied?')
    expect(screen.getByTitle(LINK).textContent).toBe('files.example.com/releases/big.iso')
    // It never takes focus.
    expect(offer()!.contains(document.activeElement)).toBe(false)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download…' }))
    expect(useAppStore.getState()).toMatchObject({
      newDownloadOpen: true,
      draftUrl: LINK,
      copiedLink: null
    })
    expect(offer()).toBeNull()
  })

  it('under the compact bar too; Dismiss puts it away', async () => {
    render(<CopiedLinkOffer layout="bar" />)
    act(() => useAppStore.getState().offerCopiedLink(LINK))
    expect(offer()!.className).toContain('mx-3')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useAppStore.getState().copiedLink).toBeNull()
    expect(useAppStore.getState().newDownloadOpen).toBe(false)
    expect(offer()).toBeNull()
  })

  it('hides while New download is open', () => {
    render(<CopiedLinkOffer layout="sidebar" />)
    act(() => useAppStore.setState({ copiedLink: LINK, newDownloadOpen: true }))
    expect(offer()).toBeNull()
    act(() => useAppStore.setState({ newDownloadOpen: false }))
    expect(offer()).not.toBeNull()
  })
})

describe('what is offered', () => {
  const offered = (link: string): string | null => {
    useAppStore.setState({ copiedLink: null })
    useAppStore.getState().offerCopiedLink(link)
    return useAppStore.getState().copiedLink
  }

  it('nothing while the setting is off', () => {
    useAppStore.setState({ offerCopiedLinks: false })
    expect(offered(LINK)).toBeNull()
  })

  it('not a link already in New download, or just started from it', () => {
    useAppStore.setState({ newDownloadOpen: true, draftUrl: LINK })
    expect(offered(LINK)).toBeNull()
    // Open with another link: offered once it closes.
    expect(offered('https://example.com/other')).toBe('https://example.com/other')
    useAppStore.setState({ newDownloadOpen: false, draftUrl: '', startedUrl: LINK })
    expect(offered(LINK)).toBeNull()
  })

  it('not a link downloading or downloaded', () => {
    useAppStore.setState({ downloads: { a: { url: LINK } as DownloadState } })
    expect(offered(LINK)).toBeNull()
    useAppStore.setState({ downloads: {}, history: [{ url: LINK } as FinishedDownload] })
    expect(offered(LINK)).toBeNull()
    useAppStore.setState({ history: [] })
    expect(offered(LINK)).toBe(LINK)
  })

  it('Download… with nothing offered does nothing', () => {
    useAppStore.getState().downloadCopiedLink()
    expect(useAppStore.getState().newDownloadOpen).toBe(false)
  })
})
