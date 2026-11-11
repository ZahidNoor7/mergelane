import { roleOf } from '@shared/networkRoles'
import type { NetworkRole } from '@shared/types'
import { ChevronsUpDown } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { ROLE_CHOICES, roleLabel } from './networkStatus'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

// Networks › a network's role for Mergelane's own downloads (ADR-0045): a pop-up button where the
// line's "Use for new downloads" switch was, as a Mac list puts a choice of a few in a row. Each
// choice says what it does, so the menu is its own hint.

export function NetworkRoleMenu({
  networkId,
  name
}: {
  networkId: string
  /** The network's name as shown. */
  name: string
}): React.JSX.Element {
  const role = useAppStore((store) => roleOf(store.networkPreferences[networkId]))
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  // Any choice also puts it back in New download's pick (`off`): picking Use here means use it.
  const choose = (next: NetworkRole): void =>
    setNetworkPreference(networkId, { role: next === 'use' ? undefined : next, off: undefined })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="xs"
            aria-label={`${name} for downloads: ${roleLabel(role)}`}
            className="min-w-[5.75rem] justify-between"
          >
            {roleLabel(role)}
            <ChevronsUpDown aria-hidden data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{name} for downloads</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={role}>
            {ROLE_CHOICES.map((choice) => (
              <DropdownMenuRadioItem
                key={choice.role}
                value={choice.role}
                label={choice.label}
                closeOnClick
                onClick={() => choose(choice.role)}
                className="items-start py-1.5"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-[580]">{choice.label}</span>
                  <span className="text-[12px] leading-[1.4] text-ink-3">{choice.hint}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
