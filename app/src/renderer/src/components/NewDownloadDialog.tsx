import type { ProbeResult, UsenetServer } from '@shared/types'
import { youtubeLink } from '@shared/youtube'
import { cn } from 'cn'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  Folder,
  FolderOpen,
  Globe,
  HardDrive,
  Link as LinkIcon,
  Lock,
  Magnet,
  Newspaper,
  Pencil,
  X
} from 'lucide-react'
import { fileTypeOf } from '@shared/downloadFilters'
import { FILE_TYPE_ICON } from './fileTypeIcons'
import { NetworkTile } from './NetworkTile'
import { useEffect, useRef, useState } from 'react'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useFreeSpace } from '../hooks/useFreeSpace'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { useAppStore } from '../store/useAppStore'
import {
  acceptedLink,
  describeError,
  describeFileCount,
  formatBytes,
  formatDuration,
  streamQualityOptions,
  toDisplayPath
} from '../utils/format'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { TorrentFileList } from './TorrentFiles'
import { UsenetServerDialog } from './UsenetServerDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { NetworkEditPopover } from './NetworkEditPopover'

type ProbeState =
  | { status: 'idle' }
  /** `noPeersYet`: a magnet link whose first search found no one, still being looked for. */
  | { status: 'probing'; noPeersYet?: boolean }
  | { status: 'ready'; result: ProbeResult }
  | { status: 'error'; message: string }

const PROBE_DEBOUNCE_MS = 600

type StreamsChoice = 'auto' | number
/** Streams per network the user can pick instead of Auto. */
const STREAMS_CHOICES: StreamsChoice[] = ['auto', 4, 8, 16, 32]

// The design's field rows: a label column beside the field once the sheet is wide enough.
const ROW = 'grid gap-x-4 gap-y-2 @min-[512px]:grid-cols-[6.5rem_minmax(0,1fr)]'
const FIELD_LABEL = 'pt-2 text-[12.5px] font-[600] text-ink-2'

function NetworkListNotice({
  status,
  error,
  onScan
}: {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  onScan: () => void
}): React.JSX.Element {
  if (status === 'idle' || status === 'loading') {
    return <span className="text-[12px] text-ink-3">Looking for networks…</span>
  }
  const detail = error ? describeError(error) : ''
  return (
    <span className="flex flex-wrap items-center gap-2 text-[12.5px] leading-snug text-ink-2">
      {status === 'error'
        ? `Mergelane couldn’t list this computer’s networks.${detail ? ` ${detail}` : ''}`
        : 'No networks connected. Join a Wi-Fi network, plug in Ethernet, or connect your phone using USB tethering.'}
      <Button type="button" variant="secondary" size="xs" onClick={onScan}>
        Scan again
      </Button>
    </span>
  )
}

/** New download: a link, then only what differs from one download to the next — its name (or a
 * torrent's files), where it goes, over which networks, and how many streams each runs. Everything set once for every
 * download lives in Speed & data limits and the networks menu. */
