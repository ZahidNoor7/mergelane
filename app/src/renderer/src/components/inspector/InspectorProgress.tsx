import type { DownloadState } from '@shared/types'
import { describeStartAt, HELD_NOTE, missedStartNote } from '@shared/startAt'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { cn } from 'cn'
import { useEffect, useState } from 'react'
import { useDownloadSchedule } from '../../hooks/useDownloadSchedule'
import { useFormatSpeed, useFormatSpeedLimit } from '../../hooks/useFormatSpeed'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import { useAppStore } from '../../store/useAppStore'
import {
  describeError,
  describeFileCount,
  describeSegments,
  formatBytes,
  formatEta,
  formatPercent,
  groupByNetwork,
  networkActive,
  networksInPlay,
  wantedBytes
} from '../../utils/format'
import { BlockGrid } from '../BlockGrid'
import { Confluence } from '../Confluence'
import { CyclableChip } from '../CyclableChip'
import { LiveNetworks } from '../DownloadNetworks'
import { useDownloadActions } from '../downloadActionsContext'
import { networkStatusText } from '../networkStatus'
import { SplitBar } from '../SplitBar'
import { ThroughputChart } from '../ThroughputChart'
import { TorrentFiles } from '../TorrentFiles'
import { UsenetServerButton } from '../UsenetServerDialog'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SectionTitle, Stat } from './parts'

/** What the download is waiting on, when no network is carrying it. */
function waitingFor(download: DownloadState): string | null {
  if (download.status !== 'downloading') return null
  const enabled = download.networks.filter((network) => network.enabled)
  if (enabled.some((network) => network.status === 'on')) return null
  if (enabled.some((network) => network.status === 'unreachable')) {
    return download.kind === 'torrent'
      ? 'Can’t reach peers. Retrying…'
      : download.kind === 'nzb'
        ? 'Can’t reach the news server. Retrying…'
        : 'Can’t reach the server. Retrying…'
  }
  return enabled.length > 0 && enabled.every((network) => network.status === 'limit')
    ? 'Every network in use has reached its data limit. Raise one in Speed & data limits.'
    : 'Waiting for a network. Reconnect one or switch one on.'
}

/** A running, waiting or paused download's details: its speed on every network, its numbers, the
 * last minute, each network, and its chunk map. */
