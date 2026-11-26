import type { DuplicateMatch, DuplicateQuery } from '@shared/duplicates'
import type { ProbeResult } from '@shared/types'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDuplicate } from './useDuplicate'

const base = {
  requestedUrl: 'https://example.com/a.iso',
  finalUrl: 'https://example.com/a.iso',
  supportsRanges: true,
  totalBytes: 100,
  suggestedFileName: 'a.iso',
  contentType: null,
  etag: null,
  lastModified: null
}
const match: DuplicateMatch = {
  id: 'had',
  how: 'link',
  live: false,
  name: 'a.iso',
  host: 'example.com',
  size: 100
}
const findDuplicate = vi.fn<(query: DuplicateQuery) => Promise<DuplicateMatch | null>>(() =>
  Promise.resolve(match)
)

beforeEach(() => {
  window.mergelane = { ...window.mergelane, findDuplicate } as unknown as typeof window.mergelane
})
afterEach(() => vi.clearAllMocks())

describe('the duplicate New download looks for', () => {
  it('asks with what the site publishes, and gives the answer for this link only', async () => {
    const probe = { ...base, kind: 'http', publishedSha256: 'f'.repeat(64) } as ProbeResult
    const { result, rerender } = renderHook(({ p, name }) => useDuplicate(p, name), {
      initialProps: { p: probe as ProbeResult | null, name: 'a.iso' }
    })
    expect(result.current).toBeNull()
    await act(async () => {})
    expect(findDuplicate).toHaveBeenCalledWith({
      kind: 'http',
      url: base.finalUrl,
      name: 'a.iso',
      size: 100,
      publishedSha256: 'f'.repeat(64)
    })
    expect(result.current).toEqual(match)
    // Another name: nothing until it's asked again.
    findDuplicate.mockImplementationOnce(() => new Promise(() => {}))
    rerender({ p: probe, name: 'b.iso' })
    expect(result.current).toBeNull()
    rerender({ p: null, name: '' })
    expect(result.current).toBeNull()
  })

  it('asks with a torrent’s info hash, and shows nothing when it can’t ask', async () => {
    const torrent = {
      ...base,
      kind: 'torrent',
      torrent: { infoHash: 'abc' }
    } as unknown as ProbeResult
    findDuplicate.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    const { result } = renderHook(() => useDuplicate(torrent, 'a.iso'))
    await act(async () => {})
    expect(findDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'torrent', infoHash: 'abc' })
    )
    expect(result.current).toBeNull()
  })
})
