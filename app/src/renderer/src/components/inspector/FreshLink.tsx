import { isWebLink, signedLink } from '@shared/linkExpiry'
import type { DownloadState } from '@shared/types'
import { ExternalLink, Link, Link2, TriangleAlert } from 'lucide-react'
import { cn } from 'cn'
import { useEffect, useId, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import {
  describeError,
  formatBytes,
  formatPercent,
  sourceOf,
  wantedBytes
} from '../../utils/format'
import { Button } from '../ui/button'

// A download whose link stopped working (docs/plans/2026-11-new-features-plan.md, feature 6; the
// design's FreshLinkPanel), and the word that it carried on from a fresh one. The main process
// checks the fresh link (DownloadManager.relink): same size, and the bytes already downloaded
// sampled again, before anything from it is written.

/** How long "Same file…" stays after a fresh link took over. */
export const RELINKED_NOTE_MS = 10_000

/** Keyed by the download where it's used, so another download starts with an empty field. */
export function FreshLinkPanel({ download }: { download: DownloadState }): React.JSX.Element {
  const catchFreshLinks = useAppStore((store) => store.catchFreshLinks)
  const [url, setUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const helpId = useId()
  const wanted = wantedBytes(download)
  const percent = formatPercent(download.bytesDownloaded, wanted)
  const host = sourceOf(download.url)
  const pageUrl = download.kind === 'http' ? download.pageUrl : undefined
  const browser = download.kind === 'http' ? download.fromBrowser : undefined

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const link = url.trim()
    if (!isWebLink(link)) {
      setError('That isn’t a link. Paste an address that starts with https://')
      return
    }
    setError(null)
    setChecking(true)
    try {
      await window.mergelane.relinkDownload(download.id, link)
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setChecking(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-labelledby={`${helpId}-title`}
      className="flex flex-col gap-3 rounded-[12px] bg-caution-soft p-3.5 shadow-[inset_0_0_0_1px_var(--color-warning-border)]"
    >
      <div className="flex items-start gap-2.5">
        <Link2 aria-hidden className="mt-0.5 size-4 shrink-0 text-caution" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${helpId}-title`} className="text-[13.5px] font-[640]">
            The link expired at {percent}%
          </h3>
          <p className="text-[12.5px] leading-[1.5] text-ink-2">
            {signedLink(download.url)
              ? `Links from ${host} are signed and stop working after a while.`
              : `The link from ${host} stopped working.`}{' '}
            Get a fresh one and Mergelane carries on from {formatBytes(download.bytesDownloaded)}.
            It checks the size and the file itself first, so nothing is fetched twice.
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={cn(
            'flex h-8 min-w-0 flex-1 basis-56 items-center gap-2 rounded-full bg-[var(--input-bg)] px-3 shadow-[inset_0_0_0_1px_var(--control)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
            error && 'shadow-[inset_0_0_0_1.5px_var(--color-danger)]'
          )}
        >
          <Link aria-hidden className="size-3.5 shrink-0 text-ink-3" />
          <input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setError(null)
            }}
            placeholder="Paste the fresh link"
            aria-label="Fresh link"
            aria-describedby={`${helpId}-help`}
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-[12.5px] placeholder:text-ink-3"
          />
        </span>
        <Button type="submit" size="sm" disabled={!url.trim() || checking}>
          {checking ? 'Checking…' : 'Continue'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
      <p
        id={`${helpId}-help`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-2"
      >
        {pageUrl && (
          <a
            href={pageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-[600] text-[var(--color-accent-ink)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ExternalLink aria-hidden className="size-3.5" />
            Open the download page
          </a>
        )}
        {browser && catchFreshLinks && (
          <span>
            {pageUrl ? 'Click the download again there' : `Click the download again in ${browser}`}:
            Mergelane picks the fresh link up.
          </span>
        )}
      </p>
    </form>
  )
}

/** For a while after a fresh link took over: that it was the same file, and where it carried on. */
export function RelinkedNote({ download }: { download: DownloadState }): React.JSX.Element | null {
  const relinked = download.kind === 'http' ? download.relinked : undefined
  const [now, setNow] = useState(() => Date.now())
  const shown = relinked !== undefined && now - relinked.at < RELINKED_NOTE_MS
  useEffect(() => {
    if (!relinked) return
    const left = relinked.at + RELINKED_NOTE_MS - Date.now()
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [relinked])
  if (!relinked || !shown) return null
  const percent = formatPercent(relinked.fromBytes, wantedBytes(download))
  return (
    <p
      role="status"
      className="rounded-[12px] bg-[var(--color-accent-soft)] px-3 py-2.5 text-[12.5px] leading-snug text-foreground"
    >
      Same file: the size and the bytes already downloaded match. Continuing from {percent}%.
    </p>
  )
}
