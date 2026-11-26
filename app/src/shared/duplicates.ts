// Warning before a download that's already had (docs/plans/2026-11-new-features-plan.md, feature 4;
// the design's findDuplicate; ADR-0081): the same link as one in History, or (set to "Link or file")
// the same file from another site, told by its name, its size and the SHA-256 that site publishes
// matching the one Mergelane worked out when it finished. Pure, so it is unit-tested on its own.

import { hostOf, plainLink, type HistoryEntry } from './history'

type DownloadKind = HistoryEntry['kind']

export type DuplicateCheck = 'off' | 'link' | 'both'

export const isDuplicateCheck = (value: unknown): value is DuplicateCheck =>
  value === 'off' || value === 'link' || value === 'both'

/** A download a new one could be the same as: one in the list unfinished, or one finished whose
 * file is still where it was saved. */
export interface DuplicateCandidate {
  id: string
  kind: DownloadKind
  name: string
  /** Its link without the query (shared/history.ts plainLink). */
  link: string
  host: string
  size: number
  live: boolean
  /** How far a live one is, 0–100. */
  percent?: number
  completedAt?: number
  /** Where a finished one was saved. */
  path?: string
  sha256?: string
  infoHash?: string
}

/** What is about to be downloaded, as New download has it. */
export interface DuplicateQuery {
  kind: DownloadKind
  url: string
  name: string
  size: number | null
  infoHash?: string
  /** What the site publishes (shared/digests.ts). */
  publishedSha256?: string
}

export interface DuplicateMatch {
  id: string
  how: 'link' | 'file'
  live: boolean
  name: string
  host: string
  size: number
  percent?: number
  completedAt?: number
  path?: string
}

const matchOf = (candidate: DuplicateCandidate, how: DuplicateMatch['how']): DuplicateMatch => ({
  id: candidate.id,
  how,
  live: candidate.live,
  name: candidate.name,
  host: candidate.host,
  size: candidate.size,
  ...(candidate.percent !== undefined && { percent: candidate.percent }),
  ...(candidate.completedAt !== undefined && { completedAt: candidate.completedAt }),
  ...(candidate.path !== undefined && { path: candidate.path })
})

/** The download this one is the same as, or null. `candidates` newest first: the newest wins. */
export function findDuplicate(
  candidates: readonly DuplicateCandidate[],
  query: DuplicateQuery,
  mode: DuplicateCheck
): DuplicateMatch | null {
  if (mode === 'off') return null
  const link = plainLink(query.url)
  const host = hostOf(query.url)
  // The same torrent, whatever link it came by: its info hash is the torrent (plan D8).
  if (query.kind === 'torrent' && query.infoHash) {
    const same = candidates.find(
      (candidate) => candidate.kind === 'torrent' && candidate.infoHash === query.infoHash
    )
    if (same) return matchOf(same, 'link')
  }
  const byLink = candidates.find(
    (candidate) =>
      candidate.link === link ||
      (host !== '' && candidate.host === host && candidate.name === query.name)
  )
  if (byLink) return matchOf(byLink, 'link')
  // Another site's copy: same name and size, and its published SHA-256 is the one worked out here.
  // Without a published one, name and size alone would warn about files that only look alike.
  if (mode !== 'both' || query.kind !== 'http' || !query.publishedSha256 || !query.size) return null
  const byFile = candidates.find(
    (candidate) =>
      candidate.kind === 'http' &&
      candidate.name === query.name &&
      candidate.size === query.size &&
      candidate.host !== host &&
      candidate.sha256 === query.publishedSha256
  )
  return byFile ? matchOf(byFile, 'file') : null
}

/** Whether a `.sha256` file beside the link is worth asking for: only when a finished file of the
 * same name and size came from another site, so a match would mean something. */
export function worthAskingForDigest(
  candidates: readonly DuplicateCandidate[],
  query: DuplicateQuery,
  mode: DuplicateCheck
): boolean {
  if (mode !== 'both' || query.kind !== 'http' || query.publishedSha256 || !query.size) return false
  const host = hostOf(query.url)
  return candidates.some(
    (candidate) =>
      !candidate.live &&
      candidate.sha256 !== undefined &&
      candidate.name === query.name &&
      candidate.size === query.size &&
      candidate.host !== host
  )
}
