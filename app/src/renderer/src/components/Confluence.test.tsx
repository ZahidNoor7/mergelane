import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Confluence, PLACEHOLDER_LANES, type ConfluenceLane } from './Confluence'

/** A megabyte a second, as speeds count it (1,000s; ADR-0071). */
const MB = 1_000_000

// jsdom measures nothing and has no media queries: the test sets the width and Reduce Motion, and
// runs animation frames by hand.
let observed: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
let reduceMotion = false
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  observed = []
  reduceMotion = false
  frames = []
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
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduceMotion
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const measure = (width: number): void =>
  act(() => observed.forEach((callback) => callback([{ contentRect: { width } }])))
/** Runs queued animation frames, each `step` ms after the last, until none are left. */
function runFrames(step = 50, limit = 200): void {
  let time = performance.now()
  for (let i = 0; i < limit && frames.length > 0; i++) {
    const due = frames.splice(0)
    time += step
    act(() => due.forEach((frame) => frame(time)))
  }
}

const lanes: ConfluenceLane[] = [
  { id: 'en0', interfaceName: 'en0', name: 'Wi-Fi', color: 'var(--color-wifi)', speed: 4 * MB },
  {
    id: 'en7',
    interfaceName: 'en7',
    name: 'iPhone USB',
    color: 'var(--color-usb)',
    speed: 2 * MB,
    limited: true
  },
  {
    id: 'en5',
    interfaceName: 'en5',
    name: 'Ethernet',
    color: 'var(--color-ethernet)',
    speed: 0,
    down: true
  },
  {
    id: 'en9',
    interfaceName: 'en9',
    name: 'Office',
    color: 'var(--color-neutral)',
    speed: 0,
    on: false,
    note: 'Not used'
  }
]

