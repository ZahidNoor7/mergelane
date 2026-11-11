import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadUnitState } from '@shared/types'
import type { NetworkVisual } from '../theme'
import type { NetworkGroup } from '../utils/format'
import { BlockGrid } from './BlockGrid'
import { Sparkline } from './Sparkline'
import { SplitBar } from './SplitBar'
import { ThroughputChart } from './ThroughputChart'

// The app writes sizes in base 1024 (utils/format.ts formatBytes).
const MB = 1024 * 1024

// jsdom measures nothing: a ResizeObserver whose width the test sets, and elements that scroll.
let observed: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
beforeEach(() => {
  observed = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
        observed.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const measure = (width: number): void =>
  act(() => observed.forEach((callback) => callback([{ contentRect: { width } }])))

const visual = (name: string, solid: string): NetworkVisual =>
  ({ name, solid }) as unknown as NetworkVisual
const group = (id: string, bytesDownloaded = 0): NetworkGroup =>
  ({ id, bytesDownloaded }) as unknown as NetworkGroup
const GROUPS = [group('en0', 3 * MB), group('en5', 2 * MB)]
const VISUALS = [visual('Wi-Fi', 'var(--color-wifi)'), visual('Ethernet', 'var(--color-ethernet)')]

function block(
  index: number,
  status: DownloadUnitState['status'],
  bytesByInterface: Record<string, number> = {},
  extra: Partial<DownloadUnitState> = {}
): DownloadUnitState {
  const bytesDownloaded = Object.values(bytesByInterface).reduce((sum, bytes) => sum + bytes, 0)
  return {
    kind: 'http',
    index,
    rangeStart: index * MB,
    rangeEnd: (index + 1) * MB - 1,
    status,
    bytesDownloaded,
    bytesByInterface,
    ...extra
  } as DownloadUnitState
}

describe('SplitBar', () => {
  it('draws each network’s share, and drops slivers too small to see', () => {
    const { container } = render(
      <SplitBar
        segments={[
          { id: 'en0', share: 0.5, color: 'red' },
          { id: 'en5', share: 0.0001, color: 'blue' }
        ]}
      />
    )
    const bar = container.firstElementChild as HTMLElement
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(bar.children).toHaveLength(1)
    expect((bar.children[0] as HTMLElement).style.width).toBe('50%')
  })

  it('is a progressbar when labelled, and fades when nothing moves', () => {
    render(
      <SplitBar
        segments={[{ id: 'en0', share: 0.4, color: 'red' }]}
        dim
        label="ubuntu.iso, by network"
        percent={40}
        valueText="40% done. Wi-Fi 40%"
      />
    )
    const bar = screen.getByRole('progressbar', { name: 'ubuntu.iso, by network' })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.getAttribute('aria-valuetext')).toBe('40% done. Wi-Fi 40%')
    expect(bar.className).toContain('opacity-45')
  })
})

describe('BlockGrid (the chunk map)', () => {
  const blocks = [
    block(0, 'completed', { en0: MB }),
    block(1, 'completed', { en0: 0.6 * MB, en5: 0.4 * MB }),
    block(2, 'downloading', { en5: 0.3 * MB }, { interfaceId: 'en5' }),
    block(3, 'pending'),
    block(4, 'completed', {}, { interfaceId: undefined, bytesDownloaded: 0 }),
    ...Array.from({ length: 7 }, (_, i) => block(5 + i, 'pending'))
  ]

  it('names the networks, and reads out how many chunks and how to explore them', () => {
    render(
      <BlockGrid blocks={blocks} groups={GROUPS} visuals={VISUALS} knownSize remainingBytes={0} />
    )
    measure(200)
    expect(screen.getByText('Wi-Fi')).toBeTruthy()
    expect(screen.getByText('Ethernet')).toBeTruthy()
    expect(
      screen.getByText(
        /^12 chunks of about 1\.0 MB\. Point at one, or focus the map and use the arrow keys\.$/
      )
    ).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Chunk map' })).toBeTruthy()
  })

  it('reads out the chunk pointed at, with who fetched it', () => {
    const { container } = render(
      <BlockGrid blocks={blocks} groups={GROUPS} visuals={VISUALS} knownSize remainingBytes={0} />
    )
    measure(200)
    const at = (n: number): Element => container.querySelector(`[data-chunk="${n}"]`)!
    fireEvent.mouseEnter(at(1))
    expect(
      screen.getByText(/^Chunk 1 of 12: 1\.0 MB of 1\.0 MB verified, fetched over Wi-Fi$/)
    ).toBeTruthy()
    fireEvent.mouseEnter(at(2))
    expect(screen.getByText(/fetched over Wi-Fi 60%, Ethernet 40%$/)).toBeTruthy()
    fireEvent.mouseEnter(at(3))
    expect(screen.getByText(/^Chunk 3 of 12: .* in progress over Ethernet$/)).toBeTruthy()
    fireEvent.mouseEnter(at(4))
    expect(screen.getByText(/not fetched yet$/)).toBeTruthy()
    fireEvent.mouseEnter(at(5))
    expect(screen.getByText(/not attributed to a network$/)).toBeTruthy()
  })

  it('moves along the map with the arrow keys, Home and End, and lets go on Escape', async () => {
    render(
      <BlockGrid blocks={blocks} groups={GROUPS} visuals={VISUALS} knownSize remainingBytes={0} />
    )
    measure(200)
    const map = screen.getByRole('group', { name: 'Chunk map' })
    map.focus()
    const user = userEvent.setup()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByText(/^Chunk 1 of 12/)).toBeTruthy()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByText(/^Chunk 2 of 12/)).toBeTruthy()
    // 200px fits 11 columns: down is eleven on.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByText(/^Chunk 12 of 12/)).toBeTruthy()
    await user.keyboard('{ArrowUp}{ArrowLeft}')
    expect(screen.getByText(/^Chunk 1 of 12/)).toBeTruthy()
    await user.keyboard('{End}')
    expect(screen.getByText(/^Chunk 12 of 12/)).toBeTruthy()
    await user.keyboard('{Home}')
    expect(screen.getByText(/^Chunk 1 of 12/)).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.getByText(/^12 chunks of about/)).toBeTruthy()
    act(() => map.blur())
  })

  it('follows the keys down a long map, and points the way to work out of view', async () => {
    const long = Array.from({ length: 110 }, (_, i) =>
      block(i, i === 108 ? 'downloading' : 'pending', i === 108 ? { en0: 0.5 * MB } : {}, {
        interfaceId: i === 108 ? 'en0' : undefined
      })
    )
    render(
      <BlockGrid
        blocks={long}
        groups={GROUPS}
        visuals={VISUALS}
        knownSize
        remainingBytes={0}
        isPaused
      />
    )
    measure(200)
    const show = screen.getByRole('button', { name: 'Show the chunks in progress' })
    await userEvent.setup().click(show)
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled()
    const map = screen.getByRole('group', { name: 'Chunk map' })
    map.focus()
    await userEvent.setup().keyboard('{End}')
    expect(screen.getByText(/^Chunk 110 of 110/)).toBeTruthy()
  })

  it('names pieces, segments and articles, and reads out a torrent’s unverified bytes', () => {
    const piece = block(0, 'downloading', { en0: 0 }, {
      kind: 'torrent',
      interfaceId: 'en0',
      provisionalBytes: 0.2 * MB
    } as Partial<DownloadUnitState>)
    const { container, unmount } = render(
      <BlockGrid
        blocks={[
          piece,
          block(1, 'pending', {}, {
            kind: 'torrent',
            provisionalBytes: 0
          } as Partial<DownloadUnitState>)
        ]}
        groups={GROUPS}
        visuals={VISUALS}
        knownSize
        remainingBytes={0}
        pieces
      />
    )
    measure(200)
    expect(screen.getByRole('group', { name: 'Piece map' })).toBeTruthy()
    fireEvent.mouseEnter(container.querySelector('[data-chunk="1"]')!)
    expect(screen.getByText(/KB more received and awaiting verification/)).toBeTruthy()
    unmount()

    render(
      <BlockGrid
        blocks={[
          block(0, 'completed', { en0: MB }, { kind: 'stream' }),
          block(1, 'pending', {}, { kind: 'stream' })
        ]}
        groups={GROUPS}
        visuals={VISUALS}
        knownSize
        remainingBytes={0}
      />
    )
    measure(200)
    expect(screen.getByText(/^2 segments\. Point at one/)).toBeTruthy()
  })

  it('reads a skipped piece and a missing article in words', () => {
    const { container } = render(
      <BlockGrid
        blocks={[
          block(0, 'skipped' as DownloadUnitState['status']),
          block(1, 'missing' as DownloadUnitState['status'], {}, { kind: 'nzb' })
        ]}
        groups={GROUPS}
        visuals={VISUALS}
        knownSize
        remainingBytes={0}
        articles
      />
    )
    measure(200)
    expect(screen.getByRole('group', { name: 'Article map' })).toBeTruthy()
    fireEvent.mouseEnter(container.querySelector('[data-chunk="1"]')!)
    expect(screen.getByText(/skipped: in no file chosen$/)).toBeTruthy()
    fireEvent.mouseEnter(container.querySelector('[data-chunk="2"]')!)
    expect(screen.getByText(/missing on the server: needs a par2 repair$/)).toBeTruthy()
  })

  it('without chunks, shows one bar of each network’s share', () => {
    const { container } = render(
      <BlockGrid
        blocks={[block(0, 'downloading')]}
        groups={GROUPS}
        visuals={VISUALS}
        knownSize
        remainingBytes={MB}
      />
    )
    expect(container.firstElementChild!.className).toContain('rounded-full')
    expect(container.firstElementChild!.children).toHaveLength(3)
    const unknown = render(
      <BlockGrid groups={GROUPS} visuals={VISUALS} knownSize={false} remainingBytes={0} />
    )
    expect(unknown.container.querySelector('.bg-primary')).toBeTruthy()
  })
})

