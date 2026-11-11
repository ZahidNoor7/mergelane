import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './alert'
import { Badge, badgeVariants } from './badge'
import { Button, buttonVariants } from './button'
import { Checkbox } from './checkbox'
import { Input } from './input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea
} from './input-group'
import { Textarea } from './textarea'
import { Toggle, toggleVariants } from './toggle'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

// The basic controls in the final design's look (design-system/mergelane/MASTER.md, Components):
// capsules, the 2px focus outline, the 3:1 control edge, and the app's existing variant names.

describe('Button', () => {
  it('is a capsule with the design’s press feedback and focus outline', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>New download</Button>)
    const button = screen.getByRole('button', { name: 'New download' })
    for (const name of [
      'rounded-full',
      'bg-primary',
      'motion-safe:active:scale-[0.96]',
      'focus-visible:outline-2'
    ]) {
      expect(button.className).toContain(name)
    }
    await userEvent.setup().click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps every variant and size the app uses', () => {
    const variants = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
    const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const
    for (const variant of variants) {
      for (const size of sizes) expect(buttonVariants({ variant, size })).toContain('rounded-full')
    }
    // Outline looks like the design's secondary; destructive uses the danger tints.
    expect(buttonVariants({ variant: 'outline' })).toContain(
      'shadow-[inset_0_0_0_1px_var(--border)]'
    )
    expect(buttonVariants({ variant: 'destructive' })).toContain('bg-destructive-soft')
    expect(buttonVariants({ size: 'icon-sm' })).toContain('size-7')
  })

  it('does nothing while disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Start
      </Button>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Toggle and ToggleGroup', () => {
  it('a default group is a segmented control on the sunken track', async () => {
    const onValueChange = vi.fn()
    render(
      <ToggleGroup aria-label="Speed units" defaultValue={['bytes']} onValueChange={onValueChange}>
        <ToggleGroupItem value="bytes">MB/s</ToggleGroupItem>
        <ToggleGroupItem value="bits">Mbps</ToggleGroupItem>
      </ToggleGroup>
    )
    const group = screen.getByRole('group', { name: 'Speed units' })
    expect(group.className).toContain('ml-seg')
    expect(group.className).toContain('bg-sunken')
    const bits = screen.getByRole('button', { name: 'Mbps' })
    expect(bits.className).toContain('aria-pressed:bg-card')
    await userEvent.setup().click(bits)
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(['bits'])
    expect(bits.getAttribute('aria-pressed')).toBe('true')
  })

  it('a pill group is chips, with no track', () => {
    render(
      <ToggleGroup aria-label="Schedule days" variant="pill" size="xs" spacing={1}>
        <ToggleGroupItem value="mon">Mon</ToggleGroupItem>
      </ToggleGroup>
    )
    expect(screen.getByRole('group', { name: 'Schedule days' }).className).not.toContain('ml-seg')
    const chip = screen.getByRole('button', { name: 'Mon' })
    expect(chip.className).toContain('aria-pressed:bg-selected')
    // 24px: WCAG 2.5.8's minimum target.
    expect(chip.className).toContain('h-6')
  })

  it('an outline group has no track either, and a lone toggle presses', async () => {
    render(
      <>
        <ToggleGroup aria-label="Outline" variant="outline">
          <ToggleGroupItem value="a">A</ToggleGroupItem>
        </ToggleGroup>
        <Toggle aria-label="Pin" size="lg">
          Pin
        </Toggle>
      </>
    )
    expect(screen.getByRole('group', { name: 'Outline' }).className).not.toContain('ml-seg')
    const pin = screen.getByRole('button', { name: 'Pin' })
    await userEvent.setup().click(pin)
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(toggleVariants({ size: 'sm' })).toContain('h-7')
  })
})

describe('Badge', () => {
  it('is the design’s tag in every variant', () => {
    render(<Badge>Torrent</Badge>)
    expect(screen.getByText('Torrent').className).toContain('rounded-full')
    for (const variant of [
      'default',
      'secondary',
      'destructive',
      'outline',
      'ghost',
      'link'
    ] as const) {
      expect(badgeVariants({ variant })).toContain('text-[11.5px]')
    }
    expect(badgeVariants({ variant: 'destructive' })).toContain('bg-destructive-soft')
  })
})

describe('Fields', () => {
  it('input and textarea have the 3:1 control edge and show an invalid value', () => {
    render(
      <>
        <Input aria-label="Host" aria-invalid />
        <Textarea aria-label="Trackers" />
      </>
    )
    const host = screen.getByRole('textbox', { name: 'Host' })
    expect(host.className).toContain('rounded-full')
    expect(host.className).toContain('shadow-[inset_0_0_0_1px_var(--control)]')
    expect(host.className).toContain('aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]')
    expect(screen.getByRole('textbox', { name: 'Trackers' }).className).toContain('rounded-lg')
  })

  it('an input group draws the edge once, around its parts', async () => {
    const onClick = vi.fn()
    render(
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>⌘F</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput aria-label="Search downloads" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="Clear" onClick={onClick}>
            ×
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupTextarea aria-label="Notes" />
      </InputGroup>
    )
    const group = screen.getAllByRole('group')[0]
    expect(group.className).toContain('rounded-full')
    expect(group.className).toContain('shadow-[inset_0_0_0_1px_var(--control)]')
    const search = screen.getByRole('textbox', { name: 'Search downloads' })
    expect(search.className).toContain('shadow-none')
    expect(search.className).toContain('focus-visible:outline-none')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClick).toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Notes' }).className).toContain('resize-none')
  })

  it('a checkbox is ticked by a click', async () => {
    const onCheckedChange = vi.fn()
    render(<Checkbox aria-label="Use Wi-Fi" onCheckedChange={onCheckedChange} />)
    const box = screen.getByRole('checkbox', { name: 'Use Wi-Fi' })
    expect(box.className).toContain('shadow-[inset_0_0_0_1.5px_var(--control)]')
    await userEvent.setup().click(box)
    expect(onCheckedChange.mock.calls[0][0]).toBe(true)
  })
})

describe('Alert', () => {
  it('is a notice on the card, or in the danger tints', () => {
    render(
      <>
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>Your limits are on.</AlertDescription>
          <AlertAction>Undo</AlertAction>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>Check the schedule</AlertTitle>
        </Alert>
      </>
    )
    const [plain, danger] = screen.getAllByRole('alert')
    expect(plain.className).toContain('bg-card')
    expect(danger.className).toContain('bg-destructive-soft')
    expect(screen.getByText('Undo')).toBeTruthy()
  })
})
