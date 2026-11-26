import type { TorrentFileEntry, TorrentInfo, TorrentPieceState } from '@shared/types'
import { baseName, chosenBytes, fileGroups, isVideo, videosOnly } from '@shared/torrentTree'
import { cn } from 'cn'
import { File, Folder } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { describeError, formatBytes, formatPercent } from '../utils/format'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'

/** Bytes of each file that are in verified pieces. Files and pieces both run in byte order, so
 * one pass over each. */
function verifiedBytes(files: TorrentFileEntry[], pieces: TorrentPieceState[]): number[] {
  // Exclusive. A piece's rangeEnd is never null: that's for HTTP downloads of unknown size.
  const endOf = (piece: TorrentPieceState): number => (piece.rangeEnd ?? piece.rangeStart) + 1
  let start = 0
  let first = 0
  return files.map((file) => {
    const end = start + file.length
    while (first < pieces.length && endOf(pieces[first]) <= start) first++
    let done = 0
    for (let at = first; at < pieces.length && pieces[at].rangeStart < end; at++) {
      const piece = pieces[at]
      if (piece.status === 'completed') {
        done += Math.min(end, endOf(piece)) - Math.max(start, piece.rangeStart)
      }
    }
    start = end
    return done
  })
}

/**
 * A torrent's files, each ticked to be downloaded (the design's TorrentFiles): "All files" with how
 * many are chosen and their size as it changes, Videos only, then the files at the top of the
 * torrent and each folder inside it, a folder's tick ticking its files. Given `done` (each file's
 * bytes in), each shows how far it is, and one all in stays ticked: it's downloaded.
 */
export function TorrentFileList({
  files,
  skipped,
  onChange,
  done
}: {
  files: TorrentInfo['files']
  skipped: number[]
  onChange: (skipped: number[]) => void
  done?: number[]
}): React.JSX.Element {
  const paths = files.map((file) => file.path)
  const finished = (index: number): boolean =>
    done !== undefined && done[index] >= files[index].length
  const groups = fileGroups(paths)
  const chosen = files.length - skipped.length
  const someVideos = paths.some(isVideo)
  const someOthers = paths.some((path) => !isVideo(path))
  /** Ticks or unticks a set of files; unticking leaves the downloaded ones, which are in. */
  const set = (indices: readonly number[], on: boolean): void =>
    onChange(
      on
        ? skipped.filter((index) => !indices.includes(index))
        : [...new Set([...skipped, ...indices.filter((index) => !finished(index))])].sort(
            (a, b) => a - b
          )
    )
  const tick = (indices: readonly number[]): { checked: boolean; indeterminate: boolean } => {
    const off = indices.filter((index) => skipped.includes(index)).length
    return { checked: off === 0, indeterminate: off > 0 && off < indices.length }
  }
  const everything = files.map((_, index) => index)

  return (
    <div
      role="group"
      aria-label="Files"
      className="flex flex-col rounded-[12px] shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule px-3 py-2">
        <label className="flex items-center gap-2 text-[12.5px] font-[620]">
          <Checkbox {...tick(everything)} onCheckedChange={(on) => set(everything, on)} />
          All files
        </label>
        <span aria-live="polite" className="figures text-[12px] text-ink-2">
          {chosen} of {files.length} {files.length === 1 ? 'file' : 'files'},{' '}
          {formatBytes(
            chosenBytes(
              files.map((file) => file.length),
              skipped
            )
          )}
        </span>
        {someVideos && someOthers && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => onChange(videosOnly(paths, finished))}
          >
            Videos only
          </Button>
        )}
      </div>
      <ul
        className="flex max-h-[220px] flex-col overflow-y-auto py-1"
        aria-label="Files in this torrent"
      >
        {groups.map(({ folder, indices }) => (
          <Fragment key={folder || 'top'}>
            {folder && (
              <li>
                <label className="flex items-center gap-2 px-3 py-1 text-[12.5px] font-[600] text-ink-2">
                  <Checkbox
                    {...tick(indices)}
                    aria-label={`Folder ${folder}`}
                    onCheckedChange={(on) => set(indices, on)}
                  />
                  <Folder aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{folder}</span>
                </label>
              </li>
            )}
            {indices.map((index) => {
              const file = files[index]
              const on = !skipped.includes(index)
              const progress = done ? formatPercent(done[index], file.length) : null
              return (
                <li key={index}>
                  <label
                    className={cn(
                      'grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 py-1 pr-3 text-[12.5px]',
                      folder ? 'pl-8' : 'pl-3',
                      !on && 'text-ink-3'
                    )}
                  >
                    <Checkbox
                      checked={on}
                      aria-label={baseName(file.path)}
                      disabled={finished(index)}
                      onCheckedChange={(checked) => set([index], checked)}
                    />
                    <File aria-hidden className="size-3.5 text-ink-3" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{baseName(file.path)}</span>
                      {progress !== null && on && (
                        <span
                          aria-hidden
                          className="mt-0.5 h-1 overflow-hidden rounded-full bg-track"
                        >
                          <span
                            className="block h-full rounded-full bg-[var(--color-accent)]"
                            style={{ width: `${progress}%` }}
                          />
                        </span>
                      )}
                    </span>
                    <span className="figures text-right text-ink-2">
                      {!on
                        ? 'Skipped'
                        : progress === null
                          ? formatBytes(file.length)
                          : finished(index)
                            ? 'Done'
                            : `${progress}%`}
                    </span>
                  </label>
                </li>
              )
            })}
          </Fragment>
        ))}
      </ul>
      {chosen === 0 && (
        <p role="alert" className="border-t border-rule px-3 py-2 text-[12px] text-destructive">
          Choose at least one file.
        </p>
      )}
    </div>
  )
}

/** A torrent download's files once it has started: how far each is, and which to fetch, changed
 * as it runs. The choice is main's, `selected` as its state has it (unset: every file): a change
 * is asked for, and shows once the state it's sent back has it. */
export function TorrentFiles({
  downloadId,
  pieces,
  selected
}: {
  downloadId: string
  pieces: TorrentPieceState[]
  selected: number[] | undefined
}): React.JSX.Element | null {
  const [files, setFiles] = useState<TorrentFileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void window.mergelane.torrentFiles(downloadId).then((entries) => {
      if (!stale) setFiles(entries)
    })
    return () => {
      stale = true
    }
  }, [downloadId])

  if (!files) return null
  const skipped = selected
    ? files.flatMap((_, index) => (selected.includes(index) ? [] : [index]))
    : []
  const choose = (next: number[]): void => {
    if (next.length === files.length) {
      setError('Choose at least one file.')
      return
    }
    setError(null)
    const chosen = files.flatMap((_, index) => (next.includes(index) ? [] : [index]))
    window.mergelane
      .chooseTorrentFiles(downloadId, chosen)
      .catch((cause) => setError(describeError(cause)))
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <TorrentFileList
        files={files}
        skipped={skipped}
        onChange={choose}
        done={verifiedBytes(files, pieces)}
      />
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      <p className="text-[12px] leading-snug text-ink-3">
        A skipped file isn’t downloaded. Pieces it shares with a chosen file are, so a few MB of it
        can appear until the torrent finishes.
      </p>
    </div>
  )
}
