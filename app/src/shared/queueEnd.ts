// The end of the queue (docs/plans/2026-11-new-features-plan.md, feature 7; ADR-0079). With
// Settings › General › "When the queue finishes" set to Sleep or Shut down, the computer does so a
// minute after the last download in the queue ends, unless the user cancels. The main process keeps
// the countdown (main/download/downloadManager.ts) and acts (main/power.ts); the rules are here.

import type { DownloadStatus } from './types'

export type AfterQueue = 'nothing' | 'sleep' | 'shutdown'

export const AFTER_QUEUE: readonly AfterQueue[] = ['nothing', 'sleep', 'shutdown']

export const isAfterQueue = (value: unknown): value is AfterQueue =>
  AFTER_QUEUE.includes(value as AfterQueue)

/** How long the computer waits, with the notice up, before it sleeps or shuts down. */
export const QUEUE_END_COUNTDOWN_MS = 60_000

/** What of a download the queue's end depends on. */
export interface QueueItem {
  status: DownloadStatus
  /** Waiting for a time it was added for (ADR-0044). */
  startAt?: number
  /** Waiting for the download schedule's hours. */
  scheduled?: boolean
}

/** The countdown under way, as the window shows it. */
export interface QueueEnd {
  action: Exclude<AfterQueue, 'nothing'>
  /** When the computer sleeps or shuts down, in ms since the epoch. */
  endsAt: number
  /** A download that waits for a time starts then, after the computer has slept or shut down. */
  nextStartAt?: number
}

/**
 * Whether the queue still has work that comes on its own: a download running, or one waiting for a
 * turn (a turn comes as soon as a run ends, for one added to the queue too). One waiting for a time
 * or for the schedule's hours comes later, and one paused or failed only when the user says.
 */
export function queueBusy(items: readonly QueueItem[]): boolean {
  return items.some(
    (item) =>
      item.status === 'downloading' ||
      (item.status === 'queued' && item.startAt === undefined && item.scheduled !== true)
  )
}

/** The first time a download waits for, if any: the notice says it will start late. */
export function nextStartAt(items: readonly QueueItem[]): number | undefined {
  const times = items
    .filter((item) => item.status === 'queued' && item.startAt !== undefined)
    .map((item) => item.startAt as number)
  return times.length > 0 ? Math.min(...times) : undefined
}

/**
 * The countdown a download's end starts: when it was the last of the queue, and the setting asks
 * for one. Only a run that ended by itself (finished, or failed) ends the queue; a pause or a cancel
 * is the user's, who is there.
 */
export function queueEndAfter(
  setting: AfterQueue,
  items: readonly QueueItem[],
  now: number
): QueueEnd | null {
  if (setting === 'nothing' || queueBusy(items)) return null
  const next = nextStartAt(items)
  return {
    action: setting,
    endsAt: now + QUEUE_END_COUNTDOWN_MS,
    ...(next !== undefined && { nextStartAt: next })
  }
}