export function InspectorProgress({ download }: { download: DownloadState }): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const formatSpeedLimit = useFormatSpeedLimit()
  const speedLimit = useAppStore((store) => store.speedLimit)
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const networkVisual = useNetworkVisuals()
  const { window: scheduleWindow, message: scheduleMessage } = useDownloadSchedule()
  const { perform } = useDownloadActions()
  const isQueued = download.status === 'queued'
  // Waiting in the queue looks like a pause: nothing moves.
  const isPaused = download.status === 'paused' || isQueued
  const running = download.status === 'downloading'
  const isTorrent = download.kind === 'torrent'
  const wanted = wantedBytes(download)
  const knownSize = download.totalBytes > 0
  const percent = formatPercent(download.bytesDownloaded, wanted)
  const missingArticles =
    download.kind === 'nzb' ? download.nzbFiles.reduce((sum, file) => sum + file.missing, 0) : 0
  const [now, setNow] = useState(() => Date.now())
  const [filesOpen, setFilesOpen] = useState(false)
  const [chipModeIndex, setChipModeIndex] = useState(0)

  useEffect(() => {
    if (isPaused) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isPaused])

  // The window's title follows the download shown.
  useEffect(() => {
    const label = isQueued ? 'Queued' : 'Paused'
    document.title = isPaused
      ? knownSize
        ? `Mergelane — ${label} (${percent}%)`
        : `Mergelane — ${label}`
      : knownSize
        ? `Mergelane — ${percent}%`
        : 'Mergelane — downloading'
    return () => {
      document.title = 'Mergelane'
    }
  }, [percent, knownSize, isPaused, isQueued])

  const totalPausedMs =
    (download.totalPausedMs || 0) +
    (isPaused && download.pausedAt ? Math.max(0, now - download.pausedAt) : 0)
  const elapsedSeconds = Math.max(0, (now - download.startedAt - totalPausedMs) / 1000)
  const averageSpeed = elapsedSeconds > 0 ? download.bytesDownloaded / elapsedSeconds : 0
  // The cap over every download, slow mode named, so a low number explains itself.
  const speedCap = slowMode
    ? `Slow mode: ${formatSpeedLimit(slowModeSpeed)}`
    : speedLimit !== undefined
      ? `Limited to ${formatSpeedLimit(speedLimit)}`
      : ''
  // Every network is a row, for switching it on or off; the charts draw only those in play.
  const rows = groupByNetwork(download)
  const groups = networksInPlay(rows)
  const visuals = groups.map((group) => networkVisual(group.id, group.kind, group.label))
  const waiting = waitingFor(download)
  const totalRetries = rows.reduce((sum, row) => sum + row.retries, 0)
  const remainingBytes = knownSize ? Math.max(0, wanted - download.bytesDownloaded) : 0

  // "2.0× faster than Wi-Fi alone": the download against one network on its own, by its current
  // speed while bytes move, or by what each brought otherwise. Under 1.05× makes no point.
  const bySpeed = download.speedBytesPerSec > 0
  const totalMetric = bySpeed ? download.speedBytesPerSec : download.bytesDownloaded
  const chipOptions =
    groups.length > 1 && !isPaused && totalMetric > 0
      ? groups
          .map((group, index) => ({
            ratio: totalMetric / (bySpeed ? group.speedBytesPerSec : group.bytesDownloaded),
            visual: visuals[index]
          }))
          .filter(({ ratio }) => Number.isFinite(ratio) && ratio >= 1.05)
          .sort((a, b) => a.ratio - b.ratio)
          .map(({ ratio, visual }) => ({
            visual,
            label: `${ratio.toFixed(1)}× faster than ${visual.name} alone`,
            tooltip: bySpeed
              ? `Total speed is ${ratio.toFixed(1)}× faster than ${visual.name} alone`
              : `Total downloaded is ${ratio.toFixed(1)}× compared to ${visual.name} alone`
          }))
      : []
  const chip = chipOptions.length > 0 ? chipOptions[chipModeIndex % chipOptions.length] : null

  // What the Confluence says it is: its speed, or why it isn't moving.
  const statusWord = running
    ? 'Speed'
    : isQueued
      ? download.startAt !== undefined
        ? describeStartAt(download.startAt, now)
        : scheduleWindow.allowed
          ? 'Waiting for a turn'
          : 'Waiting for the schedule'
      : 'Paused'
  const third = isTorrent
    ? { label: 'Peers', value: String(download.peers.length) }
    : download.kind === 'stream'
      ? { label: 'Quality', value: download.quality ?? '—' }
      : download.kind === 'nzb'
        ? { label: 'Files', value: String(download.nzbFiles.length) }
        : { label: 'Size', value: knownSize ? formatBytes(wanted) : '—' }

  return (
    <>
      {isQueued && !scheduleWindow.allowed && scheduleMessage && (
        <p className="rounded-[12px] bg-sunken px-3 py-2.5 text-[12.5px] leading-snug text-ink-2">
          {scheduleMessage}
        </p>
      )}
      {/* Added to the queue, or started late (ADR-0044): when its turn comes, or why it's late. */}
      {(isQueued && download.held) || download.missedStartAt !== undefined ? (
        <p className="rounded-[12px] bg-sunken px-3 py-2.5 text-[12.5px] leading-snug text-ink-2">
          {isQueued && download.held ? HELD_NOTE : missedStartNote(download.missedStartAt!, now)}
        </p>
      ) : null}

      <Confluence
        compact
        idle={isPaused}
        label={statusWord}
        lanes={groups.map((group, index) => ({
          id: group.id,
          interfaceName: group.id,
          name: visuals[index].name,
          color: visuals[index].solid,
          speed: isPaused ? 0 : group.speedBytesPerSec,
          on: !isPaused && networkActive(group),
          down: group.status === 'offline',
          note:
            group.status !== 'on'
              ? networkStatusText(group.status, group.transfer)
              : isPaused
                ? 'Paused'
                : 'Idle'
        }))}
        total={isPaused ? 0 : download.speedBytesPerSec}
        labelNote={
          running &&
          download.kind === 'http' &&
          download.diskLimited && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Slow drive"
                    className="inline-flex text-[var(--color-warning)]"
                  >
                    <AlertTriangle aria-hidden className="size-3" />
                  </span>
                }
              />
              <TooltipContent>
                Your drive can’t save any faster, so this download is going slower.
              </TooltipContent>
            </Tooltip>
          )
        }
        caption={
          <span className="flex flex-col items-start gap-1.5">
            {running && download.timeLeftSeconds !== undefined && (
              <span>{formatEta(download.timeLeftSeconds)} left</span>
            )}
            <span>
              Average{' '}
              <span className="figures font-[600] text-foreground">
                {formatSpeed(averageSpeed)}
              </span>
              , peak {/* A dash until a speed has been held long enough to call it the peak. */}
              <span className="figures font-[600] text-foreground">
                {download.peakSpeedBytesPerSec === undefined
                  ? '—'
                  : formatSpeed(download.peakSpeedBytesPerSec)}
              </span>
            </span>
            {speedCap && <span>{speedCap}</span>}
            {isPaused || waiting
              ? (download.error || waiting) && (
                  <span role="alert" className="font-[580] text-destructive">
                    {download.error ? describeError(download.error) : waiting}
                  </span>
                )
              : chip && (
                  <CyclableChip
                    label={chip.label}
                    tooltip={`${chip.tooltip}${chipOptions.length > 1 ? ' (click to toggle)' : ''}`}
                    bg={chip.visual.bg}
                    border={chip.visual.border}
                    color={chip.visual.text}
                    cyclable={chipOptions.length > 1}
                    onClick={() => setChipModeIndex((index) => (index + 1) % chipOptions.length)}
                  />
                )}
          </span>
        }
      />

      <SplitBar
        label={`${download.fileName} progress`}
        percent={knownSize ? percent : undefined}
        valueText={knownSize ? `${percent}%` : `${formatBytes(download.bytesDownloaded)} received`}
        dim={isPaused}
        segments={rows
          .filter((row) => row.bytesDownloaded > 0)
          .map((row) => ({
            id: row.id,
            share: row.bytesDownloaded / (wanted || 1),
            color: networkVisual(row.id, row.kind, row.label).solid
          }))}
      />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[384px]:grid-cols-4">
        <Stat label="Done">{knownSize ? `${percent}%` : '—'}</Stat>
        <Stat label="Received">{formatBytes(download.bytesDownloaded)}</Stat>
        <Stat label={third.label}>{third.value}</Stat>
        {isTorrent && running ? (
          <Stat label="Uploading">{formatSpeed(download.uploadSpeedBytesPerSec)}</Stat>
        ) : (
          <Stat label="Peak">
            {download.peakSpeedBytesPerSec === undefined
              ? '—'
              : formatSpeed(download.peakSpeedBytesPerSec)}
          </Stat>
        )}
      </dl>

      {/* What only some downloads have: their files, trackers, server, segments and retries. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-2 empty:hidden">
        {download.kind === 'stream' && (
          // Once every segment is in, FFmpeg joins the tracks: worth saying, as nothing moves.
          <span role="status">
            {download.muxing ? 'Joining video and audio…' : describeSegments(download.blocks)}
          </span>
        )}
        {download.kind === 'nzb' && (
          <span className="inline-flex items-center gap-1.5">
            Usenet server
            <UsenetServerButton host={download.server} />
          </span>
        )}
        {missingArticles > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span tabIndex={0} className="text-destructive outline-none">
                  {missingArticles} missing
                </span>
              }
            />
            <TooltipContent>
              The news server doesn’t have{' '}
              {missingArticles === 1 ? 'this article' : 'these articles'}. Once the download is
              done, repair its files with their .par2 files.
            </TooltipContent>
          </Tooltip>
        )}
        {totalRetries > 0 && (
          <span className="text-[var(--color-warning)]">
            {totalRetries} {totalRetries === 1 ? 'retry' : 'retries'}
          </span>
        )}
        {/* Several files: they open below. One is the name above. */}
        {download.kind === 'torrent' && download.files.total > 1 && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => setFilesOpen((open) => !open)}
            aria-expanded={filesOpen}
          >
            {describeFileCount(download.files.chosen, download.files.total)}
            <ChevronDown
              aria-hidden
              className={cn('transition-transform duration-150', filesOpen && 'rotate-180')}
            />
          </Button>
        )}
        {download.kind === 'torrent' && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => void perform('trackers', [download])}
          >
            Trackers
          </Button>
        )}
      </div>
      {download.kind === 'torrent' && filesOpen && (
        <TorrentFiles
          downloadId={download.id}
          pieces={download.pieces}
          selected={download.files.selected}
        />
      )}

      <section aria-label="Last minute" className="flex flex-col gap-2">
        <SectionTitle>Last minute</SectionTitle>
        <div className={cn('transition-opacity duration-200', isPaused && 'opacity-45')}>
          <ThroughputChart
            order={groups.map((group, index) => ({
              interfaceId: group.id,
              solid: visuals[index].solid,
              name: visuals[index].name
            }))}
            historyByInterface={download.speedHistory ?? {}}
            endsAt={isPaused ? 'pause' : 'now'}
          />
        </div>
      </section>

      <section aria-label="By network" className="flex flex-col gap-1">
        <SectionTitle>By network</SectionTitle>
        <LiveNetworks download={download} />
      </section>

      <BlockGrid
        blocks={download.kind === 'torrent' ? download.pieces : download.blocks}
        groups={groups}
        visuals={visuals}
        knownSize={knownSize}
        remainingBytes={remainingBytes}
        isPaused={isPaused}
        pieces={isTorrent}
        articles={download.kind === 'nzb'}
      />
    </>
  )
}
