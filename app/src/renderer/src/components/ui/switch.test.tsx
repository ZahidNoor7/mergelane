import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './switch'

describe('Switch', () => {
  it('is a labelled switch that reports each change', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Slow mode" onCheckedChange={onCheckedChange} />)

    const control = screen.getByRole('switch', { name: 'Slow mode' })
    expect(control.getAttribute('aria-checked')).toBe('false')
    await user.click(control)
    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange.mock.calls[0][0]).toBe(true)
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps its own classes and adds the caller’s', () => {
    render(<Switch aria-label="Slow mode" className="ml-2" />)
    const control = screen.getByRole('switch', { name: 'Slow mode' })
    expect(control.className).toContain('ml-2')
    expect(control.className).toContain('rounded-full')
  })

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Slow mode" disabled onCheckedChange={onCheckedChange} />)
    await user.click(screen.getByRole('switch', { name: 'Slow mode' }))
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})
