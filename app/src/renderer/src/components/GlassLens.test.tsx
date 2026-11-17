import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GlassLens } from './GlassLens'

// The frosted card under the Confluence's speed (ADR-0070, ADR-0071).

describe('GlassLens', () => {
  it('is frosted glass, sized and placed by its caller', () => {
    const { container } = render(
      <GlassLens className="absolute" style={{ width: 220 }}>
        <span>32.9 MB/s</span>
      </GlassLens>
    )
    const pane = container.firstElementChild as HTMLElement
    expect(pane.className).toBe('mergelane-lens absolute')
    expect(pane.style.width).toBe('220px')
    expect(pane.textContent).toBe('32.9 MB/s')
    // No refraction to redraw as the lanes move behind it.
    expect(container.querySelector('filter')).toBeNull()
  })

  it('off: a plain block, with no glass', () => {
    const { container } = render(
      <GlassLens off className="flex">
        <span>Speed</span>
      </GlassLens>
    )
    expect((container.firstElementChild as HTMLElement).className).toBe('flex')
  })
})
