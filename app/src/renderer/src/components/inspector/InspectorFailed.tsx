import type { DownloadState } from '@shared/types'
import { CircleAlert, CircleMinus } from 'lucide-react'
import { cn } from 'cn'
import { useEffect, useState } from 'react'
import { describeError, formatBytes, formatPercent, wantedBytes } from '../../utils/format'
import { UsenetServerButton } from '../UsenetServerDialog'
import { Button } from '../ui/button'

/** A download that failed or was cancelled: what happened, how far it got, and its link. */
export function InspectorFailed({ download }: { download: DownloadState }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const cancelled = download.status === 'cancelled'
  const knownSize = download.totalBytes > 0
  const wanted = wantedBytes(download)
  const Icon = cancelled ? CircleMinus : CircleAlert

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(download.url)
      setCopied(true)
    } catch {
      // Nothing to say: the link is on screen to copy by hand.
    }
  }

  return (
    <>
      <div
        role="alert"
        className={cn(
          'flex items-start gap-2.5 rounded-[12px] px-3 py-3',
          cancelled ? 'bg-sunken' : 'bg-destructive-soft'
        )}
      >
        <Icon
          aria-hidden
          className={cn('mt-px size-4 shrink-0', cancelled ? 'text-ink-2' : 'text-destructive')}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[14px] leading-tight font-[650]">
            {cancelled ? 'Download cancelled' : 'Download failed'}
          </h3>
          <p className="text-[12.5px] leading-snug text-ink-2">
            {cancelled
              ? 'The download was stopped before finishing.'
              : download.error
                ? describeError(download.error)
                : 'The download stopped unexpectedly. Try again.'}
          </p>
        </div>
      </div>

      {/* What an NZB download most often fails on is the server's settings: they open here. */}
      {download.kind === 'nzb' && !cancelled && (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
          Usenet server
          <UsenetServerButton host={download.server} />
        </p>
      )}

      <p className="figures text-[13px] text-ink-2">
        {download.bytesDownloaded > 0
          ? knownSize
            ? `${formatBytes(download.bytesDownloaded)} of ${formatBytes(wanted)} (${formatPercent(download.bytesDownloaded, wanted)}%)`
            : `${formatBytes(download.bytesDownloaded)} downloaded`
          : 'No data downloaded'}
      </p>

      <div className="flex min-w-0 items-center gap-2 border-t border-rule pt-3">
        <p
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3"
          title={download.url}
        >
          {download.url}
        </p>
        <Button type="button" variant="ghost" size="xs" onClick={() => void copyLink()}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </>
  )
}
