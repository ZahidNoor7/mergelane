import { useId, useState } from 'react'
import type { SystemMergeOutage } from '../../../shared/types'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { words } from '../platformWords'
import { useSystemMerge } from '../hooks/useSystemMerge'
import { formatEta, formatWhen } from '../utils/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button, buttonVariants } from './ui/button'
import { Switch } from './ui/switch'

const STATE_TEXT = {
  on: 'On',
  off: 'Off',
  starting: 'Turning on…',
  stopping: 'Turning off…'
} as const

/** With merging off, link changes older than this aren't worth a line. */
const RECENT_MS = 10 * 60_000
/** How many of the latest link changes the history shows. */
const HISTORY_ROWS = 3

/** "2 min ago", or "today 08:55": formatWhen, lower-cased to sit mid-sentence. */
function when(at: string, now: number): string {
  const text = formatWhen(Date.parse(at), now)
  return /^(Just now|Today|Yesterday)/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text
}

/** "en5 dropped 2 min ago · back after 40s", the way the failover history reads. */
function OutageRow({ outage, now }: { outage: SystemMergeOutage; now: number }): React.JSX.Element {
  const back = outage.backAt ? Date.parse(outage.backAt) - Date.parse(outage.at) : null
  return (
    <li className="text-[12px] text-muted-foreground">
      <span className="font-mono text-[11.5px]">{outage.link}</span>{' '}
      {outage.kind === 'gone' ? 'disconnected' : 'dropped'}{' '}
      <time dateTime={outage.at}>{when(outage.at, now)}</time>
      {back === null ? (
        <span className="text-[var(--color-danger)]"> · still out</span>
      ) : (
        <span> · back after {formatEta(Math.max(1, Math.round(back / 1000)))}</span>
      )}
    </li>
  )
}

/** System-wide merging (mergelane-daemon) at the foot of the networks menu: a switch, why it is
 * off when nobody turned it off, each link's merged traffic while it's on, the latest link
 * dropouts, whether it turns itself back on after a crash, and an update when the running helper
 * isn't the one this app bundles. It lives here because it is about the same networks. At its foot,
 * while the helper is installed, "Remove helper…" takes it off the Mac again, after a confirmation
 * (ADR-0046). */
