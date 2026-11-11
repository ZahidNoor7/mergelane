import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from './alert-dialog'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './context-menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from './dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from './popover'

// What floats above the window takes the design's sheet shadow (which carries its own 1px edge),
// highlighted menu items take the design's hover, and modal dialogs sit on the scrim.

describe('Popover', () => {
  it('floats on the sheet shadow', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Networks</PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>Wi-Fi</PopoverTitle>
            <PopoverDescription>Home network</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    )
    const popup = screen.getByText('Wi-Fi').closest('[data-slot="popover-content"]')!
    expect(popup.className).toContain('shadow-[var(--shadow-sheet)]')
    expect(popup.className).not.toContain('ring-foreground/10')
  })
})

describe('DropdownMenu', () => {
  it('floats on the sheet shadow, and its items highlight with the design’s hover', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>More actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Download</DropdownMenuLabel>
            <DropdownMenuItem>
              Open <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Move to Trash</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked>Show finished</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="all">
            <DropdownMenuRadioItem value="all">All downloads</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub defaultOpen>
            <DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Name</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const menus = screen.getAllByRole('menu')
    expect(menus[0].className).toContain('shadow-[var(--shadow-sheet)]')
    for (const name of ['Open', 'Show finished', 'All downloads']) {
      expect(within(menus[0]).getByText(name).closest('[role^="menuitem"]')!.className).toContain(
        'focus:bg-hover'
      )
    }
    expect(screen.getByText('Sort by').className).toContain('data-popup-open:bg-hover')
    expect(screen.getByText('⌘O').className).toContain(
      'group-focus/dropdown-menu-item:text-foreground'
    )
    expect(screen.getByText('Name')).toBeTruthy()
  })
})

describe('ContextMenu', () => {
  it('opens on a right-click, on the sheet shadow, with the design’s hover', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>ubuntu.iso</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel>ubuntu.iso</ContextMenuLabel>
            <ContextMenuItem>
              Show in Finder <ContextMenuShortcut>⌘R</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem checked>Keep in list</ContextMenuCheckboxItem>
          <ContextMenuRadioGroup value="a">
            <ContextMenuRadioItem value="a">Wi-Fi</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSub defaultOpen>
            <ContextMenuSubTrigger>Networks</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Ethernet</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('ubuntu.iso'))
    const menu = screen.getAllByRole('menu')[0]
    expect(menu.className).toContain('shadow-[var(--shadow-sheet)]')
    for (const name of ['Show in Finder', 'Keep in list', 'Wi-Fi']) {
      expect(within(menu).getByText(name).closest('[role^="menuitem"]')!.className).toContain(
        'data-highlighted:bg-hover'
      )
    }
    expect(screen.getByText('Networks').className).toContain('data-open:bg-hover')
  })
})

describe('Dialogs', () => {
  it('a dialog sits on the scrim and floats on the sheet shadow', () => {
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Limits</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Speed & data limits</DialogTitle>
            <DialogDescription>For every network</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <DialogClose>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
    const dialog = screen.getByRole('dialog', { name: 'Speed & data limits' })
    expect(dialog.className).toContain('shadow-[var(--shadow-sheet)]')
    expect(document.querySelector('[data-slot="dialog-overlay"]')!.className).toContain(
      'bg-[var(--scrim)]'
    )
  })

  it('an alert dialog does too', () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogTrigger>Remove</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove it from the list?</AlertDialogTitle>
            <AlertDialogDescription>The file stays on disk.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.className).toContain('shadow-[var(--shadow-sheet)]')
    expect(document.querySelector('[data-slot="alert-dialog-backdrop"]')!.className).toContain(
      'bg-[var(--scrim)]'
    )
    const remove = within(dialog).getByRole('button', { name: 'Remove' })
    expect(remove.className).toContain('rounded-full')
  })
})
