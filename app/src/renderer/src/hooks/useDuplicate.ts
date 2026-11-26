import type { DuplicateMatch } from '@shared/duplicates'
import type { ProbeResult } from '@shared/types'
import { useEffect, useState } from 'react'

/** For New download: a download already had that this link is the same as (ADR-0081), as Settings
 * › Downloads asks; the main process decides (shared/duplicates.ts). Null while it's asked, or
 * when there is none. */
export function useDuplicate(probe: ProbeResult | null, name: string): DuplicateMatch | null {
  const [answer, setAnswer] = useState<{ key: string; match: DuplicateMatch | null } | null>(null)
  const key = probe ? `${probe.finalUrl}\n${name}` : ''
  useEffect(() => {
    if (!probe) return
    let current = true
    window.mergelane
      .findDuplicate({
        kind: probe.kind,
        url: probe.finalUrl,
        name,
        size: probe.totalBytes,
        ...(probe.kind === 'torrent' && { infoHash: probe.torrent.infoHash }),
        ...(probe.kind === 'http' &&
          probe.publishedSha256 && { publishedSha256: probe.publishedSha256 })
      })
      .then(
        (match) => current && setAnswer({ key: `${probe.finalUrl}\n${name}`, match }),
        () => {}
      )
    return () => {
      current = false
    }
  }, [probe, name])
  return answer?.key === key ? answer.match : null
}