export function SystemMergeSection({ open }: { open: boolean }): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const { snapshot, now, busy, pending, removal, run, remove } = useSystemMerge(open)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const descriptionId = useId()
  const updateId = useId()
  const autoResumeId = useId()
  const autoResumeHelpId = useId()
  const stickyId = useId()
  const stickyHelpId = useId()
  const removeHelpId = useId()

  if (!snapshot) {
    return (
      <div className="border-t-[0.5px] border-border px-4 py-3 text-[12px] text-muted-foreground">
        Checking system merge…
      </div>
    )
  }

  const on = snapshot.state === 'on' || snapshot.state === 'starting'
  const note = snapshot.error ?? snapshot.reason
  // A reason while it's on is news, not a problem: it came back on by itself after a crash.
  const noteIsNews = !snapshot.error && on
  const outages = snapshot.outages
    .filter((outage) => on || now - Date.parse(outage.backAt ?? outage.at) < RECENT_MS)
    .slice(-HISTORY_ROWS)
    .reverse()
  return (
    <section
      aria-label="System merge"
      className="flex flex-col gap-2 border-t-[0.5px] border-border px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13.5px] font-medium">System merge</span>
          <span id={descriptionId} className="text-[12px] text-muted-foreground" role="status">
            {snapshot.reachable
              ? `${STATE_TEXT[snapshot.state]}. Other apps' connections use every network.`
              : snapshot.helperOutdated
                ? 'Off until the helper is updated.'
                : snapshot.installed
                  ? "Mergelane's helper isn't running."
                  : 'Needs a one-time install of a small helper.'}
          </span>
        </div>
        {snapshot.reachable ? (
          <Switch
            aria-label="System merge"
            aria-describedby={descriptionId}
            checked={on}
            disabled={busy || snapshot.state === 'starting' || snapshot.state === 'stopping'}
            onCheckedChange={(checked) => run(() => window.mergelane.setSystemMerge(checked))}
          />
        ) : (
          !snapshot.installed && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => run(() => window.mergelane.installSystemMerge(), 'install')}
            >
              {pending === 'install' ? 'Installing…' : 'Install'}
            </Button>
          )
        )}
      </div>
      {note &&
        (noteIsNews ? (
          <p className="text-[12px] text-muted-foreground">{note}</p>
        ) : (
          <p role="alert" className="text-[12px] text-[var(--color-danger)]">
            {note}
          </p>
        ))}
      {removal &&
        (removal.outcome === 'failed' ? (
          <p role="alert" className="text-[12px] text-[var(--color-danger)]">
            {removal.message}
          </p>
        ) : (
          <p aria-live="polite" className="text-[12px] text-muted-foreground">
            {removal.message}
          </p>
        ))}
      {snapshot.helperOutdated && (
        <div
          role="group"
          aria-labelledby={updateId}
          className="flex items-center justify-between gap-3"
        >
          <div className="flex min-w-0 flex-col">
            <span id={updateId} className="text-[12.5px] font-medium">
              Mergelane&apos;s helper is out of date
            </span>
            <span className="text-[12px] text-muted-foreground">
              {snapshot.helperVersion && snapshot.helperVersion !== snapshot.appVersion
                ? `The helper is ${snapshot.helperVersion}; this app is ${snapshot.appVersion}.`
                : 'This app needs a newer helper.'}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => run(() => window.mergelane.installSystemMerge(), 'update')}
          >
            {pending === 'update' ? 'Updating…' : 'Update'}
          </Button>
        </div>
      )}
      {snapshot.reachable && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span id={autoResumeId} className="text-[12.5px]">
              Turn back on after a crash
            </span>
            <span id={autoResumeHelpId} className="text-[12px] text-muted-foreground">
              {snapshot.autoResume === undefined
                ? 'Needs the updated helper.'
                : 'After an unexpected stop, merging comes back on by itself if it was on.'}
            </span>
          </div>
          <Switch
            // The shared Switch dims only a native :disabled; this one is a span with
            // data-disabled, so an unavailable setting is dimmed here (not on every busy blink).
            className={
              snapshot.autoResume === undefined ? 'cursor-not-allowed opacity-50' : undefined
            }
            aria-labelledby={autoResumeId}
            aria-describedby={autoResumeHelpId}
            checked={snapshot.autoResume === true}
            disabled={busy || snapshot.autoResume === undefined}
            onCheckedChange={(checked) =>
              run(() => window.mergelane.setSystemMergeAutoResume(checked), 'autoResume')
            }
          />
        </div>
      )}
      {snapshot.reachable && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span id={stickyId} className="text-[12.5px]">
              Keep each site on one network
            </span>
            <span id={stickyHelpId} className="text-[12px] text-muted-foreground">
              {snapshot.stickySites === undefined
                ? 'Needs the updated helper.'
                : 'Sign-ins and calls stay steady. One site then gets one network’s speed; Mergelane’s own downloads still use every network.'}
            </span>
          </div>
          <Switch
            className={
              snapshot.stickySites === undefined ? 'cursor-not-allowed opacity-50' : undefined
            }
            aria-labelledby={stickyId}
            aria-describedby={stickyHelpId}
            checked={snapshot.stickySites === true}
            disabled={busy || snapshot.stickySites === undefined}
            onCheckedChange={(checked) =>
              run(() => window.mergelane.setSystemMergeStickySites(checked), 'stickySites')
            }
          />
        </div>
      )}
      {snapshot.reachable && on && snapshot.links.length > 0 && (
        <ul aria-label="Merged traffic per network" className="flex flex-col gap-1">
          {snapshot.links.map((link) => (
            <li
              key={link.name}
              className="flex items-center justify-between font-mono text-[11.5px] text-muted-foreground"
            >
              <span>
                {link.name}
                {link.state !== 'up' && (
                  <span className="text-[var(--color-danger)]">
                    {link.state === 'down' ? ' · no internet' : ' · checking'}
                  </span>
                )}
              </span>
              <span>
                ↓ {formatSpeed(link.rxBps)} ↑ {formatSpeed(link.txBps)} · {link.activeFlows}
              </span>
            </li>
          ))}
        </ul>
      )}
      {outages.length > 0 && (
        <ul aria-label="Recent network dropouts" className="flex flex-col gap-0.5">
          {outages.map((outage) => (
            <OutageRow key={`${outage.link} ${outage.at}`} outage={outage} now={now} />
          ))}
        </ul>
      )}
      {snapshot.installed && (
        <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-border pt-2">
          <span id={removeHelpId} className="min-w-0 text-[12px] text-muted-foreground">
            Mergelane&apos;s helper runs system merge. Downloads don&apos;t need it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-describedby={removeHelpId}
            disabled={busy}
            onClick={() => setConfirmingRemoval(true)}
          >
            {pending === 'remove' ? 'Removing…' : 'Remove helper…'}
          </Button>
        </div>
      )}
      <AlertDialog open={confirmingRemoval} onOpenChange={setConfirmingRemoval}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Mergelane&apos;s helper?</AlertDialogTitle>
            <AlertDialogDescription>
              System merge turns off, and can&apos;t be used until you install the helper again.{' '}
              {words().adminPrompt} Downloads keep working on every network.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
              onClick={remove}
            >
              Remove helper
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
