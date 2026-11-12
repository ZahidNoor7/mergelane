import type { UpdateChannel } from '@shared/releases'
import type { UpdateState } from '@shared/types'
import { cn } from 'cn'
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  ExternalLink,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useId } from 'react'
import appIcon from '../assets/brand/icon-128.png'
import { useAppStore } from '../store/useAppStore'
import { formatBytes, formatWhen } from '../utils/format'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { onWindows } from '../platformWords'

// Settings › Updates, from the final design (design-system/mergelane/redesign/prototype.html,
// UpdateSettings), checked against GitHub's releases (docs/DECISIONS.md ADR-0036). A found update's
// disk image is downloaded and checked against its published SHA-256, then opened as Mergelane quits:
// the design's "Restart and update", for an app that can't replace itself while it is ad-hoc signed.
// A release without a disk image to check is opened on GitHub instead.

const CHANNELS: { value: UpdateChannel; label: string }[] = [
  { value: 'stable', label: 'Stable' },
  { value: 'beta', label: 'Beta' }
]

/** "Last checked just now", "… 12 min ago", "… today 08:55", "… 9 Nov 2026" (format.ts's
 * formatWhen, mid-sentence). */
function lastCheckedTitle(time: number): string {
  const when = formatWhen(time, Date.now())
  // Only formatWhen's own words; a date stays as the locale writes it ("Nov 9, 2026").
  return `Last checked ${when.replace(/^(Just now|Today|Yesterday)/, (word) => word.toLowerCase())}`
}

