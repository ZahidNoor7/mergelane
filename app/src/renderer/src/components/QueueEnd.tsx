import type { AfterQueue, QueueEnd } from '@shared/queueEnd'
import { Coffee, Moon, Power } from 'lucide-react'
import { cn } from 'cn'
import { useEffect, useId, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { words } from '../platformWords'
import { SettingRow } from './settingsParts'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

// Keeping the computer awake, and what it does when the queue finishes (docs/plans/
// 2026-11-new-features-plan.md, feature 7; ADR-0079): the design's AwakeSettings, AwakeLine and
// QueueDoneNotice. The main process keeps the countdown and acts (main/power.ts).

const CHOICES: { value: AfterQueue; label: string; icon?: React.ReactNode }[] = [
  { value: 'nothing', label: 'Do nothing' },
  { value: 'sleep', label: 'Sleep', icon: <Moon aria-hidden data-icon="inline-start" /> },
  { value: 'shutdown', label: 'Shut down', icon: <Power aria-hidden data-icon="inline-start" /> }
]

/** Settings › General's two rows. */
export function AwakeSettings(): React.JSX.Element {
  const keepAwake = useAppStore((store) => store.keepAwake)
  const setKeepAwake = useAppStore((store) => store.setKeepAwake)
  const afterQueue = useAppStore((store) => store.afterQueue)
  const setAfterQueue = useAppStore((store) => store.setAfterQueue)
  const awakeId = useId()
  const device = words().computer
  return (
    <>
      <SettingRow
        label={`Keep the ${device} awake while downloading`}
        hint={`Only while something is downloading. The display can still sleep, and the ${device} sleeps as usual when the queue is empty.`}
        htmlFor={awakeId}
      >
        <Switch id={awakeId} checked={keepAwake} onCheckedChange={setKeepAwake} />
      </SettingRow>
      <SettingRow
        label="When the queue finishes"
        hint={
          afterQueue === 'nothing'
            ? `The ${device} goes back to its usual sleep schedule.`
            : `A 60-second countdown comes first, so you can cancel.${afterQueue === 'shutdown' ? ' Apps with unsaved work can stop the shutdown.' : ''}`
        }
      >
        <ToggleGroup
          aria-label="When the queue finishes"
          value={[afterQueue]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setAfterQueue(values[0] as AfterQueue)
          }}
        >
          {CHOICES.map((choice) => (
            <ToggleGroupItem key={choice.value} value={choice.value}>
              {choice.icon}
              {choice.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </>
  )
}

/** The sidebar's word, while it keeps the computer awake. */
export function AwakeLine({ className }: { className?: string }): React.JSX.Element | null {
  const keepAwake = useAppStore((store) => store.keepAwake)
  const afterQueue = useAppStore((store) => store.afterQueue)
  const busy = useAppStore((store) =>
    Object.values(store.downloads).some((download) => download.status === 'downloading')
  )
  if (!keepAwake || !busy) return null
  return (
    <p
      className={cn('flex items-center gap-1.5 text-[12px] text-ink-3', className)}
      title="Until the queue finishes. The display can still sleep."
    >
      <Coffee aria-hidden className="size-3.5 shrink-0" />
      Keeping {words().thisComputer} awake
      {afterQueue === 'sleep'
        ? ', then sleep'
        : afterQueue === 'shutdown'
          ? ', then shut down'
          : ''}
    </p>
  )
}

/** The notice while the countdown runs: Cancel, or now. */
export function QueueDoneNotice(): React.JSX.Element | null {
  const [end, setEnd] = useState<QueueEnd | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const titleId = useId()

  useEffect(() => {
    let current = true
    const unsubscribe = window.mergelane.onQueueEndChanged((next) => setEnd(next))
    window.mergelane.queueEnd().then(
      (found) => current && setEnd(found),
      () => {}
    )
    return () => {
      current = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!end) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [end])

  if (!end) return null
  const device = words().computer
  const left = Math.max(0, Math.ceil((end.endsAt - now) / 1000))
  const verb = end.action === 'sleep' ? 'sleep' : 'shut down'
  const later =
    end.nextStartAt !== undefined
      ? ` A scheduled download starts at ${new Date(end.nextStartAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
      : ''

  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      className="ml-notice absolute bottom-4 left-1/2 z-[45] flex w-[min(420px,calc(100%-32px))] -translate-x-1/2 flex-col gap-2.5 rounded-[14px] bg-popover p-3.5 shadow-[var(--shadow-sheet)]"
    >
      <div className="flex items-start gap-2.5">
        {end.action === 'sleep' ? (
          <Moon aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--color-accent-ink)]" />
        ) : (
          <Power aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--color-accent-ink)]" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p id={titleId} className="text-[13.5px] font-[640]">
            The queue is done
          </p>
          <p className="text-[12.5px] leading-[1.5] text-ink-2">
            Your {device} will {verb} in{' '}
            <span className="figures font-[640] text-foreground">{left}</span> s, as set in Settings
            › General.
            {end.action === 'shutdown' ? ' Apps with unsaved work can stop the shutdown.' : ''}
            {later}
          </p>
        </div>
      </div>
      <span aria-hidden className="h-1 overflow-hidden rounded-full bg-track">
        <span
          className="block h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
          style={{ width: `${(left / 60) * 100}%` }}
        />
      </span>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setEnd(null)
            void window.mergelane.cancelQueueEnd().catch(() => {})
          }}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          autoFocus
          onClick={() => {
            setEnd(null)
            void window.mergelane.endQueueNow().catch(() => {})
          }}
        >
          {end.action === 'sleep' ? 'Sleep now' : 'Shut down now'}
        </Button>
      </div>
    </div>
  )
}
