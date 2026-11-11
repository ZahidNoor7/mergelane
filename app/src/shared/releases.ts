// Mergelane's own releases on GitHub, as the update check reads them (docs/DECISIONS.md ADR-0036).
// Pure, so it is tested on its own; main/updater.ts asks GitHub and keeps the state.
//
// GitHub's "List releases" (docs.github.com, REST API endpoints for releases, read 2026-11-11) lists
// published releases to anyone and drafts only to people with push access. Its fields used here:
// tag_name, draft, prerelease, published_at, html_url, body, and each asset's name, size and
// browser_download_url.

export type UpdateChannel = 'stable' | 'beta'

/** The repository's releases, newest first enough: the check reads one page and picks by version. */
export const RELEASES_URL = 'https://api.github.com/repos/ZahidNoor7/mergelane/releases?per_page=30'
/** Pinned, so a change on GitHub's side can't change what the check reads (docs: API versions). */
export const GITHUB_API_VERSION = '2026-03-10'

export interface ReleaseNotes {
  /** The section's opening paragraph, if it has one. */
  summary: string | null
  /** Its top-level points, one line each (a point's own sub-points are left to the full notes). */
  items: string[]
}

export interface Release {
  version: string
  prerelease: boolean
  /** Milliseconds since the epoch; null if GitHub gives none. */
  publishedAt: number | null
  /** The release's page on GitHub. */
  pageUrl: string
  notes: ReleaseNotes
  /** The Apple silicon disk image, which the update downloads; null when the release has none. */
  dmg: { name: string; size: number; url: string } | null
  /** The release's SHA256SUMS, which the download is checked against; null when it has none. */
  checksumsUrl: string | null
}

interface Version {
  core: [number, number, number]
  pre: Array<string | number>
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** A semantic version ("1.2.3", "v1.2.3-beta.1"), or null when the text isn't one. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : []
  }
}

/** Semantic-versioning precedence (semver.org §11): negative when a comes first, 0 when equal. A
 * text that isn't a version comes before every version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  // A prerelease comes before its release.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (typeof p === 'number' && typeof q === 'number') return p - q
    if (typeof p === 'number') return -1
    if (typeof q === 'number') return 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * "What's new" from a release's notes (scripts/release/notes.mjs writes it first, from the
 * CHANGELOG): the section under "## What's new", or the text before the first "## " heading when
 * there is no such section. Markdown emphasis and links are reduced to their text.
 */
export function releaseNotes(body: string | null | undefined): ReleaseNotes {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+What['’]s new\s*$/i.test(line))
  const from = start === -1 ? 0 : start + 1
  const end = lines.findIndex((line, index) => index >= from && /^##\s/.test(line))
  const section = lines.slice(from, end === -1 ? undefined : end)

  let summary: string | null = null
  const items: string[] = []
  let paragraph: string[] = []
  let item: string[] | null = null
  // Inside a point's sub-point, whose lines (and their continuations) the parent stands for.
  let inSub = false
  const flush = (): void => {
    if (item) items.push(plain(item.join(' ')))
    item = null
    inSub = false
    if (paragraph.length > 0 && summary === null && items.length === 0) {
      summary = plain(paragraph.join(' '))
    }
    paragraph = []
  }
  for (const line of section) {
    if (/^- /.test(line)) {
      flush()
      item = [line.slice(2)]
    } else if (/^\s*$/.test(line) || /^#/.test(line)) {
      flush()
    } else if (/^\s+- /.test(line)) {
      inSub = true
    } else if (inSub) {
      continue
    } else if (item) {
      item.push(line.trim())
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return { summary, items }
}

function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const httpsUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value)

/** A file Mergelane may download: https anywhere, plain http only from this Mac (loopback), which
 * only the tests serve (scripts/media-tools/fetch.mjs has the same rule). */
export function downloadableUrl(value: unknown): value is string {
  if (httpsUrl(value)) return true
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/** SHA256SUMS as `shasum -a 256` writes it ("<hash>  <name>", or "<hash> *<name>" for binary
 * mode): each file's hash by name, in lowercase. Lines that aren't one are skipped. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (match) sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}

/** One release from GitHub's answer, or null when it is a draft or isn't a usable release. */
export function releaseFromGitHub(raw: unknown): Release | null {
  if (!isRecord(raw) || raw.draft !== false || typeof raw.tag_name !== 'string') return null
  const parsed = parseVersion(raw.tag_name)
  if (!parsed || !httpsUrl(raw.html_url)) return null
  const version = raw.tag_name.trim().replace(/^v/, '')
  const assets = Array.isArray(raw.assets) ? raw.assets.filter(isRecord) : []
  const asset = (name: string): Record<string, unknown> | undefined =>
    assets.find((each) => each.name === name && downloadableUrl(each.browser_download_url))
  const dmg = asset(`Mergelane-${version}-arm64.dmg`)
  const sums = asset('SHA256SUMS')
  const published = typeof raw.published_at === 'string' ? Date.parse(raw.published_at) : NaN
  return {
    version,
    prerelease: raw.prerelease === true,
    publishedAt: Number.isNaN(published) ? null : published,
    pageUrl: raw.html_url,
    notes: releaseNotes(typeof raw.body === 'string' ? raw.body : null),
    dmg:
      dmg && typeof dmg.size === 'number'
        ? { name: dmg.name as string, size: dmg.size, url: dmg.browser_download_url as string }
        : null,
    checksumsUrl: sums ? (sums.browser_download_url as string) : null
  }
}

/**
 * The release to offer, from GitHub's list: the newest on the channel (Stable leaves prereleases
 * out), if it is newer than the running version and isn't the one the user skipped. Throws when
 * the answer isn't a list of releases.
 */
export function newestUpdate(
  answer: unknown,
  { current, channel, skipped }: { current: string; channel: UpdateChannel; skipped: string | null }
): Release | null {
  if (!Array.isArray(answer)) throw new Error('GitHub’s answer isn’t a list of releases')
  let newest: Release | null = null
  for (const raw of answer) {
    const release = releaseFromGitHub(raw)
    if (!release || (channel === 'stable' && release.prerelease)) continue
    if (!newest || compareVersions(release.version, newest.version) > 0) newest = release
  }
  if (!newest || compareVersions(newest.version, current) <= 0) return null
  return newest.version === skipped ? null : newest
}
