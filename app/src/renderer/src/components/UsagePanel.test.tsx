import type { AppUsage } from '@shared/appUsage'
import { appPart, partsFromPs, parsePs } from '@shared/appUsage'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePanel } from './UsagePanel'

const PS = `
  1     0   0.0  12000 /sbin/launchd
 500     1  12.5 204800 /Applications/Mergelane.app/Contents/MacOS/Mergelane
 501   500   3.0  51200 /Applications/Mergelane.app/Contents/Frameworks/Mergelane Helper (Renderer).app/Contents/MacOS/Mergelane Helper (Renderer)
 502   500  20.0 102400 /Applications/Mergelane.app/Contents/Resources/yt-dlp
 503   502   5.0  40960 /Applications/Mergelane.app/Contents/Resources/deno
 600     1   0.4  20480 /Library/PrivilegedHelperTools/mergelane-daemon
 700   500   0.0   2048 /bin/ps
 701   500   0.0   4096 /Applications/Mergelane.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler
 not a process line
`

describe('reading ps', () => {
  it('reads each process, with memory in bytes, skipping what isn’t one', () => {
    const rows = parsePs(PS)
    expect(rows).toHaveLength(8)
    expect(rows[2]).toMatchObject({ pid: 501, ppid: 500, cpu: 3, memory: 51200 * 1024 })
    expect(rows[2].command).toContain('Mergelane Helper (Renderer)')
  })

  it('finds the helper by name, and the tools under the app, but not the app’s own processes', () => {
    const parts = partsFromPs(parsePs(PS), 500, new Set([500, 501]))
    expect(parts.helper).toEqual({ cpu: 0.4, memory: 20480 * 1024 })
    // yt-dlp and the Deno it started; not the ps taking the reading, nor the crash reporter.
    expect(parts.tools).toEqual({ cpu: 25, memory: (102400 + 40960) * 1024, count: 2 })
    expect(partsFromPs(parsePs(PS), 999, new Set())).toEqual({
      helper: { cpu: 0.4, memory: 20480 * 1024 },
      tools: { cpu: 0, memory: 0, count: 0 }
    })
    expect(partsFromPs([], 500, new Set()).helper).toBeNull()
    expect(partsFromPs(parsePs(' 7 1 1.0 10 mergelane-daemon'), 500, new Set()).helper).toEqual({
      cpu: 1,
      memory: 10 * 1024
    })
  })
})

describe('the app’s CPU', () => {
  it('is CPU seconds used between readings over the time between, as a percent of one core', () => {
    const before = [
      { pid: 1, creationTime: 10, cpuSeconds: 4, memoryKb: 100 },
      { pid: 2, creationTime: 20, cpuSeconds: 1, memoryKb: 50 }
    ]
    const now = [
      { pid: 1, creationTime: 10, cpuSeconds: 5, memoryKb: 120 },
      // A new process with a reused pid counts from its start.
      { pid: 2, creationTime: 30, cpuSeconds: 0.5, memoryKb: 40 }
    ]
    expect(appPart(now, before, 2)).toEqual({ cpu: 75, memory: 160 * 1024 })
    // The first reading has nothing to compare with.
    expect(appPart(now, null, 0).cpu).toBe(0)
    // A process can't use less than before.
    expect(appPart([{ ...now[0], cpuSeconds: 3 }], before, 1).cpu).toBe(0)
  })
})

describe('UsagePanel', () => {
  let reply: AppUsage
  const appUsage = vi.fn(() => Promise.resolve(reply))
  let ticks: Array<() => void> = []

  beforeEach(() => {
    ticks = []
    vi.stubGlobal('setInterval', (callback: () => void) => {
      ticks.push(callback)
      return 1
    })
    vi.stubGlobal('clearInterval', vi.fn())
    window.mergelane = { ...window.mergelane, appUsage } as unknown as typeof window.mergelane
    reply = {
      app: { cpu: 12.34, memory: 412e6 },
      helper: { cpu: 0.4, memory: 18e6 },
      tools: { cpu: 0, memory: 0, count: 0 }
    }
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('totals Mergelane’s CPU and memory, and lists each part', async () => {
    render(<UsagePanel merging={false} />)
    expect(screen.getByText('Measuring…')).toBeTruthy()
    await act(async () => {})
    expect(screen.getByText('CPU', { selector: 'dt' }).nextElementSibling!.textContent).toBe('13%')
    expect(screen.getByText('Memory', { selector: 'dt' }).nextElementSibling!.textContent).toBe(
      '430 MB'
    )
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      'MergelaneThe app: its window, downloads and engine12%412 MB',
      'HelperSystem merge is off0.4%18 MB',
      'Video toolsNot running now——'
    ])
    expect(screen.getByRole('img', { name: /CPU over the last minute, now 13%/ })).toBeTruthy()
  })

  it('says when merging is on, when the helper isn’t running, and when tools run', async () => {
    reply = {
      app: { cpu: 3, memory: 1.5e9 },
      helper: { cpu: 1, memory: 1e6 },
      tools: { cpu: 40, memory: 300e6, count: 2 }
    }
    render(<UsagePanel merging />)
    await act(async () => {})
    expect(screen.getByText('System merge is on')).toBeTruthy()
    expect(screen.getByText('yt-dlp, FFmpeg and Deno, for a video download')).toBeTruthy()
    expect(screen.getByText('Memory', { selector: 'dt' }).nextElementSibling!.textContent).toBe(
      '1.80 GB'
    )
    reply = { ...reply, helper: null }
    await act(async () => ticks.forEach((tick) => tick()))
    expect(screen.getByText('Not running')).toBeTruthy()
    // A failed reading leaves the last one shown.
    appUsage.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    await act(async () => ticks.forEach((tick) => tick()))
    expect(screen.getByText('Not running')).toBeTruthy()
  })
})