export function NewDownloadDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.newDownloadOpen)
  const close = useAppStore((store) => store.closeNewDownload)
  const formKey = useAppStore((store) => store.formKey)

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={(next) => !next && close()}>
      <DialogContent
        sheet
        showCloseButton={false}
        className="flex flex-col gap-0 overflow-hidden p-0"
      >
        {/* Mounted only while open, and keyed by what it shows, so each opening and each
            download stacked in it starts fresh. */}
        {open && <NewDownloadForm key={formKey} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function NewDownloadForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { schedule, window: scheduleWindow } = useDownloadSchedule()
  const scheduledWait = schedule?.enabled && !scheduleWindow.allowed
  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const interfacesError = useAppStore((store) => store.interfacesError)
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const homeDir = useAppStore((store) => store.homeDir)
  const url = useAppStore((store) => store.draftUrl)
  const setUrl = useAppStore((store) => store.setDraftUrl)
  const links = useAppStore((store) => store.links)
  const shownId = useAppStore((store) => store.shownId)
  const showLink = useAppStore((store) => store.showLink)
  const finishLink = useAppStore((store) => store.finishLink)
  const dropLink = useAppStore((store) => store.dropLink)
  const shownLink = links.find((link) => link.id === shownId)
  const position = shownLink ? links.indexOf(shownLink) : -1
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const full = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading')
        .length >= store.downloadsAtOnce
  )
  const networkVisual = useNetworkVisuals()
  const networkPreferences = useAppStore((store) => store.networkPreferences)
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const usage = useNetworkUsage(true)
  const formatSpeedLimit = useFormatSpeedLimit()
  const linkInput = useRef<HTMLInputElement>(null)

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  // Tracks deselections rather than selections, so a newly-detected interface starts selected.
  // Starts from the last download's pick: the networks it left out are saved as `off`.
  const [deselectedInterfaceIds, setDeselectedInterfaceIds] = useState<string[]>(() =>
    Object.entries(useAppStore.getState().networkPreferences)
      .filter(([, preference]) => preference.off)
      .map(([id]) => id)
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null)
  // A torrent's files left out, by index: every file is downloaded unless unticked.
  const [skippedFiles, setSkippedFiles] = useState<number[]>([])
  // For this download only: the next one starts on Auto again.
  const [streamsChoice, setStreamsChoice] = useState<StreamsChoice>('auto')
  // An HLS or DASH video's quality, by variant id; null: the best, which its list starts with.
  const [qualityChoice, setQualityChoice] = useState<string | null>(null)
  // The news server, for an NZB: undefined until it has been asked for, null when there's none.
  const [server, setServer] = useState<UsenetServer | null | undefined>(undefined)
  const [serverOpen, setServerOpen] = useState(false)
  const freeSpace = useFreeSpace(destinationDir)

  // Opened with nothing in it: a link on the clipboard is most likely what it's for, as download
  // managers have long assumed. Anything else on the clipboard is left alone.
  useEffect(() => {
    if (useAppStore.getState().draftUrl) return
    void window.mergelane
      .readClipboardText()
      .then((text) => {
        const link = acceptedLink(text)
        const { draftUrl, startedUrl } = useAppStore.getState()
        if (link && link !== startedUrl && !draftUrl) setUrl(link)
      })
      .catch(() => {})
  }, [setUrl])

  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      // Resetting derived probe state when its trigger (the URL) is cleared.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProbe({ status: 'idle' })
      setFileNameOverride(null)
      setSkippedFiles([])
      setQualityChoice(null)
      return
    }

    // Checking here would go without the browser's sign-in, and could spend a single-use link.
    const { links: stacked, shownId: shown } = useAppStore.getState()
    const given = stacked.find((link) => link.id === shown)
    if (given && given.url !== trimmed) dropLink(given.id, false)
    setFileNameOverride(null)
    setSkippedFiles([])
    setQualityChoice(null)
    if (given?.url === trimmed && given.probe) {
      setProbe({ status: 'ready', result: given.probe })
      return
    }

    // Set once the link changes, cleared included: a magnet can take a while to answer, and its
    // answer is no longer wanted then.
    let stale = false
    setProbe({ status: 'probing' })
    const stopListening = window.mergelane.onMagnetCheckStatus((status) => {
      if (stale || status.link !== trimmed) return
      setProbe((now) =>
        now.status === 'probing' ? { status: 'probing', noPeersYet: status.noPeersYet } : now
      )
    })
    const timer = setTimeout(async () => {
      try {
        const result = await window.mergelane.probeUrl(trimmed)
        if (stale) return
        setProbe({ status: 'ready', result })
      } catch (error) {
        if (stale) return
        setProbe({ status: 'error', message: describeError(error) })
      }
    }, PROBE_DEBOUNCE_MS)

    return () => {
      stale = true
      clearTimeout(timer)
      stopListening()
    }
  }, [url, dropLink])

  const ready = probe.status === 'ready' ? probe.result : null
  const torrent = ready?.kind === 'torrent' ? ready.torrent : null
  const nzb = ready?.kind === 'nzb' ? ready.nzb : null
  const stream = ready?.kind === 'stream' ? ready.stream : null
  const qualities = stream ? streamQualityOptions(stream.variants) : []
  const quality = qualityChoice ?? qualities[0]?.id
  const youtube = stream?.protocol === 'youtube'
  // yt-dlp takes a while to answer for a YouTube video: said so, so the wait isn't a mystery.
  const askingYoutube = probe.status === 'probing' && youtubeLink(url)?.kind === 'video'

  // Asked for once an NZB turns up: no other download needs it.
  const wantsServer = nzb !== null && server === undefined
  useEffect(() => {
    if (!wantsServer) return
    void window.mergelane
      .usenetServer()
      .then(setServer)
      .catch(() => setServer(null))
  }, [wantsServer])
  const chosenFiles = torrent
    ? torrent.files.flatMap((_, index) => (skippedFiles.includes(index) ? [] : [index]))
    : []
  // What will be downloaded: a torrent's chosen files, the quality picked when its size is known
  // (a YouTube video's), or the whole file.
  const sizeToFetch = torrent
    ? chosenFiles.reduce((sum, index) => sum + torrent.files[index].length, 0)
    : (stream?.variants.find((variant) => variant.id === quality)?.bytes ??
      ready?.totalBytes ??
      null)
  const availableFreeSpace = destinationDir ? freeSpace : null
  const hasInsufficientSpace =
    availableFreeSpace !== null &&
    sizeToFetch !== null &&
    sizeToFetch > 0 &&
    sizeToFetch > availableFreeSpace
  // A stream's segments go over every network whatever its size: it is only known as they come.
  const multiChunkAllowed =
    ready !== null && (stream !== null || (ready.supportsRanges && ready.totalBytes !== null))
  const isSingleStreamOnly = ready !== null && !multiChunkAllowed

  const detectedIds = interfaces.map((iface) => iface.id)
  // A network that has used up its data limit can't carry anything, so it can't be picked.
  const isReached = (id: string): boolean => {
    const dataLimit = networkPreferences[id]?.dataLimit
    return dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit
  }
  const availableIds = detectedIds.filter((id) => !isReached(id))
  const pickedIds = availableIds.filter((id) => !deselectedInterfaceIds.includes(id))
  // The last pick may be all used up. Then nothing is picked, rather than what was left out: a
  // network left out is often left out on purpose (a phone's metered data), so it's chosen here
  // by hand, never stood in for the one that ran out.
  const selectedInterfaceIds = isSingleStreamOnly ? pickedIds.slice(0, 1) : pickedIds
  // The networks of the last pick that have used up their data, to say why nothing is picked.
  const usedUpPick =
    pickedIds.length === 0 && availableIds.length > 0
      ? interfaces.filter(
          (iface) => isReached(iface.id) && !deselectedInterfaceIds.includes(iface.id)
        )
      : []

  const canStart =
    probe.status === 'ready' &&
    (!torrent || chosenFiles.length > 0) &&
    (!nzb || !!server) &&
    selectedInterfaceIds.length > 0 &&
    Boolean(destinationDir) &&
    !hasInsufficientSpace &&
    !starting
  const startLabel = starting
    ? 'Starting'
    : probe.status === 'probing'
      ? 'Checking'
      : scheduledWait
        ? 'Add to scheduled queue'
        : full
          ? 'Add to queue'
          : 'Download'

  // Two networks on one subnet: the OS sends both down one route, so there's nothing to combine.
  let subnetConflict: { subnet: string; names: string[] } | null = null
  if (selectedInterfaceIds.length > 1) {
    const subnets = new Map<string, string[]>()
    for (const id of selectedInterfaceIds) {
      const iface = interfaces.find((i) => i.id === id)
      const subnet = iface?.addresses.find((address) => address.family === 4)?.subnet
      if (subnet && iface) {
        const names = subnets.get(subnet) ?? []
        names.push(networkVisual(iface.id, iface.kind, iface.displayName).name)
        subnets.set(subnet, names)
      }
    }
    for (const [subnet, names] of subnets.entries()) {
      if (names.length > 1) {
        subnetConflict = { subnet, names }
        break
      }
    }
  }

  const handleToggleInterface = (id: string): void => {
    if (isReached(id)) return
    if (isSingleStreamOnly) {
      // Single-stream mode can only download through 1 interface at a time
      setDeselectedInterfaceIds(detectedIds.filter((otherId) => otherId !== id))
      return
    }
    setDeselectedInterfaceIds((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id)
      // Keep at least 1 interface selected
      const remaining = availableIds.filter((other) => !prev.includes(other) && other !== id)
      return remaining.length === 0 ? prev : [...prev, id]
    })
  }

  const handleBrowse = async (): Promise<void> => {
    const chosen = await window.mergelane.chooseDestinationFolder(destinationDir)
    if (chosen) setDestinationDir(chosen)
  }

  // A .torrent or .nzb file goes in the link field as its path; the probe reads it from there.
  const handleOpenFile = async (): Promise<void> => {
    const path = await window.mergelane.chooseDownloadFile()
    if (path) setUrl(path)
  }

  const handleResume = async (): Promise<void> => {
    const link = shownLink
    const resumes = link?.resumes
    if (!link || !resumes) return
    setStarting(true)
    setStartError(null)
    try {
      await window.mergelane.resumeFromLink(link.id, resumes.id)
      useAppStore.getState().openDownload(resumes.id)
      finishLink(link.id, true)
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const handleStart = async (): Promise<void> => {
    if (probe.status !== 'ready' || !canStart) return
    // Captured now: links can arrive and change what's shown while this starts.
    const linkId = shownLink?.id
    const form = useAppStore.getState().formKey
    setStarting(true)
    setStartError(null)
    try {
      const common = {
        url: probe.result.finalUrl,
        destinationDir,
        suggestedFileName: fileNameOverride?.trim() || probe.result.suggestedFileName,
        totalBytes: probe.result.totalBytes ?? 0,
        supportsRanges: multiChunkAllowed,
        interfaceIds: selectedInterfaceIds,
        etag: probe.result.etag,
        lastModified: probe.result.lastModified
      }
      const id = await window.mergelane.startDownload(
        probe.result.kind === 'torrent'
          ? {
              ...common,
              kind: 'torrent',
              infoHash: probe.result.torrent.infoHash,
              selectedFiles: skippedFiles.length > 0 ? chosenFiles : undefined
            }
          : probe.result.kind === 'nzb'
            ? { ...common, kind: 'nzb', nzbHash: probe.result.nzb.hash }
            : probe.result.kind === 'stream'
              ? {
                  ...common,
                  kind: 'stream',
                  protocol: probe.result.stream.protocol,
                  variantId: quality
                }
              : {
                  ...common,
                  kind: 'http',
                  streamsPerNetwork: streamsChoice === 'auto' ? undefined : streamsChoice
                },
        linkId
      )
      // Remembered for the next download, like the folder. Not a single-stream pick: that's one
      // network because the file allows no more, not because the others were unwanted.
      if (!isSingleStreamOnly) {
        for (const id of availableIds) {
          const off = !selectedInterfaceIds.includes(id)
          if (off !== Boolean(networkPreferences[id]?.off)) {
            setNetworkPreference(id, { off: off || undefined })
          }
        }
      }
      // Started: the link is spent, so the next download starts from an empty one. Its own
      // screen opens, unless it was only added to the queue.
      useAppStore.setState({ startedUrl: url.trim() })
      if (!full && !scheduledWait) useAppStore.getState().openDownload(id)
      if (linkId) {
        finishLink(linkId, true)
      } else if (useAppStore.getState().formKey === form) {
        // Only while this form is still the one shown: closing would dismiss a link that arrived.
        useAppStore.setState({ draftUrl: '' })
        onDone()
      }
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const fileName = ready ? (fileNameOverride ?? ready.suggestedFileName) : ''
  const PreviewIcon =
    (torrent && torrent.files.length > 1) || nzb
      ? Folder
      : stream
        ? Film
        : FILE_TYPE_ICON[fileTypeOf({ kind: 'http', fileName })]

  return (
    <form
      className="flex min-h-0 flex-col @container"
      onSubmit={(event) => {
        event.preventDefault()
        void handleStart()
      }}
    >
      <div className="flex items-center gap-2 border-b border-rule py-3 pr-3 pl-5">
        <DialogTitle className="flex-1 text-[16px] font-[680] tracking-[-0.01em]">
          New download
        </DialogTitle>
        {shownLink && links.length > 1 && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous download"
              disabled={position === 0}
              onClick={() => showLink(links[position - 1].id)}
            >
              <ChevronLeft />
            </Button>
            <span className="figures min-w-12 text-center text-[12px] text-ink-2">
              {position + 1} of {links.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next download"
              disabled={position === links.length - 1}
              onClick={() => showLink(links[position + 1].id)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onDone}>
          <X />
        </Button>
      </div>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
        <div className={ROW}>
          <label htmlFor="new-download-link" className={FIELD_LABEL}>
            Link
          </label>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--input-bg)] px-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                  probe.status === 'error'
                    ? 'shadow-[inset_0_0_0_1px_var(--color-danger)]'
                    : 'shadow-[inset_0_0_0_1px_var(--control)]'
                )}
              >
                <LinkIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                <input
                  ref={linkInput}
                  id="new-download-link"
                  autoFocus
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="Paste a web address or a magnet link"
                  spellCheck={false}
                  aria-invalid={probe.status === 'error' || undefined}
                  className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-3"
                />
                {url && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => {
                            setUrl('')
                            linkInput.current?.focus()
                          }}
                          aria-label="Clear link"
                          className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <X aria-hidden className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipContent>Clear link</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button type="button" variant="secondary" onClick={handleOpenFile}>
                      <FolderOpen data-icon="inline-start" />
                      Open file
                    </Button>
                  }
                />
                <TooltipContent>Open a .torrent or .nzb file</TooltipContent>
              </Tooltip>
            </div>
            {probe.status === 'probing' && (
              <p className="text-[12px] text-ink-3">
                {probe.noPeersYet
                  ? 'No peers found yet, still looking…'
                  : askingYoutube
                    ? 'Asking YouTube about this video… it can take a minute.'
                    : 'Checking the link…'}
              </p>
            )}
            {probe.status === 'error' && (
              <p className="flex items-start gap-1.5 text-[12px] leading-snug text-destructive">
                <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
                {probe.message}
              </p>
            )}
          </div>
        </div>

        {shownLink?.from && (
          <p className="flex items-center gap-1.5 self-start rounded-full bg-sunken px-2.5 py-1 text-[12px] font-[560] text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]">
            {shownLink.signedInTo ? (
              <Lock aria-hidden className="size-3" />
            ) : (
              <Globe aria-hidden className="size-3" />
            )}
            {[
              `From ${shownLink.from}`,
              shownLink.signedInTo && `with your ${shownLink.signedInTo} sign-in`
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        )}

        {shownLink?.resumes && (
          <div className="flex items-center gap-3 rounded-[12px] bg-sunken px-3 py-2.5 text-[12.5px] shadow-[inset_0_0_0_1px_var(--border-subtle)]">
            <span className="min-w-0 flex-1">
              Same file as <span className="font-[600]">{shownLink.resumes.fileName}</span>, which
              failed. Resume that instead?
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={starting}
              onClick={() => void handleResume()}
            >
              Resume it
            </Button>
          </div>
        )}

        {ready && (
          <div className="flex items-center gap-3 rounded-[12px] bg-sunken p-3 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
            <span
              aria-hidden
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-card text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]"
            >
              <PreviewIcon className="size-[48%]" strokeWidth={1.75} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Where it comes from, when its name doesn't say, as the list's rows tag it. */}
              {(torrent || nzb || stream) && (
                <span className="flex flex-wrap gap-1.5">
                  <Badge>
                    {torrent ? (
                      <Magnet aria-hidden />
                    ) : nzb ? (
                      <Newspaper aria-hidden />
                    ) : (
                      <Film aria-hidden />
                    )}
                    {torrent
                      ? 'Torrent'
                      : nzb
                        ? 'Usenet'
                        : stream!.protocol === 'youtube'
                          ? 'YouTube'
                          : stream!.protocol.toUpperCase()}
                  </Badge>
                </span>
              )}
              {torrent ? (
                <p className="truncate text-[13.5px] font-[600]">{ready.suggestedFileName}</p>
              ) : (
                <input
                  type="text"
                  value={fileName}
                  onChange={(event) => setFileNameOverride(event.target.value)}
                  aria-label="File name"
                  spellCheck={false}
                  className="-ml-1 min-w-0 rounded-[6px] bg-transparent px-1 text-[13.5px] font-[600] outline-none hover:shadow-[inset_0_0_0_1px_var(--control)] focus-visible:shadow-[inset_0_0_0_1px_var(--control)]"
                />
              )}
              <p className="text-[12px] text-ink-2">
                {[
                  torrent && describeFileCount(chosenFiles.length, torrent.files.length),
                  nzb && describeFileCount(nzb.files.length, nzb.files.length),
                  stream?.durationSeconds !== undefined && formatDuration(stream.durationSeconds),
                  sizeToFetch !== null ? formatBytes(sizeToFetch) : 'size unknown',
                  nzb && 'from Usenet',
                  youtube && 'from YouTube',
                  stream && 'saved as MP4 or MKV',
                  !torrent &&
                    !nzb &&
                    !stream &&
                    (isSingleStreamOnly
                      ? ready.supportsRanges
                        ? 'Uses one connection. The file size is unknown.'
                        : 'Uses one connection. This server doesn’t support parallel downloads.'
                      : 'resumable')
                ]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            </div>
          </div>
        )}

        {torrent && (
          <TorrentFileList
            files={torrent.files}
            skipped={skippedFiles}
            onChange={setSkippedFiles}
          />
        )}

        {qualities.length > 1 && (
          <div className={ROW}>
            <span className={FIELD_LABEL} id="new-download-quality">
              Quality
            </span>
            <ToggleGroup
              value={quality === undefined ? [] : [quality]}
              onValueChange={(values) => {
                if (values.length > 0) setQualityChoice(values[0])
              }}
              aria-labelledby="new-download-quality"
              variant="outline"
              orientation="vertical"
              spacing={0}
              className="w-full gap-0.5 rounded-[12px]"
            >
              {qualities.map((option) => {
                const bytes = stream?.variants.find((variant) => variant.id === option.id)?.bytes
                return (
                  <ToggleGroupItem
                    key={option.id}
                    value={option.id}
                    className="group/quality h-8 w-full justify-start gap-3 rounded-[10px] px-2.5 text-[13px] shadow-none hover:bg-hover aria-pressed:bg-selected aria-pressed:shadow-none data-pressed:bg-selected data-pressed:shadow-none"
                  >
                    <span
                      aria-hidden
                      className="grid size-4 place-items-center rounded-full shadow-[inset_0_0_0_1.5px_var(--control)] group-aria-pressed/quality:bg-primary group-aria-pressed/quality:shadow-none"
                    >
                      <span className="hidden size-1.5 rounded-full bg-[var(--color-accent-onsolid)] group-aria-pressed/quality:block" />
                    </span>
                    <span className="flex-1 text-left font-[580]">{option.label}</span>
                    {bytes !== undefined && (
                      <span className="figures text-ink-2">{formatBytes(bytes)}</span>
                    )}
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
          </div>
        )}

        {nzb && server !== undefined && (
          <div className={ROW}>
            <span className={FIELD_LABEL}>Server</span>
            <div className="flex min-w-0 items-center gap-2">
              {server ? (
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {server.host}
                  <span className="text-ink-3">
                    , {server.connections} {server.connections === 1 ? 'connection' : 'connections'}
                  </span>
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-[var(--color-warning)]">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  Set up your news server to download this NZB.
                </span>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setServerOpen(true)}
              >
                {server ? 'Change' : 'Set up'}
              </Button>
            </div>
          </div>
        )}

        <div className={ROW}>
          <span className={FIELD_LABEL} id="new-download-networks">
            Networks
          </span>
          <div className="flex min-w-0 flex-col gap-2">
            <div
              role="group"
              aria-labelledby="new-download-networks"
              className="flex flex-wrap gap-2"
            >
              {interfaces.length === 0 && (
                <NetworkListNotice
                  status={interfacesStatus}
                  error={interfacesError}
                  onScan={() => void loadInterfaces()}
                />
              )}
              {interfaces.map((iface) => {
                const visual = networkVisual(iface.id, iface.kind, iface.displayName)
                const selected = selectedInterfaceIds.includes(iface.id)
                const reached = isReached(iface.id)
                const preference = networkPreferences[iface.id]
                const speedLimit = preference?.speedLimit
                const proxy = preference?.proxy
                const isProxyActive = Boolean(proxy?.enabled && proxy.host)
                // What's worth knowing before it's picked: it can't be, or it's capped.
                const note = reached
                  ? 'Data limit reached'
                  : speedLimit !== undefined
                    ? `Limited to ${formatSpeedLimit(speedLimit)}`
                    : null

                const toggleButton = (
                  <button
                    type="button"
                    aria-pressed={selected}
                    // Not `disabled`: a disabled button never gets the hover that says why.
                    aria-disabled={reached || undefined}
                    onClick={() => handleToggleInterface(iface.id)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-full py-1 pr-1 pl-1 outline-none',
                      reached && 'cursor-not-allowed line-through'
                    )}
                  >
                    <NetworkTile
                      kind={iface.kind}
                      color={visual.solid}
                      onColor={visual.onSolid}
                      size={26}
                      dim={!selected}
                    />
                    <span className="truncate font-[580]">{visual.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">{iface.id}</span>
                    <span
                      aria-hidden
                      className={cn(
                        'grid size-4 shrink-0 place-items-center rounded-[5px]',
                        selected
                          ? 'bg-primary text-primary-foreground'
                          : 'shadow-[inset_0_0_0_1.5px_var(--control)]'
                      )}
                    >
                      {selected && <Check className="size-3" strokeWidth={3} />}
                    </span>
                  </button>
                )

                return (
                  <div
                    key={iface.id}
                    className={cn(
                      'flex h-9 max-w-full items-center gap-0.5 rounded-full pr-1.5 text-[13px] transition-colors duration-100 has-[button[aria-pressed]:focus-visible]:outline-2 has-[button[aria-pressed]:focus-visible]:outline-offset-2 has-[button[aria-pressed]:focus-visible]:outline-ring',
                      selected
                        ? 'bg-selected shadow-[inset_0_0_0_1px_var(--border-strong)]'
                        : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover',
                      reached && 'opacity-50'
                    )}
                  >
                    {note === null ? (
                      toggleButton
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={toggleButton} />
                        <TooltipContent>{note}</TooltipContent>
                      </Tooltip>
                    )}

                    <NetworkEditPopover
                      interfaceId={iface.id}
                      interfaceKind={iface.kind}
                      osName={iface.displayName}
                      defaultFocusProxy={true}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={
                            isProxyActive
                              ? `Configure proxy (${proxy!.type.toUpperCase()}) or edit ${visual.name}`
                              : `Configure proxy or edit ${visual.name}`
                          }
                          className={cn(
                            'h-6 shrink-0 gap-1 rounded-full px-2 text-[11.5px]',
                            isProxyActive && 'bg-sunken font-[620] text-foreground'
                          )}
                        >
                          <Pencil aria-hidden className="size-3" />
                          {isProxyActive ? `Proxy, ${proxy!.type.toUpperCase()}` : 'Proxy'}
                        </Button>
                      }
                      tooltip={
                        isProxyActive
                          ? `Proxy on (${proxy!.type.toUpperCase()}, ${proxy!.host}:${proxy!.port}). Click to change it.`
                          : `Configure proxy or edit ${visual.name}`
                      }
                    />
                  </div>
                )
              })}
            </div>
            {subnetConflict && (
              <Note tone="warning">
                {subnetConflict.names.join(' and ')} share a subnet ({subnetConflict.subnet}), so
                the computer sends both down one route and they can’t be combined.
              </Note>
            )}
            {usedUpPick.length > 0 && (
              <Note tone="warning">
                {usedUpPick
                  .map((iface) => networkVisual(iface.id, iface.kind, iface.displayName).name)
                  .join(' and ')}{' '}
                {usedUpPick.length === 1 ? 'has' : 'have'} reached{' '}
                {usedUpPick.length === 1 ? 'its' : 'their'} data limit. Choose another network for
                this download.
              </Note>
            )}
            {interfaces.length > 0 && availableIds.length === 0 && (
              <Note tone="warning">
                Every network has reached its data limit. Raise one in Speed &amp; data limits.
              </Note>
            )}
            {isSingleStreamOnly && selectedInterfaceIds.length === 1 && interfaces.length > 1 && (
              <p className="text-[12px] text-ink-3">
                This download uses one connection on one network.
              </p>
            )}
          </div>
        </div>

        {/* A torrent's speed comes from its peers, an NZB's connections are the server's, a
            video's segment requests are shared out by the app, and an unsplittable file has one
            stream. */}
        {ready && !torrent && !nzb && !stream && !isSingleStreamOnly && (
          <div className={ROW}>
            <span className={FIELD_LABEL} id="new-download-streams">
              Streams
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                value={[String(streamsChoice)]}
                onValueChange={(values) => {
                  if (values.length === 0) return
                  setStreamsChoice(values[0] === 'auto' ? 'auto' : Number(values[0]))
                }}
                aria-labelledby="new-download-streams"
              >
                {STREAMS_CHOICES.map((choice) => (
                  <ToggleGroupItem key={choice} value={String(choice)}>
                    {choice === 'auto' ? 'Auto' : choice}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="text-[12px] text-ink-3">per network</span>
            </div>
          </div>
        )}

        <div className={ROW}>
          <span className={FIELD_LABEL}>Save to</span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <HardDrive aria-hidden className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 truncate font-mono text-[12.5px]">
                {toDisplayPath(destinationDir, homeDir)}
              </span>
              {availableFreeSpace !== null && (
                <span
                  className={cn(
                    'figures shrink-0 text-[12px]',
                    hasInsufficientSpace ? 'font-[620] text-destructive' : 'text-ink-3'
                  )}
                >
                  ({formatBytes(availableFreeSpace)} free)
                </span>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="ml-auto"
                onClick={handleBrowse}
              >
                Change
              </Button>
            </div>
            {hasInsufficientSpace && (
              <Note tone="danger" alert>
                Not enough disk space: this download needs {formatBytes(sizeToFetch)}, but only{' '}
                {formatBytes(availableFreeSpace)} is free on this drive.
              </Note>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-rule bg-popover px-5 py-3">
        {startError ? (
          <p role="alert" className="min-w-0 flex-1 truncate text-[12.5px] text-destructive">
            {startError}
          </p>
        ) : (
          <div className="flex-1" />
        )}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canStart}>
          {startLabel}
        </Button>
      </div>
      {/* Its form keeps its submit to itself: a portal's events still bubble up the React tree. */}
      <UsenetServerDialog
        open={serverOpen}
        server={server ?? null}
        onOpenChange={setServerOpen}
        onSaved={setServer}
      />
    </form>
  )
}

/** A warning or a problem under a field, said beside an icon. */
function Note({
  tone,
  alert = false,
  children
}: {
  tone: 'warning' | 'danger'
  alert?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      role={alert ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-1.5 text-[12px] leading-snug',
        tone === 'danger' ? 'text-destructive' : 'text-[var(--color-warning)]'
      )}
    >
      <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}
