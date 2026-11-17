import type { MenuBarSpeedText } from '@shared/menuBarPanel'
import type { LoginItemState } from '@shared/types'
import { useEffect, useId, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { onWindows, words } from '../platformWords'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Settings › General › "On this Mac", from the final design (prototype.html, GeneralSettings):
// Open at login, Mergelane in the menu bar and the speed beside its icon, and a notification when a
// download finishes (docs/DECISIONS.md ADR-0037, ADR-0067, ADR-0069). Open at login reports what macOS says, since an app that isn't
// notarized may not be taken. On Windows it is "On this PC", with the notification area for the
// menu bar (whose switch there also keeps Mergelane running when the window is closed), and Windows'
// own places to look.

const LOGIN_ITEMS = 'System Settings › General › Login Items'

/** The speed beside the menu bar icon (ADR-0069). */
const SPEED_TEXT_CHOICES: { value: MenuBarSpeedText; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'on', label: 'Always' },
  { value: 'off', label: 'Never' }
]

const SPEED_TEXT_HINTS: Record<MenuBarSpeedText, string> = {
  auto: 'Shows only while 2 or more networks are connected, so it takes no room when there’s nothing to combine.',
  on: 'Always shows the download and upload speed beside the icon.',
  off: 'Just the icon. Click it to see the speeds.'
}

function loginHint(state: LoginItemState | null): string {
  const starts = `Starts in ${words().statusArea}, so scheduled downloads begin on time.`
  if (onWindows()) {
    if (state?.status === 'unavailable') {
      return 'Only Mergelane installed with its installer can open at login.'
    }
    return state?.on ? `${starts} Windows lists it in Settings › Apps › Startup.` : starts
  }
  if (!state) return starts
  switch (state.status) {
    case 'unavailable':
      return 'Only Mergelane installed from its disk image can open at login.'
    case 'requires-approval':
      return `macOS needs your approval: turn Mergelane on in ${LOGIN_ITEMS}.`
    case 'not-registered':
    case 'not-found':
      return state.on ? `macOS didn’t take it. Add Mergelane yourself in ${LOGIN_ITEMS}.` : starts
    default:
      return starts
  }
}

export function OnThisMacSettings(): React.JSX.Element {
  const menuBarSpeed = useAppStore((store) => store.menuBarSpeed)
  const setMenuBarSpeed = useAppStore((store) => store.setMenuBarSpeed)
  const menuBarSpeedText = useAppStore((store) => store.menuBarSpeedText)
  const setMenuBarSpeedText = useAppStore((store) => store.setMenuBarSpeedText)
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
    <SettingsGroup title={`On ${words().thisComputer}`}>
      <SettingRow
        label={onWindows() ? 'Start with Windows' : 'Open at login'}
        hint={loginHint(login)}
        htmlFor={loginId}
      >
        <Switch
          id={loginId}
          checked={wanted ?? login?.on ?? false}
          disabled={!login || login.status === 'unavailable'}
          onCheckedChange={changeLogin}
        />
      </SettingRow>
      {onWindows() ? (
        // The notification-area icon on Windows keeps Mergelane running when its window is closed, and shows
        // the merged speed when pointed at (main/notificationArea.ts, ADR-0061).
        <SettingRow
          label="Keep running in the notification area when I close the window"
          hint="Downloads carry on. Point at the Mergelane icon to see the merged speed; right-click it to exit."
          htmlFor={menuBarId}
        >
          <Switch id={menuBarId} checked={menuBarSpeed} onCheckedChange={setMenuBarSpeed} />
        </SettingRow>
      ) : (
        <>
          {/* The icon and its menu (ADR-0067); the speed beside it, automatic by default (ADR-0069). */}
          <SettingRow
            label={`Show Mergelane in ${words().statusArea}`}
            hint="Click its icon to see each network’s speed, and to pause or start downloads."
            htmlFor={menuBarId}
          >
            <Switch id={menuBarId} checked={menuBarSpeed} onCheckedChange={setMenuBarSpeed} />
          </SettingRow>
          <SettingRow
            label="Speed beside the icon"
            hint={
              menuBarSpeed
                ? `${SPEED_TEXT_HINTS[menuBarSpeedText]} With System merge on, it’s ${words().thisComputer}’s whole speed; otherwise Mergelane’s.`
                : `Turn on Show Mergelane in ${words().statusArea} first.`
            }
          >
            <ToggleGroup
              aria-label="Speed beside the icon"
              disabled={!menuBarSpeed}
              value={[menuBarSpeedText]}
              onValueChange={(values) => {
                const next = values[0] as MenuBarSpeedText | undefined
                if (next) setMenuBarSpeedText(next)
              }}
            >
              {SPEED_TEXT_CHOICES.map((choice) => (
                <ToggleGroupItem key={choice.value} value={choice.value}>
                  {choice.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingRow>
        </>
      )}
      <SettingRow
        label="Notify me when a download finishes"
        hint={
          onWindows()
            ? 'Uses Windows notifications. You can change them in Settings › System › Notifications.'
            : 'Uses macOS notifications. You can change their style in System Settings › Notifications.'
        }
        htmlFor={notifyId}
      >
        <Switch id={notifyId} checked={notifyWhenDone} onCheckedChange={setNotifyWhenDone} />
      </SettingRow>
    </SettingsGroup>
  )
}
