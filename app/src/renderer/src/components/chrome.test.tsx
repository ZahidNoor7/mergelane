import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useElementWidth } from '../hooks/useElementWidth'
import { useAppStore } from '../store/useAppStore'
import { NetworkTile } from './NetworkTile'
import { SpeedText } from './SpeedText'
import { SpeedUnitToggle } from './SpeedUnitToggle'

// The window frame's small parts (M3.1 pull request 5a): a network's tile, a speed in a line of
// text, the units control, and the width the frame switches layout on.

const MB = 1024 * 1024
const initial = useAppStore.getState()
const updateSettings = vi.fn(() => Promise.resolve())

beforeEach(() => {
  window.mergelane = { ...window.mergelane, updateSettings } as typeof window.mergelane
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('NetworkTile', () => {
  it('draws the kind’s icon on the network’s colour, decorative and full strength by default', () => {
    const { container } = render(<NetworkTile kind="usb" color="red" onColor="white" />)
    const tile = container.firstElementChild as HTMLElement
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.dataset.kind).toBe('usb')
    expect(tile.style.width).toBe('28px')
    expect(tile.style.background).toBe('red')
    expect(tile.style.color).toBe('white')
    expect(tile.style.opacity).toBe('1')
    expect(tile.querySelector('svg')).toBeTruthy()
  })

  it('fades when the network is off or gone, at any size and for every kind', () => {
    for (const kind of ['wifi', 'ethernet', 'bridge', 'other'] as const) {
      const { container } = render(
        <NetworkTile kind={kind} color="blue" onColor="white" size={20} dim />
      )
      const tile = container.firstElementChild as HTMLElement
      expect(tile.style.height).toBe('20px')
      expect(tile.style.opacity).toBe('0.38')
      expect(tile.querySelector('svg')).toBeTruthy()
      cleanup()
    }
  })
})

describe('SpeedText', () => {
  it('sets the unit apart from the figure', () => {
    render(<SpeedText bytesPerSecond={4 * MB} className="extra" />)
    const unit = screen.getByText('MB/s')
    expect(unit.parentElement!.textContent).toBe('4.0MB/s')
    expect(unit.parentElement!.className).toContain('extra')
  })

  it('follows the units chosen', () => {
    useAppStore.setState({ speedUnit: 'bits' })
    render(<SpeedText bytesPerSecond={4 * MB} />)
    expect(screen.getByText('Mbps').parentElement!.textContent).toMatch(/^[\d.]+Mbps$/)
  })

  it('shows a dash for a speed that isn’t there', () => {
    render(<SpeedText bytesPerSecond={4 * MB} dash className="extra" />)
    const dash = screen.getByText('—')
    expect(dash.className).toContain('extra')
    expect(screen.queryByText('MB/s')).toBeNull()
  })
})

describe('SpeedUnitToggle', () => {
  it('switches between MB/s and Mbps, and saves the choice', async () => {
    render(<SpeedUnitToggle />)
    const bytes = screen.getByRole('button', { name: 'MB/s' })
    const bits = screen.getByRole('button', { name: 'Mbps' })
    expect(bytes.getAttribute('aria-pressed')).toBe('true')

    const user = userEvent.setup()
    await user.click(bits)
    expect(useAppStore.getState().speedUnit).toBe('bits')
    expect(updateSettings).toHaveBeenCalledWith({ speedUnit: 'bits' })
    expect(bits.getAttribute('aria-pressed')).toBe('true')
    // The one chosen can't be unpressed into no units at all.
    await user.click(bits)
    expect(useAppStore.getState().speedUnit).toBe('bits')
  })
})

describe('useElementWidth', () => {
  it('is zero until measured, follows the element, and stops when it goes', () => {
    const observers: Array<{
      callback: (entries: Array<{ contentRect: { width: number } }>) => void
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
          observers.push({ callback, observe: this.observe, disconnect: this.disconnect })
        }
      }
    )
    function Measured({ shown }: { shown: boolean }): React.JSX.Element {
      const [ref, width] = useElementWidth()
      return (
        <div>
          <output>{width}</output>
          {shown && <div ref={ref} />}
        </div>
      )
    }
    const { rerender } = render(<Measured shown />)
    expect(screen.getByRole('status').textContent).toBe('0')
    expect(observers).toHaveLength(1)
    expect(observers[0].observe).toHaveBeenCalledTimes(1)

    act(() => observers[0].callback([{ contentRect: { width: 812 } }]))
    expect(screen.getByRole('status').textContent).toBe('812')
    // An observation with no entries reads as nothing measured.
    act(() => observers[0].callback([]))
    expect(screen.getByRole('status').textContent).toBe('0')

    rerender(<Measured shown={false} />)
    expect(observers[0].disconnect).toHaveBeenCalled()
  })
})
