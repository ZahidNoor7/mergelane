import type { DownloadState, FinishedDownload, NzbFileState } from '@shared/types'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from 'cn'
import { useFormatSpeed } from '../../hooks/useFormatSpeed'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import { describeFileCount, formatBytes, formatDuration, wantedBytes } from '../../utils/format'
import { FinishedNetworks } from '../DownloadNetworks'
import { ThroughputChart } from '../ThroughputChart'
import { SectionTitle, Stat } from './parts'

/** What's left to do with an NZB download, which Mergelane leaves to the user's tools: a repair
 * where articles were missing, unpacking where it's an archive. Null when it's ready as it is. */
function usenetNote(files: NzbFileState[]): { warning: boolean; text: string } | null {
  const missing = files.reduce((sum, file) => sum + file.missing, 0)
  const par2 = files.some((file) => /\.par2$/i.test(file.name))
  const archive = files.some((file) => /\.(rar|r\d{2,3}|7z|zip|\d{3})$/i.test(file.name))
  const articles = missing === 1 ? 'article wasn’t' : 'articles weren’t'
  if (missing > 0) {
    return {
      warning: true,
      text: par2
        ? `${missing} ${articles} on the news server, so some files have gaps. Repair them with the download’s .par2 files${archive ? ' before unpacking' : ''}.`
        : `${missing} ${articles} on the news server, so some files have gaps, and this download has no .par2 files to repair them with.`
    }
  }
  if (archive) {
    return {
      warning: false,
      text: 'The files are as posted: unpack the archive to get at what’s inside.'
    }
  }
  return null
}

/** A finished download's details: how it went, the speed over the whole download, and what each
 * network brought. */
export function InspectorFinished({
  download
}: {
  /** Just finished, or as history keeps it. */
  download: DownloadState | FinishedDownload
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const networkVisual = useNetworkVisuals()
  const finalSize = wantedBytes(download) || download.bytesDownloaded
  // completedAt is always set by the time a download reaches 'completed'; the fallback keeps this
  // pure (no Date.now() during render).
  const elapsedSeconds = Math.max(
    0,
    ((download.completedAt ?? download.startedAt) -
      download.startedAt -
      (download.totalPausedMs ?? 0)) /
      1000
  )
  const average = elapsedSeconds > 0 ? finalSize / elapsedSeconds : 0
  const carried = download.networks.filter((network) => network.bytesDownloaded > 0)
  const totalRetries = download.networks.reduce((sum, network) => sum + network.retries, 0)
  const isTorrent = download.kind === 'torrent'
  // A torrent's units are its pieces (those its chosen files needed); "chunks" are byte ranges.
  const units =
    'unitsWritten' in download
      ? download.unitsWritten
      : download.kind === 'torrent'
        ? download.pieces.filter((piece) => piece.status !== 'skipped').length
        : download.kind === 'nzb'
          ? download.blocks.filter((block) => block.status === 'completed').length
          : download.totalBlocks
  const files =
    isTorrent && download.files.total > 1
      ? download.files
      : download.kind === 'nzb'
        ? { chosen: download.nzbFiles.length, total: download.nzbFiles.length }
        : null
  const note = download.kind === 'nzb' ? usenetNote(download.nzbFiles) : null

  return (
    <>
      <p role="status" className="sr-only">
        Download complete: {download.fileName}
      </p>
      {note && (
        <p
          role={note.warning ? 'alert' : undefined}
          className={cn(
            'flex items-start gap-2 rounded-[12px] bg-sunken px-3 py-2.5 text-[12.5px] leading-snug',
            note.warning ? 'text-destructive' : 'text-ink-2'
          )}
        >
          {note.warning ? (
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          )}
          {note.text}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[384px]:grid-cols-3">
        <Stat label="Size">{formatBytes(finalSize)}</Stat>
        <Stat label="Time">{formatDuration(elapsedSeconds)}</Stat>
        <Stat label="Average">{formatSpeed(average)}</Stat>
        <Stat label="Peak">
          {download.peakSpeedBytesPerSec === undefined
            ? '—'
            : formatSpeed(download.peakSpeedBytesPerSec)}
        </Stat>
        <Stat label="Networks">{carried.length}</Stat>
        {/* The most it ran at once: streams that didn't make it faster were closed along the way. */}
        <Stat label={isTorrent ? 'Peers' : download.kind === 'nzb' ? 'Connections' : 'Streams'}>
          {isTorrent ? download.peakPeers : download.peakStreams}
        </Stat>
      </dl>

      <section aria-label="Speed over the download" className="flex flex-col gap-2">
        <SectionTitle>Speed over the download</SectionTitle>
        <ThroughputChart
          order={carried.map((network) => {
            const visual = networkVisual(network.id, network.kind, network.label)
            return { interfaceId: network.id, solid: visual.solid, name: visual.name }
          })}
          historyByInterface={download.speedHistory ?? {}}
          endsAt="end"
        />
      </section>

      <section aria-label="By network" className="flex flex-col gap-1">
        <SectionTitle>By network</SectionTitle>
        <FinishedNetworks networks={download.networks} />
      </section>

      <p className="text-[12px] leading-snug text-ink-3 first-letter:uppercase">
        {[
          files && describeFileCount(files.chosen, files.total),
          `written in ${units} ${isTorrent ? 'pieces' : download.kind === 'nzb' ? 'articles' : download.kind === 'stream' ? 'segments' : 'chunks'}`,
          // What its peers got from it while it downloaded.
          isTorrent && `uploaded ${formatBytes(download.bytesUploaded ?? 0)}`,
          `${totalRetries} ${totalRetries === 1 ? 'retry' : 'retries'}`
        ]
          .filter(Boolean)
          .join(', ')}
      </p>
    </>
  )
}