function releaseDate(time: number): string {
  return new Date(time).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

/** The status card's title and words, and whether it's the accent kind (something to do). */
function describe(update: UpdateState): { title: string; body: string; accent: boolean } {
  const { status, version, channel, latest, lastChecked, skipped, autoCheck, error } = update
  switch (status) {
    case 'checking':
      return {
        title: 'Checking for updates…',
        body: 'Asking GitHub for the newest release.',
        accent: false
      }
    case 'available': {
      const facts = [
        latest?.publishedAt ? `Released ${releaseDate(latest.publishedAt)}` : null,
        latest?.dmg ? formatBytes(latest.dmg.size) : null
      ].filter(Boolean)
      return {
        title: `Mergelane ${latest?.version} is available`,
        body: `You have ${version}.${facts.length > 0 ? ` ${facts.join(', ')}.` : ''}`,
        accent: true
      }
    }
    case 'downloading': {
      const received = update.progress?.received ?? 0
      const total = update.progress?.total ?? latest?.dmg?.size ?? 0
      return {
        title: `Downloading ${latest?.version}…`,
        body: `${formatBytes(received)} of ${formatBytes(total)}`,
        accent: true
      }
    }
    case 'verifying':
      return {
        title: 'Checking the download…',
        body: 'Comparing it with the SHA-256 published with the release.',
        accent: true
      }
    case 'ready':
      return {
        title: `${latest?.version} is ready to install`,
        body: onWindows()
          ? 'Mergelane quits and the installer replaces this version, then opens the new one. Running downloads pause and pick up where they left off.'
          : 'Mergelane quits and opens the disk image: drag Mergelane to Applications to replace this version. Running downloads pause and pick up where they left off.',
        accent: true
      }
    case 'current':
      return {
        title: 'Mergelane is up to date',
        body: `${version} is the newest ${channel} version.`,
        accent: false
      }
    case 'error':
      return {
        title: latest ? `Couldn’t download ${latest.version}` : 'Couldn’t check for updates',
        body: error ?? '',
        accent: false
      }
    default:
      return {
        title: lastChecked === null ? 'Not checked yet' : lastCheckedTitle(lastChecked),
        body: skipped
          ? `Skipped ${skipped}. You’ll hear about the next one.`
          : autoCheck
            ? 'Mergelane checks once a day while it runs.'
            : 'Automatic checks are off. Check whenever you like.',
        accent: false
      }
  }
}

export function UpdateSettings(): React.JSX.Element {
  const update = useAppStore((store) => store.update)
  const autoId = useId()
  const backgroundId = useId()
  if (!update) return <p className="px-1 text-[12.5px] text-ink-3">Reading the update settings…</p>

  const { status, latest, channel, autoCheck, backgroundDownload, version, progress } = update
  const { title, body, accent } = describe(update)
  const checking = status === 'checking'
  const busy = checking || status === 'downloading' || status === 'verifying'
  // As the design: no new check while an update waits to be taken or skipped.
  const canCheck = !busy && status !== 'available' && status !== 'ready'
  const percent =
    progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0
  const showNotes =
    latest !== null &&
    (status === 'available' ||
      status === 'downloading' ||
      status === 'verifying' ||
      status === 'ready')
  const canDownload = latest?.dmg != null && latest.checksumsUrl !== null
  const StatusIcon =
    status === 'current'
      ? CircleCheck
      : status === 'error'
        ? CircleAlert
        : busy
          ? RefreshCw
          : accent
            ? Sparkles
            : Clock

  return (
    <>
      <section
        aria-label="Mergelane version"
        className="flex flex-col gap-4 rounded-[14px] bg-card p-4 shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <img
            src={appIcon}
            width={56}
            height={56}
            alt=""
            aria-hidden
            draggable={false}
            className="-m-1 shrink-0 select-none"
          />
          <div className="flex min-w-0 flex-1 basis-48 flex-col">
            <span className="text-[18px] leading-none font-[600] tracking-[-0.01em]">
              Mergelane
            </span>
            <p className="text-[12.5px] text-ink-2">
              Version{' '}
              <span className="figures text-[13.5px] font-[620] text-foreground">{version}</span>,{' '}
              {channel === 'beta' ? 'beta' : 'stable'} channel
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canCheck}
            onClick={() => void window.mergelane.checkForUpdates()}
          >
            <RefreshCw aria-hidden className={cn(checking && 'motion-safe:animate-spin')} />
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
        </div>
        <div
          role="status"
          aria-atomic="true"
          className={cn(
            'flex flex-col gap-2.5 rounded-[11px] p-3',
            accent
              ? 'bg-[var(--color-accent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-accent)_30%,transparent)]'
              : 'bg-sunken shadow-[inset_0_0_0_1px_var(--border-subtle)]'
          )}
        >
          <div className="flex items-start gap-2.5">
            <StatusIcon
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0',
                accent ? 'text-[var(--color-accent-ink)]' : 'text-ink-2',
                busy && 'motion-safe:animate-spin'
              )}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[13.5px] font-[640]">{title}</p>
              {body && (
                <p className="max-w-[64ch] text-[12.5px] leading-[1.5] text-ink-2">{body}</p>
              )}
            </div>
          </div>
          {status === 'downloading' && latest && (
            <div
              role="progressbar"
              aria-label={`Downloading ${latest.version}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-track"
            >
              <span
                className="block h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {showNotes && latest && (latest.notes.summary || latest.notes.items.length > 0) && (
            <div className="flex flex-col gap-1 border-t border-rule pt-2.5">
              <p className="text-[12.5px] font-[620]">What’s new in {latest.version}</p>
              {latest.notes.summary && (
                <p className="max-w-[64ch] text-[12.5px] leading-[1.5] text-ink-2">
                  {latest.notes.summary}
                </p>
              )}
              {latest.notes.items.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {latest.notes.items.map((item) => (
                    <li key={item} className="flex gap-2 text-[12.5px] leading-[1.5] text-ink-2">
                      <span
                        aria-hidden
                        className="mt-[0.55em] size-1 shrink-0 rounded-full bg-[var(--text-tertiary)]"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {latest && (status === 'available' || status === 'error') && (
            <div className="flex flex-wrap items-center gap-2">
              {!canDownload ? (
                <Button size="sm" onClick={() => void window.mergelane.openReleasePage()}>
                  <ExternalLink aria-hidden />
                  Get it from GitHub
                </Button>
              ) : status === 'error' ? (
                <Button size="sm" onClick={() => void window.mergelane.downloadUpdate()}>
                  <RefreshCw aria-hidden />
                  Try again
                </Button>
              ) : (
                <Button size="sm" onClick={() => void window.mergelane.downloadUpdate()}>
                  <Download aria-hidden />
                  Download and install
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.mergelane.skipUpdate(latest.version)}
              >
                Skip this version
              </Button>
            </div>
          )}
          {status === 'downloading' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.mergelane.cancelUpdateDownload()}
              >
                Cancel
              </Button>
            </div>
          )}
          {status === 'ready' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void window.mergelane.installUpdate()}>
                <LogOut aria-hidden />
                Quit and install
              </Button>
            </div>
          )}
        </div>
      </section>

      <SettingsGroup title="Automatic updates">
        <SettingRow
          label="Check for updates automatically"
          hint="Once a day. Mergelane tells you in the sidebar when one is out."
          htmlFor={autoId}
        >
          <Switch
            id={autoId}
            checked={autoCheck}
            onCheckedChange={(on) => void window.mergelane.setUpdatePreferences({ autoCheck: on })}
          />
        </SettingRow>
        <SettingRow
          label="Download updates in the background"
          hint="Only the download happens by itself. Installing always waits for you."
          htmlFor={backgroundId}
        >
          <Switch
            id={backgroundId}
            checked={backgroundDownload}
            disabled={!autoCheck}
            onCheckedChange={(on) =>
              void window.mergelane.setUpdatePreferences({ backgroundDownload: on })
            }
          />
        </SettingRow>
        <SettingRow
          label="Channel"
          hint={
            channel === 'beta'
              ? 'Beta versions arrive a few weeks early and may have rough edges.'
              : 'Tested releases only.'
          }
        >
          <ToggleGroup
            aria-label="Update channel"
            value={[channel]}
            onValueChange={(values) => {
              if (values[0] !== undefined) {
                void window.mergelane.setUpdatePreferences({ channel: values[0] as UpdateChannel })
              }
            }}
          >
            {CHANNELS.map((each) => (
              <ToggleGroupItem key={each.value} value={each.value}>
                {each.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
      </SettingsGroup>

      <aside className="flex gap-3 rounded-[14px] bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
        <p className="max-w-[64ch] text-[12.5px] leading-[1.6] text-ink-2">
          Updates come from Mergelane’s GitHub releases, and each one is checked against the SHA-256
          published with it before it opens.{' '}
          {onWindows()
            ? 'Mergelane isn’t signed yet, so Windows may warn before the installer runs: choose “More info”, then “Run anyway”.'
            : 'Mergelane isn’t signed by Apple yet, so the first time a new version opens, macOS may ask you to confirm in System Settings › Privacy & Security.'}
        </p>
      </aside>
    </>
  )
}
