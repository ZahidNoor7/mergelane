import type { DownloadState, NetworkInterfaceInfo } from '@shared/types'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMergeLanes } from '../hooks/useMergeLanes'
import { useAppStore } from '../store/useAppStore'
import { FileGlyph, KindTags } from './DownloadGlyphs'

const MB = 1024 * 1024

const item = (fields: Record<string, unknown>): DownloadState =>
  ({
    id: 'x',
    url: 'https://example.com/x',
    fileName: 'x.bin',
    kind: 'http',
    status: 'downloading',
    totalBytes: 10 * MB,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    startedAt: 0,
    networks: [],
    ...fields
  }) as unknown as DownloadState

const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

describe('FileGlyph', () => {
  it('draws a folder for a torrent folder or a Usenet download, and the type’s icon otherwise', () => {
    const icon = (fields: Record<string, unknown>): string => {
      const { container } = render(<FileGlyph item={item(fields)} size={40} />)
      const tile = container.firstElementChild as HTMLElement
      expect(tile.getAttribute('aria-hidden')).toBe('true')
      expect(tile.style.width).toBe('40px')
      const name = tile.querySelector('svg')!.getAttribute('class')!
      cleanup()
      return name
    }
    expect(icon({ kind: 'torrent', folder: true, fileName: 'Album' })).toContain('lucide-folder')
    expect(icon({ kind: 'nzb', fileName: 'Show' })).toContain('lucide-folder')
    expect(icon({ fileName: 'a.pdf' })).toContain('lucide-file-text')
    expect(icon({ fileName: 'a.bin' })).toContain('lucide-file')
  })
})

describe('KindTags', () => {
  it('names a torrent, Usenet and each kind of stream, and nothing for a link', () => {
    const tag = (fields: Record<string, unknown>): string | null => {
      const { container } = render(<KindTags item={item(fields)} />)
      const text = container.textContent
      cleanup()
      return text
    }
    expect(tag({ kind: 'torrent' })).toBe('Torrent')
    expect(tag({ kind: 'nzb' })).toBe('Usenet')
    expect(tag({ kind: 'stream', protocol: 'hls' })).toBe('HLS')
    expect(tag({ kind: 'stream', protocol: 'dash' })).toBe('DASH')
    expect(tag({ kind: 'stream', protocol: 'youtube' })).toBe('YouTube')
    expect(tag({ kind: 'http' })).toBe('')
  })
})

describe('useMergeLanes', () => {
  const iface = (id: string, displayName: string): NetworkInterfaceInfo => ({
    id,
    device: id,
    displayName,
    addresses: [],
    kind: 'wifi'
  })
  const network = (id: string, fields: Record<string, unknown> = {}): unknown => ({
    id,
    kind: 'wifi',
    label: id,
    enabled: true,
    status: 'on',
    speedBytesPerSec: 0,
    bytesDownloaded: 0,
    transfer: 'http',
    ...fields
  })

  it('makes each network a lane, says why one carries nothing, and when all will be done', () => {
    useAppStore.setState({
      interfaces: [iface('en0', 'Wi-Fi'), iface('en5', 'Ethernet'), iface('en7', 'iPhone')],
      downloads: {
        a: item({
          id: 'a',
          bytesDownloaded: 2 * MB,
          speedBytesPerSec: 4 * MB,
          streams: [{ interfaceId: 'en0', status: 'downloading' }],
          networks: [
            network('en0', { speedBytesPerSec: 4 * MB }),
            network('en5', { status: 'limit' }),
            network('en7', { status: 'unreachable' }),
            // Gone from the Mac: a lane that dropped.
            network('en9')
          ]
        })
      }
    })
    const { result } = renderHook(() => useMergeLanes())
    const { lanes, active, progress } = result.current
    expect(lanes.map((lane) => [lane.id, lane.on, lane.down, lane.note])).toEqual([
      ['en0', true, false, 'Idle'],
      ['en5', false, false, 'Data limit reached'],
      ['en7', false, false, 'Can’t reach the server'],
      ['en9', false, true, 'Idle']
    ])
    expect(active.running).toHaveLength(1)
    expect(progress).toBe('1 downloading, about 2s left')
  })

  it('says nothing is downloading when nothing runs', () => {
    const { result } = renderHook(() => useMergeLanes())
    expect(result.current.progress).toBe('Nothing downloading')
    expect(screen.queryByText('Idle')).toBeNull()
  })
})
