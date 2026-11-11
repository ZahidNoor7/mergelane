import type { DownloadState, FinishedDownload } from '@shared/types'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { todayTotals } from '../utils/dashboard'
import { DashboardToday } from './DashboardToday'

const MB = 1024 * 1024
const at = (day: number, hour: number): number => new Date(2026, 10, day, hour).getTime()
const NOW = at(11, 15)

const net = (id: string, bytes: number): unknown => ({
  id,
  kind: 'wifi',
  label: id,
  bytesDownloaded: bytes
})
const item = (fields: Record<string, unknown>): DownloadState =>
  ({
    status: 'downloading',
    startedAt: at(11, 9),
    networks: [],
    ...fields
  }) as unknown as DownloadState

const initial = useAppStore.getState()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
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
  vi.useRealTimers()
})

describe('todayTotals', () => {
  it('adds up today’s downloads by network, biggest first, with the fastest', () => {
    const today = todayTotals(
      [
        item({ networks: [net('en0', 3 * MB), net('en7', MB)], peakSpeedBytesPerSec: 2 * MB }),
        // Started yesterday, still going: not today's.
        item({ startedAt: at(10, 9), networks: [net('en0', 50 * MB)] }),
        // Cancelled: nothing it brought counts.
        item({ status: 'cancelled', networks: [net('en0', 9 * MB)] }),
        // Started yesterday, finished today: today's.
        item({
          status: 'completed',
          startedAt: at(10, 23),
          completedAt: at(11, 1),
          networks: [net('en7', 4 * MB), net('en5', 0)]
        })
      ],
      [
        {
          startedAt: at(11, 10),
          completedAt: at(11, 11),
          networks: [net('en5', 2 * MB)],
          peakSpeedBytesPerSec: 5 * MB
        } as unknown as FinishedDownload,
        {
          startedAt: at(9, 10),
          completedAt: at(9, 11),
          networks: [net('en5', 99 * MB)]
        } as unknown as FinishedDownload
      ],
      NOW
    )
    expect(today.byNetwork.map((each) => [each.id, each.bytes / MB])).toEqual([
      ['en7', 5],
      ['en0', 3],
      ['en5', 2]
    ])
    expect(today.total).toBe(10 * MB)
    expect(today.fastest).toBe(5 * MB)
  })

  it('is nothing on a day with no downloads', () => {
    expect(todayTotals([], [], NOW)).toEqual({ byNetwork: [], total: 0, fastest: undefined })
  })
})

describe('DashboardToday', () => {
  it('shows today’s total, each network’s share, the fastest and the dropouts', () => {
    useAppStore.setState({
      downloads: {
        a: item({ networks: [net('en0', 3 * MB), net('en7', MB)], peakSpeedBytesPerSec: 2 * MB })
      },
      history: [],
      networkEvents: [
        { id: 'en7', osName: 'en7', kind: 'usb', change: 'dropped', at: NOW - 60_000, left: 1 },
        {
          id: 'en7',
          osName: 'en7',
          kind: 'usb',
          change: 'recovered',
          at: NOW - 30_000,
          downForMs: 30_000,
          left: 2
        }
      ]
    })
    render(<DashboardToday />)
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy()
    expect(screen.getByText('4.0 MB')).toBeTruthy()
    const rows = within(
      screen.getByRole('list', { name: 'Downloaded today, by network' })
    ).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['en03.0 MB75%', 'en71.0 MB25%'])
    expect(screen.getByText('Fastest merged speed').nextElementSibling!.textContent).toBe(
      '2.0 MB/s'
    )
    expect(screen.getByText('Network dropouts').nextElementSibling!.textContent).toBe('1, all back')
  })

  it('on a quiet day: nothing downloaded, no fastest, no dropouts, or one still out', () => {
    useAppStore.setState({ downloads: {}, history: [], networkEvents: [] })
    render(<DashboardToday />)
    expect(screen.getByText('0 B')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('Fastest merged speed').nextElementSibling!.textContent).toBe('—')
    expect(screen.getByText('Network dropouts').nextElementSibling!.textContent).toBe('0')
    cleanup()
    useAppStore.setState({
      networkEvents: [
        { id: 'en7', osName: 'en7', kind: 'usb', change: 'dropped', at: NOW, left: 1 }
      ]
    })
    render(<DashboardToday />)
    expect(screen.getByText('Network dropouts').nextElementSibling!.textContent).toBe('1')
  })

  it('the fastest merged speed of today, kept across restarts, beats one download’s own', () => {
    useAppStore.setState({
      downloads: { a: item({ networks: [net('en0', MB)], peakSpeedBytesPerSec: 2 * MB }) },
      history: [],
      networkEvents: [],
      fastestMerged: { day: '2026-11-11', bytesPerSec: 7 * MB }
    })
    render(<DashboardToday />)
    expect(screen.getByText('Fastest merged speed').nextElementSibling!.textContent).toBe(
      '7.0 MB/s'
    )
    cleanup()
    // Yesterday's fastest doesn't count today; with no download today there's none at all.
    useAppStore.setState({
      downloads: {},
      fastestMerged: { day: '2026-11-10', bytesPerSec: 9 * MB }
    })
    render(<DashboardToday />)
    expect(screen.getByText('Fastest merged speed').nextElementSibling!.textContent).toBe('—')
  })

  it('counts the dropouts of the last 24 hours, the saved ones from before a restart too', () => {
    useAppStore.setState({
      downloads: {},
      history: [],
      networkEvents: [
        // Two days ago: not counted.
        {
          id: 'en0',
          osName: 'Wi-Fi',
          kind: 'wifi',
          change: 'dropped',
          at: NOW - 48 * 3600e3,
          left: 0
        },
        { id: 'en7', osName: 'en7', kind: 'usb', change: 'dropped', at: NOW - 5 * 3600e3, left: 1 },
        {
          id: 'en7',
          osName: 'en7',
          kind: 'usb',
          change: 'recovered',
          at: NOW - 3600e3,
          whileClosed: true,
          left: 2
        }
      ]
    })
    render(<DashboardToday />)
    expect(screen.getByText('Network dropouts').nextElementSibling!.textContent).toBe('1, all back')
  })
})
