// The popup's "Block ads on this site" (ADR-0063). uBO Lite, merged into this extension, does the
// blocking; this asks it, through the messages its own popup sends, which filtering mode a site
// has, and changes it. Its modes: 0 none, 1 basic (requests only), 2 optimal (requests, and hiding
// what's left of the ads, which needs access to the site), 3 complete.

export const MODE_NONE = 0
export const MODE_OPTIMAL = 2

/** Sends one message to the background (uBO Lite answers these) and resolves with its answer. */
export type Send = (message: Record<string, unknown>) => Promise<unknown>

export interface SiteBlocking {
  /** The site's mode now. */
  level: number
  /** The mode sites get unless one was chosen for them (the ad-blocking settings' default). */
  defaultLevel: number
  /** Whether uBO Lite reloads the tab after a change (on unless turned off in its settings). */
  autoReload: boolean
}

const levelOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null

/** The mode a site gets when its switch is turned on or off: on is the default mode, or optimal
 * when blocking is off everywhere by default; off is none. */
export function levelFor(on: boolean, defaultLevel: number): number {
  if (!on) return MODE_NONE
  return defaultLevel > MODE_NONE ? defaultLevel : MODE_OPTIMAL
}

/** The words under the switch. */
export function blockingHint({ level, defaultLevel }: SiteBlocking): string {
  if (level > MODE_NONE) return 'Ads and trackers are blocked here.'
  return defaultLevel > MODE_NONE
    ? 'Ads load as usual on this site.'
    : 'Ad blocking is off for every site. Turn it on here, or in Options.'
}

/** What uBO Lite says about a site, or null when it doesn't answer (still starting, or failed). */
export async function siteBlocking(send: Send, url: URL): Promise<SiteBlocking | null> {
  const [panel, fallback] = await Promise.all([
    send({ what: 'popupPanelData', origin: url.origin, hostname: url.hostname }).catch(() => null),
    send({ what: 'getDefaultFilteringMode' }).catch(() => null)
  ])
  const { level, autoReload } = (panel ?? {}) as { level?: unknown; autoReload?: unknown }
  const current = levelOf(level)
  const defaultLevel = levelOf(fallback)
  if (current === null || defaultLevel === null) return null
  return { level: current, defaultLevel, autoReload: autoReload !== false }
}

/** Turns blocking on or off for one site; resolves with the mode uBO Lite actually set, which can
 * be lower than asked (no access to the site), or null when it didn't answer. */
export async function setSiteBlocking(
  send: Send,
  hostname: string,
  on: boolean,
  defaultLevel: number
): Promise<number | null> {
  const answer = await send({
    what: 'setFilteringMode',
    hostname,
    level: levelFor(on, defaultLevel)
  }).catch(() => null)
  return levelOf(answer)
}
