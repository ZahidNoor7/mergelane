import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SafetySettings } from './SafetySettings'

describe('If something goes wrong', () => {
  it('says progress is saved every 2 seconds, and that it is always on', () => {
    render(<SafetySettings />)
    const group = screen.getByRole('region', { name: 'If something goes wrong' })
    expect(group.textContent).toContain(
      'Downloads survive crashes, power cuts and links that stop working.'
    )
    expect(within(group).getByText('Save progress every 2 seconds')).toBeTruthy()
    expect(
      within(group).getByText(
        'Each chunk is written and its place in the file recorded together. After a crash, a force quit or a power cut, downloads resume from the last save.'
      )
    ).toBeTruthy()
    expect(within(group).getByText('Always on')).toBeTruthy()
    // Nothing to switch off.
    expect(within(group).queryByRole('switch')).toBeNull()
  })
})
