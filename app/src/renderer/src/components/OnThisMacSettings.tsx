import type { LoginItemState } from '@shared/types'
import { useEffect, useId, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Switch } from './ui/switch'

// Settings › General › "On this Mac", from the final design (prototype.html, GeneralSettings):
// Open at login, the merged speed in the menu bar, and a notification when a download finishes
// (docs/DECISIONS.md ADR-0037). Open at login reports what macOS says, since an app that isn't
// notarized may not be taken.

const LOGIN_ITEMS = 'System Settings › General › Login Items'

function loginHint(state: LoginItemState | null): string {
  if (!state) return 'Starts in the menu bar, so scheduled downloads begin on time.'
  switch (state.status) {
    case 'unavailable':
      return 'Only Mergelane installed from its disk image can open at login.'
    case 'requires-approval':
      return `macOS needs your approval: turn Mergelane on in ${LOGIN_ITEMS}.`
    case 'not-registered':
    case 'not-found':
      return state.on
        ? `macOS didn’t take it. Add Mergelane yourself in ${LOGIN_ITEMS}.`
        : 'Starts in the menu bar, so scheduled downloads begin on time.'
    default:
      return 'Starts in the menu bar, so scheduled downloads begin on time.'
  }
}

export function OnThisMacSettings(): React.JSX.Element {
  const menuBarSpeed = useAppStore((store) => store.menuBarSpeed)
  const setMenuBarSpeed = useAppStore((store) => store.setMenuBarSpeed)
  const notifyWhenDone = useAppStore((store) => store.notifyWhenDone)
  const setNotifyWhenDone = useAppStore((store) => store.setNotifyWhenDone)
  const [login, setLogin] = useState<LoginItemState | null>(null)
  // What the user asked for, until macOS answers, so the switch moves at once.
  const [wanted, setWanted] = useState<boolean | null>(null)
  const loginId = useId()
  const menuBarId = useId()
  const notifyId = useId()

  useEffect(() => {
    let current = true
    window.mergelane.loginItem().then(
      (state) => current && setLogin(state),
      () => {}
    )
    return () => {
      current = false
    }
  }, [])

  const changeLogin = (on: boolean): void => {
    setWanted(on)
    window.mergelane.setOpenAtLogin(on).then(
      (state) => {
        setLogin(state)
        setWanted(null)
      },
      () => setWanted(null)
    )
  }

  return (
    <SettingsGroup title="On this Mac">
      <SettingRow label="Open at login" hint={loginHint(login)} htmlFor={loginId}>
        <Switch
          id={loginId}
          checked={wanted ?? login?.on ?? false}
          disabled={!login || login.status === 'unavailable'}
          onCheckedChange={changeLogin}
        />
      </SettingRow>
      <SettingRow label="Show the merged speed in the menu bar" htmlFor={menuBarId}>
        <Switch id={menuBarId} checked={menuBarSpeed} onCheckedChange={setMenuBarSpeed} />
      </SettingRow>
      <SettingRow
        label="Notify me when a download finishes"
        hint="Uses macOS notifications. You can change their style in System Settings › Notifications."
        htmlFor={notifyId}
      >
        <Switch id={notifyId} checked={notifyWhenDone} onCheckedChange={setNotifyWhenDone} />
      </SettingRow>
    </SettingsGroup>
  )
}
