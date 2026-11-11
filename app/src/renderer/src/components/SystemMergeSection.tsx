import { useId } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useSystemMerge } from '../hooks/useSystemMerge'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

const STATE_TEXT = {
  on: 'On',
  off: 'Off',
  starting: 'Turning on…',
  stopping: 'Turning off…'
} as const

/** System-wide merging (mergelane-daemon) at the foot of the networks menu: a switch, why it is
 * off when nobody turned it off, and each link's merged traffic while it's on. Phase 1 keeps it
 * minimal; it lives here because it is about the same networks. */
export function SystemMergeSection({ open }: { open: boolean }): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const { snapshot, busy, run } = useSystemMerge(open)
  const descriptionId = useId()

  if (!snapshot) {
    return (
      <div className="border-t-[0.5px] border-border px-4 py-3 text-[12px] text-muted-foreground">
        Checking system merge…
      </div>
    )
  }

  const on = snapshot.state === 'on' || snapshot.state === 'starting'
  const note = snapshot.error ?? snapshot.reason
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
              onClick={() => run(() => window.mergelane.installSystemMerge())}
            >
              {busy ? 'Installing…' : 'Install'}
            </Button>
          )
        )}
      </div>
      {note && (
        <p role="alert" className="text-[12px] text-[var(--color-danger)]">
          {note}
        </p>
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
    </section>
  )
}