describe('ThroughputChart', () => {
  const order = [
    { interfaceId: 'en0', solid: 'var(--color-wifi)', name: 'Wi-Fi' },
    { interfaceId: 'en5', solid: 'var(--color-ethernet)', name: 'Ethernet' }
  ]
  const history = { en0: [MB, 2 * MB, 3 * MB], en5: [MB, MB, MB] }

  it('is one image for assistive tech, read second by second with the arrow keys', async () => {
    render(<ThroughputChart order={order} historyByInterface={history} />)
    const chart = screen.getByRole('img', {
      name: /^Merged throughput over the last minute, split by network\. Now /
    })
    chart.focus()
    const user = userEvent.setup()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByText('Merged')).toBeTruthy()
    expect(screen.getAllByText('Now').length).toBeGreaterThan(1)
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByText('1 s ago')).toBeTruthy()
    await user.keyboard('{ArrowRight}{Escape}')
    expect(screen.queryByText('Merged')).toBeNull()
    expect(screen.getByText('60 s ago')).toBeTruthy()
    // Two networks: one 2px line of the ground between them, and the total in ink.
    const svg = chart.querySelector('svg')!
    expect(svg.querySelectorAll('polygon')).toHaveLength(2)
    expect(svg.querySelectorAll('polyline')).toHaveLength(2)
  })

  it('says where a paused or finished minute ends, and follows the pointer', () => {
    const { rerender } = render(
      <ThroughputChart order={order} historyByInterface={history} endsAt="pause" />
    )
    expect(screen.getByText('60 s before the pause')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    rerender(<ThroughputChart order={order} historyByInterface={history} endsAt="end" />)
    expect(screen.getByText('Finished')).toBeTruthy()
    const chart = screen.getByRole('img')
    chart.getBoundingClientRect = () => ({ left: 0, width: 590 }) as DOMRect
    fireEvent.pointerMove(chart, { clientX: 580 })
    expect(screen.getByText('Merged')).toBeTruthy()
    fireEvent.pointerLeave(chart)
    expect(screen.queryByText('Merged')).toBeNull()
  })
})

describe('Sparkline', () => {
  it('reports the sample under the pointer, and marks it', () => {
    const onHover = vi.fn()
    const { container, rerender } = render(
      <Sparkline
        values={[1, 2, 3]}
        top={3}
        color="red"
        label="Wi-Fi: 3 B/s"
        hovered={null}
        onHover={onHover}
      />
    )
    const area = container.firstElementChild as HTMLElement
    area.getBoundingClientRect = () => ({ left: 0, width: 590 }) as DOMRect
    fireEvent.pointerMove(area, { clientX: 590 })
    expect(onHover).toHaveBeenLastCalledWith(2)
    fireEvent.pointerMove(area, { clientX: 0 })
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.pointerLeave(area)
    rerender(
      <Sparkline
        values={[1, 2, 3]}
        top={3}
        color="red"
        label="Wi-Fi: 3 B/s"
        hovered={2}
        onHover={onHover}
      />
    )
    expect(container.querySelector('.border-dashed')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Wi-Fi: 3 B/s' })).toBeTruthy()
  })
})
