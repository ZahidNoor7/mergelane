import { join } from 'node:path'
import { app } from 'electron'
import {
  appendNetworkEvents,
  heldSpeed,
  HELD_SECONDS,
  raiseFastest,
  reconcileAtLaunch,
  sanitizeNetworkActivity,
  type NetworkActivity
} from '../shared/networkActivity'
import type { NetworkInterfaceInfo } from '../shared/types'
import { readJson, updateJson } from './jsonFile'

// The networks that dropped, came back or turned up, and the day's fastest merged speed, kept in
// userData so the Dashboard's "Today" and Networks' dropouts survive a restart (M3.7, ADR-0042).
// Nothing in it leaves the Mac, except in a diagnostics bundle the user saves themselves.

/** A rising speed is saved at most this often; a network change is saved at once. */
const FASTEST_SAVE_MS = 2000

export class NetworkActivityLog {
  private activity: NetworkActivity = { events: [] }
  /** The last network list seen this launch; null until the first. */
  private previous: NetworkInterfaceInfo[] | null = null
  private samples: number[] = []
  private queue: Promise<void>
  private fastestTimer: NodeJS.Timeout | null = null
  /** The saved log is read: until then a speed would be overwritten by it. */
  private ready = false

  constructor(
    private readonly file: string,
    private readonly onChange: (activity: NetworkActivity) => void
  ) {
    this.queue = readJson(file)
      .then((saved) => {
        this.activity = sanitizeNetworkActivity(saved, Date.now())
      })
      .catch((error) => console.error('[mergelane] failed to read network-activity.json', error))
      .finally(() => {
        this.ready = true
      })
  }

  /** What the window shows, once the saved log is read. */
  async snapshot(): Promise<NetworkActivity> {
    await this.queue
    return this.activity
  }

  /** The computer's network list changed (NetworkMonitor). The first list of a launch is what was
   * there all along, measured only against drops the last launch left open. */
  networksChanged(networks: NetworkInterfaceInfo[], at = Date.now()): void {
    this.queue = this.queue.then(() => {
      const events =
        this.previous === null
          ? reconcileAtLaunch(this.activity.events, networks, at)
          : appendNetworkEvents(this.activity.events, this.previous, networks, at)
      this.previous = networks
      if (events === this.activity.events) return
      this.activity = { ...this.activity, events }
      this.onChange(this.activity)
      return this.save()
    })
  }

  /** Once a second: what every running download gets together (DownloadManager.totalSpeed). */
  sample(totalSpeed: number, at = Date.now()): void {
    if (!this.ready) return
    this.samples = [...this.samples, totalSpeed].slice(-HELD_SECONDS)
    const fastest = raiseFastest(this.activity.fastest, heldSpeed(this.samples), at)
    if (fastest === this.activity.fastest) return
    this.activity = { ...this.activity, fastest }
    this.fastestTimer ??= setTimeout(() => {
      this.fastestTimer = null
      this.onChange(this.activity)
      this.queue = this.queue.then(() => this.save())
    }, FASTEST_SAVE_MS)
  }

  private save(): Promise<void> {
    return updateJson(this.file, () => this.activity).catch((error) =>
      console.error('[mergelane] failed to save network-activity.json', error)
    )
  }
}

export function networkActivityPath(): string {
  return join(app.getPath('userData'), 'network-activity.json')
}
