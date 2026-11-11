import { useState } from 'react'
import {
  headerActions,
  isFinished,
  manageActions,
  type ActionId,
  type DownloadItem
} from '../../utils/downloadActions'
import { useDownloadActions, useDownloadActionsState } from '../downloadActionsContext'
import { ACTION_META } from '../downloadActionMeta'
import { Button } from '../ui/button'

// The details pane's small parts, from the final design (prototype.html, SectionTitle and Stat), and
// its buttons, which were the download screen's header (DetailHeader).

export function SectionTitle({
  children,
  aside
}: {
  children: React.ReactNode
  aside?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
      <h3 className="text-[13px] font-[650] tracking-[-0.005em] text-foreground">{children}</h3>
      {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
    </div>
  )
}

export function Stat({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="figures truncate text-[17px] leading-tight font-[640]">{children}</dd>
    </div>
  )
}

/** What can be done to the download, from the same list as its row and its menu: what it can do
 * next (the last one the main one, unless it's Pause, which is the way to stop), and the ways out
 * (Cancel while it's unfinished; Remove, and Move to Trash, after). */
export function InspectorActions({ download }: { download: DownloadItem }): React.JSX.Element {
  const { perform } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const manage = manageActions(download)
  const next = headerActions(download)

  // Resuming round-trips through the main process to re-verify the download before its status
  // flips (an ETag re-check over the network for a real download). With no feedback in between,
  // a slow check reads as the button not having registered the click: it says so until the
  // download's state moves on.
  const state = isFinished(download) ? 'finished' : `${download.status}|${download.error ?? ''}`
  const [working, setWorking] = useState<{ id: ActionId; state: string } | null>(null)

  const run = (id: ActionId): void => {
    if (id === 'pause' || id === 'resume' || id === 'retry') setWorking({ id, state })
    void perform(id, [download]).then((done) => done || setWorking(null))
  }

  const button = (
    id: ActionId,
    variant: 'default' | 'secondary' | 'destructive' | 'ghost'
  ): React.JSX.Element => {
    const meta = ACTION_META[id]
    const isWorking = working?.id === id && working.state === state
    return (
      <Button
        key={id}
        type="button"
        size="sm"
        variant={variant}
        disabled={isWorking || (busy && manage.includes(id))}
        onClick={() => run(id)}
      >
        <meta.icon aria-hidden />
        {isWorking && meta.working ? meta.working : meta.label}
      </Button>
    )
  }

  return (
    <div role="group" aria-label="Actions" className="flex flex-wrap items-center gap-2">
      {next.map((id, index) =>
        button(id, index === next.length - 1 && id !== 'pause' ? 'default' : 'secondary')
      )}
      {manage.map((id) => button(id, ACTION_META[id].destructive ? 'destructive' : 'ghost'))}
    </div>
  )
}
