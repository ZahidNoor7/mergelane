import { fileTypeOf } from '@shared/downloadFilters'
import type { DownloadState, FinishedDownload, StreamProtocol } from '@shared/types'
import { Film, Folder, Magnet, Newspaper } from 'lucide-react'
import { isFolder } from '../utils/format'
import { FILE_TYPE_ICON } from './fileTypeIcons'
import { Badge } from './ui/badge'

// A download's file icon and its kind tags, as the final design draws them beside its name
// (design-system/mergelane/redesign/prototype.html, FileGlyph and KindTags).

type Item = DownloadState | FinishedDownload

/** The kind of file a download makes, as an icon on a sunken tile. Decorative: its name is beside it. */
export function FileGlyph({ item, size = 34 }: { item: Item; size?: number }): React.JSX.Element {
  const Icon = isFolder(item) ? Folder : FILE_TYPE_ICON[fileTypeOf(item)]
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] bg-sunken text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]"
      style={{ width: size, height: size }}
    >
      <Icon className="size-[48%]" strokeWidth={1.75} />
    </span>
  )
}

const STREAM_LABEL: Readonly<Record<StreamProtocol, string>> = {
  hls: 'HLS',
  dash: 'DASH',
  youtube: 'YouTube'
}

/** Where a download comes from, when its name doesn't say: a torrent, Usenet, or a video stream.
 * Nothing for an ordinary link. */
export function KindTags({ item }: { item: Item }): React.JSX.Element | null {
  if (item.kind === 'torrent') {
    return (
      <Badge>
        <Magnet aria-hidden />
        Torrent
      </Badge>
    )
  }
  if (item.kind === 'nzb') {
    return (
      <Badge>
        <Newspaper aria-hidden />
        Usenet
      </Badge>
    )
  }
  if (item.kind === 'stream') {
    return (
      <Badge>
        <Film aria-hidden />
        {STREAM_LABEL[item.protocol]}
      </Badge>
    )
  }
  return null
}
