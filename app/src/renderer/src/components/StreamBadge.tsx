import type { StreamProtocol } from '@shared/types'
import { Badge } from './ui/badge'

/** Next to an HLS or DASH video's name, wherever it's listed, as TorrentBadge is beside a
 * torrent's: its file is put together from the stream's segments. */
export function StreamBadge({ protocol }: { protocol: StreamProtocol }): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className="h-4 shrink-0 rounded-[3.5px] px-[6px] font-mono text-[9.5px] leading-none font-semibold tracking-[0.08em] whitespace-nowrap text-muted-foreground"
    >
      {protocol === 'hls' ? 'HLS' : 'DASH'}
    </Badge>
  )
}