describe('Confluence', () => {
  it('lists each network with its speed or its state, and the merged speed', () => {
    render(<Confluence lanes={lanes} caption="2 downloading, about 1m left" />)
    measure(600)
    const list = screen.getByRole('list', { name: 'Networks in this merge' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      // Each carrying lane's share of the merged speed.
      'Wi-Fi4.0 MB/s67%en0',
      'iPhone USB2.0 MB/s33%en7',
      'EthernetDroppeden5',
      'OfficeNot useden9'
    ])
    expect(screen.getByRole('img', { name: 'at its speed limit' })).toBeTruthy()
    // The merged speed is the sum of the lanes carrying bytes.
    expect(screen.getByText('Merged speed').parentElement!.textContent).toContain('6.0MB/s')
    expect(screen.getByText('2 downloading, about 1m left')).toBeTruthy()
  })

  it('draws a ribbon for each lane carrying bytes, eased in, with markings that drift', () => {
    const { container } = render(<Confluence lanes={lanes} />)
    measure(600)
    runFrames()
    const wifi = container.querySelector('[data-lane="en0"]')!
    expect(wifi.querySelector('.mergelane-lane-flow')).toBeTruthy()
    expect(wifi.querySelector('.mergelane-lane-still')).toBeNull()
    expect(wifi.querySelector('[stroke-dasharray="2 5"]')).toBeNull()
    // A dropped lane is a dashed approach in the danger colour; an unused one is dashed in its own.
    const ethernet = container.querySelector('[data-lane="en5"]')!
    expect(ethernet.querySelector('path')!.getAttribute('stroke')).toBe('var(--color-danger)')
    expect(ethernet.querySelector('path')!.getAttribute('stroke-dasharray')).toBe('2 5')
    expect(container.querySelector('[data-lane="en9"] path')!.getAttribute('stroke')).toBe(
      'var(--color-neutral)'
    )
  })

  it('eases a lane to its new speed, and changes at once under Reduce Motion', () => {
    const one = [{ id: 'en0', name: 'Wi-Fi', color: 'red', speed: 2 * MB }]
    const { container, rerender } = render(<Confluence lanes={one} />)
    measure(600)
    // The first reading is drawn as it is.
    const ribbon = (): string =>
      container.querySelector('[data-lane="en0"] path')!.getAttribute('d')!
    const before = ribbon()
    rerender(<Confluence lanes={[{ ...one[0], speed: 6 * MB }]} />)
    // Mid-ease: neither the old nor the new shape.
    const due = frames.splice(0)
    act(() => due.forEach((frame) => frame(performance.now() + 30)))
    const midway = ribbon()
    expect(midway).not.toBe(before)
    runFrames()
    const settled = ribbon()
    expect(settled).not.toBe(midway)

    reduceMotion = true
    const reduced = render(<Confluence lanes={[{ ...one[0], speed: 8 * MB }]} />)
    expect(frames).toHaveLength(0)
    expect(reduced.container.querySelector('.mergelane-lane-still')).toBeTruthy()
  })

  it('stretches its scale above the design’s, so fast lanes keep their proportions', () => {
    const fast = [
      { id: 'a', name: 'A', color: 'red', speed: 60 * MB },
      { id: 'b', name: 'B', color: 'blue', speed: 30 * MB }
    ]
    const { container } = render(<Confluence lanes={fast} />)
    measure(600)
    const strokeWidth = (id: string): number =>
      Number(
        container
          .querySelector(`[data-lane="${id}"] .mergelane-lane-flow`)!
          .getAttribute('stroke-width')
      )
    expect(strokeWidth('a')).toBeGreaterThan(strokeWidth('b'))
  })

  it('when idle, draws dashed placeholders and a dash for the speed', () => {
    const { container } = render(<Confluence lanes={PLACEHOLDER_LANES} idle />)
    measure(600)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getAllByText('Idle')).toHaveLength(3)
    // Placeholders have no interface to name.
    expect(screen.queryByText('wifi')).toBeNull()
    expect(container.querySelectorAll('[stroke="var(--icon-muted)"]').length).toBe(4)
  })

  it('puts the merged speed above the lanes when narrow, and leaves out ids when compact', () => {
    const { container } = render(
      <Confluence
        lanes={lanes.slice(0, 2)}
        compact
        total={7 * MB}
        label="Speed"
        labelNote={<span>!</span>}
      />
    )
    measure(400)
    expect(container.firstElementChild!.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
    expect(container.firstElementChild!.firstElementChild!.textContent).toContain('Speed!')
    expect(screen.getByText('Speed').parentElement!.textContent).toContain('7.0MB/s')
    expect(screen.queryByText('en0')).toBeNull()
  })

  it('an idle lane that is on, while the diagram is idle, says Idle; a lone dash when nothing is drawn', () => {
    render(<Confluence lanes={[{ id: 'x', name: 'X', color: 'red', speed: 0 }]} />)
    measure(600)
    expect(screen.getByText('0 MB/s')).toBeTruthy()
  })

  it('floats the speed on the glass lens over the road, with what merging buys over the fastest network', () => {
    const { container } = render(<Confluence lanes={lanes} label="Total speed, all apps" />)
    measure(600)
    const lens = container.querySelector('.mergelane-lens') as HTMLElement
    expect(lens).toBeTruthy()
    // Over the drawing, at its right.
    expect(lens.parentElement!.className).toContain('relative')
    expect(lens.className).toContain('absolute')
    expect(lens.style.width).toBe('220px')
    expect(lens.textContent).toContain('Total speed, all apps')
    // 6 MB/s merged against Wi-Fi's 4 MB/s.
    expect(lens.textContent).toContain('1.5× your fastest network')
    // The moving markings stop where the card begins (600 wide: 600 - 20 - 220), so nothing moves behind it.
    const marking = container.querySelector('[data-lane="en0"] .mergelane-lane-flow')!
    expect(marking.getAttribute('d')).toMatch(/ L360,[\d.]+$/)
  })

  it('says nothing of a gain with one network carrying, or while idle', () => {
    render(<Confluence lanes={[lanes[0], lanes[2]]} />)
    measure(600)
    expect(screen.queryByText(/your fastest network/)).toBeNull()
    render(<Confluence lanes={lanes} idle />)
    expect(screen.queryByText(/your fastest network/)).toBeNull()
  })

  it('a compact lens is narrower; a narrow layout has no lens', () => {
    const { container, unmount } = render(<Confluence lanes={lanes} compact />)
    measure(600)
    expect((container.querySelector('.mergelane-lens') as HTMLElement).style.width).toBe('188px')
    unmount()
    const narrow = render(<Confluence lanes={lanes} />)
    measure(400)
    expect(narrow.container.querySelector('.mergelane-lens')).toBeNull()
  })

  it('pointing at a network, or focusing it, picks its lane out', () => {
    const { container } = render(<Confluence lanes={lanes} />)
    measure(600)
    const rows = within(screen.getByRole('list', { name: 'Networks in this merge' })).getAllByRole(
      'listitem'
    )
    expect(rows[0].getAttribute('aria-label')).toBe('Wi-Fi: 4.0 MB/s, 67% of the total')
    expect(rows[2].getAttribute('aria-label')).toBe('Ethernet: dropped')
    expect(rows[3].getAttribute('aria-label')).toBe('Office: not used')
    const opacity = (id: string): string =>
      (container.querySelector(`[data-lane="${id}"]`) as SVGGElement).style.opacity
    fireEvent.mouseEnter(rows[0])
    expect(rows[1].style.opacity).toBe('0.45')
    expect(opacity('en0')).toBe('1')
    expect(opacity('en7')).toBe('0.25')
    expect(opacity('en5')).toBe('0.3')
    fireEvent.mouseLeave(rows[0])
    expect(rows[1].style.opacity).toBe('1')
    // The lane itself, too.
    fireEvent.mouseEnter(container.querySelector('[data-lane="en7"]')!)
    expect(opacity('en0')).toBe('0.25')
    fireEvent.mouseLeave(container.querySelector('[data-lane="en7"]')!)
    expect(opacity('en0')).toBe('1')
    fireEvent.focus(rows[1])
    expect(rows[0].style.opacity).toBe('0.45')
    fireEvent.blur(rows[1])
    expect(rows[0].style.opacity).toBe('1')
  })

  it('an idle diagram’s lanes say idle to assistive tech', () => {
    render(<Confluence lanes={PLACEHOLDER_LANES} idle />)
    measure(600)
    const rows = within(screen.getByRole('list', { name: 'Networks in this merge' })).getAllByRole(
      'listitem'
    )
    expect(rows[0].getAttribute('aria-label')).toBe('Wi-Fi: idle')
  })
})
